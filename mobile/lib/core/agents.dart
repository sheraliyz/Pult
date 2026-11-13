// AI coding agents on the server: Claude Code (`claude`) and the Antigravity
// CLI (`agy`). Same design and the same server files as the desktop app
// (src/main/agents.js) — keep the scripts below in sync with it:
//
//  * Claude Code hands its status line command a JSON with `rate_limits`
//    (5-hour and weekly windows). With the user's consent Pult points the
//    status line at ~/.pult/bin/claude-statusline, which saves a copy to
//    ~/.pult/state and then runs the user's own status line, if any.
//  * agy reports its quota through `agy -p /usage --output-format json`.
//
// Panes and state files come through the connection's monitor channel.

import 'dart:async';
import 'dart:convert';

import 'package:dartssh2/dartssh2.dart';
import 'package:flutter/foundation.dart';

import 'connection.dart';
import 'format.dart';

enum Agent { claude, agy }

const bridgeVersion = 1;
const bridgeCommand = 'sh ~/.pult/bin/claude-statusline';

const _detectScript = 'P="\$HOME/.local/bin:\$HOME/bin:\$HOME/.claude/local:\$HOME/.npm-global/bin:\$HOME/.bun/bin:\$HOME/.volta/bin:/usr/local/bin:/opt/homebrew/bin"; '
    'for x in "\$HOME"/.nvm/versions/node/*/bin; do [ -d "\$x" ] && P="\$P:\$x"; done; '
    'export PATH="\$P:\$PATH"; '
    'echo "C \$(command -v claude 2>/dev/null)"; '
    'echo "A \$(command -v agy 2>/dev/null)"; '
    "if grep -q 'pult/bin/claude-statusline' \"\$HOME/.claude/settings.json\" 2>/dev/null; then echo \"B 1\"; else echo \"B 0\"; fi; "
    r"sed -n 's/^# pult-bridge v\([0-9][0-9]*\).*/V \1/p' " '"\$HOME/.pult/bin/claude-statusline" 2>/dev/null; '
    "find \"\$HOME/.pult/state\" -name 'claude.*.json' -mtime +14 -exec rm -f {} + 2>/dev/null; "
    'true';

/// Claude Code's status line on the server (POSIX sh, no jq). Byte for byte
/// the script the desktop app installs.
const bridgeScript = r'''#!/bin/sh
# pult-bridge v1
# Pult: Claude Code status line (https://github.com/sheraliyz/pult)
# Claude Code passes session JSON on stdin. A copy goes to ~/.pult/state so
# Pult can show the plan's usage limits (5-hour and weekly windows). Then your
# own status line runs (if you had one), or a short default line is printed.
# To undo: Pult -> status bar -> Claude -> "Uzish" (restores your settings).
in=$(cat | tr -d '\r\n')
d="$HOME/.pult/state"
k=claude
if [ -n "$TMUX" ]; then
  s=$(tmux display-message -p ${TMUX_PANE:+-t "$TMUX_PANE"} '#{session_name}' 2>/dev/null | tr -c '\nA-Za-z0-9_.-' '_')
  [ -n "$s" ] && k="claude.$s"
fi
if mkdir -p "$d" 2>/dev/null; then
  printf '{"t":%s,"d":%s}\n' "$(date +%s)" "${in:-null}" > "$d/$k.json.$$" 2>/dev/null &&
    mv -f "$d/$k.json.$$" "$d/$k.json" 2>/dev/null
fi
n="$HOME/.pult/claude-statusline.next"
if [ -s "$n" ]; then
  printf '%s\n' "$in" | sh -c "$(cat "$n")"
  exit
fi
num() { printf '%s' "$in" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*{[^}]*\"$2\"[[:space:]]*:[[:space:]]*\\([0-9][0-9.]*\\).*/\\1/p"; }
hm() { date -d "@$1" +%H:%M 2>/dev/null || date -r "$1" +%H:%M 2>/dev/null; }
o=$(printf '%s' "$in" | sed -n 's/.*"model"[[:space:]]*:[[:space:]]*{[^}]*"display_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
c=$(printf '%s' "$in" | sed -n 's/.*"remaining_percentage"[[:space:]]*:[[:space:]]*\([0-9][0-9.]*\).*/\1/p')
[ -n "$c" ] && o="${o:+$o · }kontekst $((100 - ${c%%.*}))%"
f=$(num five_hour used_percentage)
r=$(num five_hour resets_at)
[ -n "$r" ] && r=$(hm "${r%%.*}")
[ -n "$f" ] && o="${o:+$o · }5 soat ${f%%.*}%${r:+ ($r gacha)}"
w=$(num seven_day used_percentage)
[ -n "$w" ] && o="${o:+$o · }hafta ${w%%.*}%"
printf '%s\n' "$o"
''';

const _rel = (
  script: '.pult/bin/claude-statusline',
  next: '.pult/claude-statusline.next',
  meta: '.pult/claude-bridge.json',
  state: '.pult/state',
  uploads: '.pult/uploads',
  settings: '.claude/settings.json',
  backup: '.claude/settings.json.pult-backup',
);

/* ---------------- data ---------------- */

/// One usage window. [used] is 0..1; [resetAt] is epoch ms.
class UsageWindow {
  const UsageWindow(this.used, this.resetAt, {this.wasReset = false});
  final double used;
  final int? resetAt;
  final bool wasReset;

  /// Once its reset time has passed the window starts again from zero.
  UsageWindow get now {
    final r = resetAt;
    if (r != null && r <= nowMs()) return const UsageWindow(0, null, wasReset: true);
    return this;
  }
}

class ClaudeSnapshot {
  const ClaudeSnapshot({required this.t, this.session, this.model, this.ctx, this.cost, this.five, this.week, this.spend});
  final int t; // epoch ms, when the status line ran
  final String? session, model;
  final double? ctx, cost;
  final UsageWindow? five, week, spend;
  bool get hasLimits => five != null || week != null || spend != null;
}

class AgyBucket {
  const AgyBucket(this.window, this.usage);
  final String window; // '5h' | 'week' | 'day' | other
  final UsageWindow usage;
}

class AgyGroup {
  const AgyGroup(this.name, this.buckets);
  final String name;
  final List<AgyBucket> buckets;
}

class AgentError {
  const AgentError(this.code, this.message);
  final String code, message;
}

class PaneAgent {
  const PaneAgent(this.agent, this.command, this.cwd, this.title);
  final Agent? agent;
  final String command, cwd, title;
}

/* ---------------- parsing ---------------- */

double? _num(Object? v) {
  if (v is num) return v.isFinite ? v.toDouble() : null;
  if (v is String && v.trim().isNotEmpty) return double.tryParse(v);
  return null;
}

/// Which agent a tmux pane is running, from its foreground command and title.
Agent? agentOf(String command, String title) {
  final cmd = command.toLowerCase();
  if (cmd == 'claude' || cmd.startsWith('claude-') || RegExp(r'^\d+\.\d+\.\d+$').hasMatch(cmd)) return Agent.claude;
  if (cmd == 'agy' || cmd.startsWith('antigravity')) return Agent.agy;
  if (cmd == 'node' || cmd == 'bun') {
    if (RegExp('claude code', caseSensitive: false).hasMatch(title) || RegExp('^[\u2733\u273b\u273d\u2736\u2722\u00b7\u25d0\u25d1\u2800-\u28ff] ').hasMatch(title)) return Agent.claude;
    if (RegExp(r'antigravity|\bagy\b', caseSensitive: false).hasMatch(title)) return Agent.agy;
  }
  return null;
}

/// "✳ Refactor auth" → "Refactor auth".
String cleanTitle(String t) => t.replaceFirst(RegExp(r'^[^\p{L}\p{N}(\["`]+', unicode: true), '').trim();

/// A snapshot the bridge script wrote: `{"t": <epoch s>, "d": <Claude Code JSON>}`.
ClaudeSnapshot? parseClaudeSnapshot(String text, String file) {
  Object? o;
  try {
    o = jsonDecode(text.trim());
  } catch (_) {
    return null;
  }
  if (o is! Map) return null;
  final d = o['d'] is Map ? o['d'] as Map : o;
  UsageWindow? win(Object? w) {
    if (w is! Map) return null;
    final pct = _num(w['used_percentage']);
    if (pct == null) return null;
    final r = _num(w['resets_at']);
    return UsageWindow((pct / 100).clamp(0, 1).toDouble(), r == null || r == 0 ? null : (r * 1000).round());
  }

  final rl = d['rate_limits'] is Map ? d['rate_limits'] as Map : const {};
  final model = d['model'] is Map ? d['model'] as Map : const {};
  final cw = d['context_window'] is Map ? d['context_window'] as Map : const {};
  final cost = d['cost'] is Map ? d['cost'] as Map : const {};
  final t = _num(o['t']);
  final name = file.split('/').last;
  return ClaudeSnapshot(
    t: t == null ? 0 : (t * 1000).round(),
    session: RegExp(r'^claude\.(.+)\.json$').firstMatch(name)?.group(1),
    model: (model['display_name'] ?? model['id']) as String?,
    ctx: _num(cw['used_percentage']),
    cost: _num(cost['total_cost_usd']),
    five: win(rl['five_hour']),
    week: win(rl['seven_day']),
    spend: win(rl['spend_limit']),
  );
}

String _windowOf(Object? s) {
  final v = '${s ?? ''}'.toLowerCase();
  if (RegExp(r'5\s*h|five|hour').hasMatch(v)) return '5h';
  if (RegExp(r'week|7\s*d|seven').hasMatch(v)) return 'week';
  if (RegExp(r'day|24\s*h').hasMatch(v)) return 'day';
  return v.isEmpty ? '?' : v;
}

/// `agy -p /usage --output-format json` → model groups with their windows.
List<AgyGroup>? parseAgyUsage(String stdout) {
  Object? obj;
  final text = stdout.trim();
  try {
    obj = jsonDecode(text);
  } catch (_) {
    // Some builds print log lines first: take the last line that is JSON.
    for (final line in text.split('\n').reversed) {
      final l = line.trim();
      if (!l.startsWith('{')) continue;
      try {
        obj = jsonDecode(l);
        break;
      } catch (_) {}
    }
  }
  Object? groups;
  if (obj is Map) {
    final cmd = obj['command'];
    groups = (cmd is Map && cmd['data'] is Map ? (cmd['data'] as Map)['groups'] : null) ?? (obj['data'] is Map ? (obj['data'] as Map)['groups'] : null) ?? obj['groups'];
  }
  if (groups is! List) return null;
  final out = <AgyGroup>[];
  for (final g in groups) {
    if (g is! Map) continue;
    final buckets = <AgyBucket>[];
    for (final b in g['buckets'] is List ? g['buckets'] as List : const []) {
      if (b is! Map) continue;
      var remaining = _num(b['remaining_fraction']);
      if (remaining == null && _num(b['remaining_pct']) != null) remaining = _num(b['remaining_pct'])! / 100;
      if (remaining == null) continue;
      final used = (1 - remaining).clamp(0, 1).toDouble();
      int? reset = b['reset_time'] is String ? DateTime.tryParse(b['reset_time'] as String)?.millisecondsSinceEpoch : null;
      final inSec = _num(b['reset_in_seconds']);
      if (reset == null && inSec != null) reset = nowMs() + (inSec * 1000).round();
      // An untouched window has a rolling reset time that means nothing.
      buckets.add(AgyBucket(_windowOf(b['window'] ?? b['id'] ?? b['name']), UsageWindow(used, used > 0 ? reset : null)));
    }
    if (buckets.isNotEmpty) out.add(AgyGroup('${g['name'] ?? g['display_name'] ?? g['id'] ?? 'agy'}', buckets));
  }
  return out.isEmpty ? null : out;
}

AgentError _agyFailure(ExecResult r) {
  final all = '${r.stdout}\n${r.stderr}';
  if (RegExp(r'auth|sign.?in|log.?in|credential|unauthori[sz]ed', caseSensitive: false).hasMatch(all)) {
    return const AgentError('AUTH', 'agy’ga kirilmagan — terminalda `agy` ni bir marta ishga tushirib, hisobingizga kiring');
  }
  if (r.code == 127) return const AgentError('NO_TOOL', 'agy topilmadi');
  final lines = all.split('\n').map((l) => l.trim()).where((l) => l.isNotEmpty).toList();
  return AgentError('FAILED', lines.isEmpty ? 'agy /usage ishlamadi (kod ${r.code})' : lines.last.substring(0, lines.last.length.clamp(0, 200)));
}

Map<String, dynamic> parseSettings(String? text) {
  if (text == null || text.trim().isEmpty) return {};
  Object? v;
  try {
    v = jsonDecode(text);
  } catch (e) {
    throw ConnError('BAD_SETTINGS', '~/.claude/settings.json o‘qib bo‘lmadi (JSON xato). Fayl o‘zgartirilmadi.');
  }
  if (v is! Map<String, dynamic>) throw ConnError('BAD_SETTINGS', '~/.claude/settings.json kutilgan ko‘rinishda emas. Fayl o‘zgartirilmadi.');
  return v;
}

bool _isBridge(Object? cmd) => cmd is String && cmd.contains('pult/bin/claude-statusline');

String _stamp([DateTime? at]) {
  final d = at ?? DateTime.now();
  String p(int n) => n.toString().padLeft(2, '0');
  return '${d.year}${p(d.month)}${p(d.day)}-${p(d.hour)}${p(d.minute)}${p(d.second)}';
}

/* ---------------- SFTP helpers ---------------- */

Future<String?> _readText(SftpClient sftp, String p) async {
  try {
    final f = await sftp.open(p);
    try {
      return utf8.decode(await f.readBytes(), allowMalformed: true);
    } finally {
      await f.close();
    }
  } on SftpStatusError catch (e) {
    if (e.code == SftpStatusCode.noSuchFile) return null;
    rethrow;
  }
}

Future<SftpFileAttrs?> _stat(SftpClient sftp, String p) async {
  try {
    return await sftp.stat(p);
  } catch (_) {
    return null;
  }
}

Future<void> _mkdirp(SftpClient sftp, String dir) async {
  if (await _stat(sftp, dir) != null) return;
  await _mkdirp(sftp, pDirname(dir));
  try {
    await sftp.mkdir(dir);
  } catch (_) {
    if (await _stat(sftp, dir) == null) rethrow;
  }
}

Future<void> _writeFile(SftpClient sftp, String p, List<int> data, {int mode = 0x1A4 /* 0644 */}) async {
  final f = await sftp.open(p, mode: SftpFileOpenMode.create | SftpFileOpenMode.write | SftpFileOpenMode.truncate);
  try {
    await f.writeBytes(Uint8List.fromList(data));
  } finally {
    await f.close();
  }
  try {
    await sftp.setStat(p, SftpFileAttrs(mode: SftpFileMode.value(mode)));
  } catch (_) {}
}

// Write a sibling, then swap it in, so a reader never sees half a file.
Future<void> _writeAtomic(SftpClient sftp, String p, String text, int mode) async {
  final tmp = '$p.pult-tmp';
  await _writeFile(sftp, tmp, utf8.encode(text), mode: mode);
  try {
    await sftp.rename(tmp, p); // posix-rename when the server has it
    return;
  } catch (_) {
    // Plain SFTP rename refuses to overwrite.
  }
  try {
    await sftp.remove(p);
  } catch (_) {}
  await sftp.rename(tmp, p);
}

/* ---------------- watcher ---------------- */

class Agents extends ChangeNotifier {
  Agents(this.conn) {
    conn.agentPolling = true;
    conn.onAgentScan = (panes, files) => _scan(panes, files);
    conn.addListener(_onConn);
    _onConn();
  }

  final Connection conn;

  bool detected = false;
  String? claudePath, agyPath;
  bool bridged = false;
  int bridgeScriptVersion = 0;
  Map<String, PaneAgent> panes = const {};
  final _snaps = <String, ({String sum, ClaudeSnapshot snap})>{};

  List<AgyGroup>? agyUsage;
  int agyAt = 0;
  AgentError? agyError;
  bool agyBusy = false;
  bool _noLogFlag = false;
  Future<void>? _agyRun;
  Timer? _agyTimer;

  bool _scanning = false;
  ConnState _last = ConnState.connecting;
  bool _disposed = false;

  /// Claude Code snapshots per Pult terminal (tmux session name).
  Map<String, ClaudeSnapshot> get claudeSessions => {
        for (final e in _snaps.values)
          if (e.snap.session != null) e.snap.session!: e.snap,
      };

  /// The freshest snapshot that carries the plan's limits.
  ClaudeSnapshot? get claudeUsage {
    ClaudeSnapshot? best;
    for (final e in _snaps.values) {
      if (e.snap.hasLimits && (best == null || e.snap.t > best.t)) best = e.snap;
    }
    return best;
  }

  bool get claudeSeen => _snaps.isNotEmpty;

  /// Screenshots and tests: a snapshot as if the status line had just run.
  @visibleForTesting
  void debugAddSnapshot(String file, ClaudeSnapshot snap) {
    _snaps[file] = (sum: 'test', snap: snap);
    _changed();
  }

  bool has(Agent a) => (a == Agent.claude ? claudePath != null : agyPath != null) || panes.values.any((p) => p.agent == a);
  bool get any => has(Agent.claude) || has(Agent.agy) || bridged;

  void _changed() {
    if (!_disposed) notifyListeners();
  }

  void _onConn() {
    final s = conn.state;
    if (s == ConnState.ready && _last != ConnState.ready) detect();
    if (s != ConnState.ready) _agyTimer?.cancel();
    _last = s;
  }

  Future<String> _home() async => conn.home ?? await (await conn.sftp()).absolute('.');

  /* ---------------- detection ---------------- */

  Future<void> detect() async {
    final ExecResult r;
    try {
      r = await conn.exec(_detectScript);
    } catch (_) {
      return;
    }
    String? val(String k) {
      for (final l in r.stdout.split('\n')) {
        if (l.startsWith('$k ')) {
          final v = l.substring(2).trim();
          return v.isEmpty ? null : v;
        }
      }
      return null;
    }

    claudePath = val('C');
    agyPath = val('A');
    bridged = val('B') == '1';
    bridgeScriptVersion = int.tryParse(val('V') ?? '') ?? 0;
    detected = true;
    _changed();
    if (bridged && bridgeScriptVersion != 0 && bridgeScriptVersion != bridgeVersion) {
      unawaited(_updateScript().catchError((_) {}));
    }
    if (agyPath != null && nowMs() - agyAt > 3 * 60000) {
      unawaited(refreshAgy());
    } else {
      _scheduleAgy();
    }
  }

  /* ---------------- polling ---------------- */

  Future<void> _scan(List<PaneInfo> list, List<StateFile> files) async {
    if (_scanning || _disposed) return;
    _scanning = true;
    try {
      var dirty = false;
      final next = <String, PaneAgent>{
        for (final p in list)
          if (RegExp(r'^pult-\d{4}$').hasMatch(p.session)) p.session: PaneAgent(agentOf(p.command, p.title), p.command, p.cwd, p.title),
      };
      if (!_samePanes(next, panes)) {
        final hadAgy = panes.values.any((p) => p.agent == Agent.agy);
        final hasAgy = next.values.any((p) => p.agent == Agent.agy);
        panes = next;
        dirty = true;
        if (hadAgy && !hasAgy && agyPath != null) Timer(const Duration(seconds: 4), refreshAgy);
      }
      final seen = <String>{};
      for (final f in files) {
        final name = f.path.split('/').last;
        if (!RegExp(r'^claude[.\w-]*\.json$').hasMatch(name)) continue;
        seen.add(name);
        if (_snaps[name]?.sum == f.sum) continue;
        final text = await conn.monitorFetch(f.path);
        if (text == null) continue;
        final snap = parseClaudeSnapshot(text, name);
        if (snap == null) continue;
        _snaps[name] = (sum: f.sum, snap: snap);
        dirty = true;
      }
      final gone = _snaps.keys.where((k) => !seen.contains(k)).toList();
      for (final k in gone) {
        _snaps.remove(k);
        dirty = true;
      }
      if (dirty) _changed();
    } finally {
      _scanning = false;
    }
  }

  static bool _samePanes(Map<String, PaneAgent> a, Map<String, PaneAgent> b) {
    if (a.length != b.length) return false;
    for (final e in a.entries) {
      final o = b[e.key];
      if (o == null || o.agent != e.value.agent || o.title != e.value.title || o.cwd != e.value.cwd || o.command != e.value.command) return false;
    }
    return true;
  }

  /* ---------------- agy ---------------- */

  void _scheduleAgy() {
    _agyTimer?.cancel();
    if (agyPath == null || !conn.isReady || _disposed) return;
    final active = panes.values.any((p) => p.agent == Agent.agy);
    final minutes = agyError != null ? 15 : active ? 3 : 10;
    _agyTimer = Timer(Duration(minutes: minutes), refreshAgy);
  }

  /// Ask agy for its quota; a call while one is running waits for that one.
  Future<void> refreshAgy() {
    final running = _agyRun;
    if (running != null) return running;
    if (agyPath == null || !conn.isReady) return Future.value();
    final run = _runAgy().whenComplete(() => _agyRun = null);
    _agyRun = run;
    return run;
  }

  Future<void> _runAgy() async {
    agyBusy = true;
    _changed();
    try {
      Future<ExecResult> run(bool logFlag) =>
          conn.exec('${shq(agyPath!)} -p /usage --output-format json${logFlag ? ' --log-file /dev/null' : ''} < /dev/null', const Duration(seconds: 90));
      var r = await run(!_noLogFlag);
      var usage = r.code == 0 ? parseAgyUsage(r.stdout) : null;
      if (usage == null && !_noLogFlag && _agyFailure(r).code == 'FAILED') {
        // Older builds may not know --log-file.
        final r2 = await run(false);
        final u2 = r2.code == 0 ? parseAgyUsage(r2.stdout) : null;
        if (u2 != null) _noLogFlag = true;
        r = r2;
        usage = u2;
      }
      if (usage != null) {
        agyUsage = usage;
        agyError = null;
      } else {
        agyError = r.code == 0 ? const AgentError('FORMAT', 'agy /usage javobini tushunib bo‘lmadi (agy yangilanganmi?)') : _agyFailure(r);
      }
    } catch (e) {
      agyError = AgentError('FAILED', '$e');
    } finally {
      agyBusy = false;
      agyAt = nowMs();
      _scheduleAgy();
      _changed();
    }
  }

  /* ---------------- Claude status line bridge ---------------- */

  Future<void> _updateScript() async {
    final sftp = await conn.sftp();
    final home = await _home();
    await _mkdirp(sftp, '$home/.pult/bin');
    await _writeFile(sftp, '$home/${_rel.script}', utf8.encode(bridgeScript), mode: 0x1ED /* 0755 */);
    bridgeScriptVersion = bridgeVersion;
    _changed();
  }

  Future<void> installClaude() async {
    final sftp = await conn.sftp();
    final home = await _home();
    String p(String rel) => '$home/$rel';

    // Read and validate first: a settings file we cannot parse stays as is.
    final settingsPath = p(_rel.settings);
    final original = await _readText(sftp, settingsPath);
    final settings = parseSettings(original);
    final st = original != null ? await _stat(sftp, settingsPath) : null;
    final mode = (st?.mode?.value ?? 0x1A4) & 0x1FF;
    Map<String, dynamic> meta = {};
    try {
      final m = jsonDecode(await _readText(sftp, p(_rel.meta)) ?? '{}');
      if (m is Map<String, dynamic>) meta = m;
    } catch (_) {}

    await _mkdirp(sftp, p('.pult/bin'));
    await _mkdirp(sftp, p(_rel.state));
    await _mkdirp(sftp, p('.claude'));
    await _writeFile(sftp, p(_rel.script), utf8.encode(bridgeScript), mode: 0x1ED);

    final cur = settings['statusLine'];
    if (!_isBridge(cur is Map ? cur['command'] : null)) {
      // Keep the user's own status line: it keeps running, chained after ours.
      meta['prevStatusLine'] = cur is Map ? cur : null;
      final prevCmd = cur is Map && cur['command'] is String ? (cur['command'] as String).trim() : '';
      if (prevCmd.isNotEmpty) {
        await _writeFile(sftp, p(_rel.next), utf8.encode('$prevCmd\n'), mode: 0x180 /* 0600 */);
      } else {
        try {
          await sftp.remove(p(_rel.next));
        } catch (_) {}
      }
    }
    settings['statusLine'] = {if (cur is Map) ...cur.cast<String, dynamic>(), 'type': 'command', 'command': bridgeCommand};
    if (!settings.containsKey('preferredNotifChannel')) {
      settings['preferredNotifChannel'] = 'terminal_bell';
      meta['notifChannel'] = true;
    }
    meta['v'] = bridgeVersion;
    meta['installedAt'] = DateTime.now().toUtc().toIso8601String();

    if (original != null && await _stat(sftp, p(_rel.backup)) == null) {
      await _writeFile(sftp, p(_rel.backup), utf8.encode(original), mode: mode);
    }
    await _writeAtomic(sftp, settingsPath, '${const JsonEncoder.withIndent('  ').convert(settings)}\n', mode);
    await _writeFile(sftp, p(_rel.meta), utf8.encode('${const JsonEncoder.withIndent('  ').convert(meta)}\n'), mode: 0x180);

    bridged = true;
    bridgeScriptVersion = bridgeVersion;
    _changed();
  }

  Future<void> removeClaude() async {
    final sftp = await conn.sftp();
    final home = await _home();
    String p(String rel) => '$home/$rel';
    final settingsPath = p(_rel.settings);
    final original = await _readText(sftp, settingsPath);
    final settings = parseSettings(original);
    Map<String, dynamic> meta = {};
    try {
      final m = jsonDecode(await _readText(sftp, p(_rel.meta)) ?? '{}');
      if (m is Map<String, dynamic>) meta = m;
    } catch (_) {}
    var touched = false;
    final cur = settings['statusLine'];
    if (_isBridge(cur is Map ? cur['command'] : null)) {
      final prev = meta['prevStatusLine'];
      if (prev is Map) {
        settings['statusLine'] = prev;
      } else {
        settings.remove('statusLine');
      }
      touched = true;
    }
    if (meta['notifChannel'] == true && settings['preferredNotifChannel'] == 'terminal_bell') {
      settings.remove('preferredNotifChannel');
      touched = true;
    }
    if (touched && original != null) {
      final st = await _stat(sftp, settingsPath);
      await _writeAtomic(sftp, settingsPath, '${const JsonEncoder.withIndent('  ').convert(settings)}\n', (st?.mode?.value ?? 0x1A4) & 0x1FF);
    }
    for (final rel in [_rel.script, _rel.next, _rel.meta]) {
      try {
        await sftp.remove(p(rel));
      } catch (_) {}
    }
    try {
      for (final e in await sftp.listdir(p(_rel.state))) {
        if (RegExp(r'^claude.*\.json').hasMatch(e.filename)) {
          try {
            await sftp.remove(p('${_rel.state}/${e.filename}'));
          } catch (_) {}
        }
      }
    } catch (_) {}
    _snaps.clear();
    bridged = false;
    bridgeScriptVersion = 0;
    _changed();
  }

  /* ---------------- files handed to agents ---------------- */

  bool _pruned = false;

  /// A fresh folder under ~/.pult/uploads for files sent to a terminal.
  Future<String> uploadDir() async {
    final sftp = await conn.sftp();
    final dir = '${await _home()}/${_rel.uploads}/${_stamp()}';
    await _mkdirp(sftp, dir);
    if (!_pruned) {
      _pruned = true;
      unawaited(conn.exec('find "\$HOME/${_rel.uploads}" -mindepth 1 -mtime +7 -delete 2>/dev/null; true', const Duration(seconds: 30)).then((_) {}, onError: (_) {}));
    }
    return dir;
  }

  @override
  void dispose() {
    _disposed = true;
    _agyTimer?.cancel();
    conn.removeListener(_onConn);
    conn.onAgentScan = null;
    conn.agentPolling = false;
    super.dispose();
  }
}
