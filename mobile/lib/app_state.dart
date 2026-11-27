// App-wide state: open sessions, transfers, and keeping connections alive
// across app pauses and network switches.

import 'dart:async';
import 'dart:io';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';

import 'core/agents.dart';
import 'core/connection.dart';
import 'core/files.dart';
import 'core/format.dart';
import 'core/fsops.dart';
import 'core/store.dart';
import 'core/transfers.dart';
import 'core/tunnels.dart';
import 'core/update.dart';
import 'ui/prompts.dart';
import 'ui/widgets.dart';

/// Shells: closing a terminal where only one of these runs loses nothing.
const _shells = {'bash', 'zsh', 'sh', 'fish', 'dash', 'ksh', 'mksh', 'tcsh', 'csh', 'ash', 'login', 'tmux'};

/// What Claude Code is doing in one terminal (from its hooks).
enum ClaudeState { work, wait, done }

/// Claude's Notification message in Uzbek: "Bash uchun ruxsat so‘rayapti".
String waitText(ClaudeEvent ev) {
  final m = ev.message ?? '';
  final tool = RegExp(r'permission to use (.+?)\.?$', caseSensitive: false).firstMatch(m);
  if (tool != null) return '${tool[1]} uchun ruxsat so‘rayapti';
  if (RegExp('permission', caseSensitive: false).hasMatch(m) || ev.kind == 'permission_prompt') return 'ruxsat so‘rayapti';
  if (RegExp('waiting for your input|idle', caseSensitive: false).hasMatch(m) || ev.kind == 'idle_prompt') return 'javobingizni kutyapti';
  return m.isNotEmpty ? (m.length > 120 ? m.substring(0, 120) : m) : 'sizni kutyapti';
}

/// One open server: a connection plus what the screen shows for it.
class Session extends ChangeNotifier {
  Session(this.app, this.server, this.conn)
      : files = FilesController(conn),
        agents = Agents(conn, usage: () => app.store.settings.agentUsage),
        tunnels = Tunnels(conn) {
    conn.addListener(_onConn);
    conn.onShellExit = _onShellExit;
    conn.onShellBell = _onShellBell;
    conn.onClipboard = (text) {
      Clipboard.setData(ClipboardData(text: text));
      final ctx = app.navKey.currentContext;
      if (ctx != null) toast(ctx, 'Nusxalandi');
    };
    agents.onClaudeWaiting = _onClaudeWaiting;
    tunnels.onSave = _saveTunnels;
  }

  final AppState app;
  Server server;
  final Connection conn;
  final FilesController files;

  /// AI agents on this server (Claude Code, agy): limits, panes, hook events.
  final Agents agents;

  /// SSH tunnels: server ports opened on the phone (127.0.0.1).
  final Tunnels tunnels;
  int tab = 0; // 0 = terminal, 1 = files
  RemoteShell? active;
  bool _restored = false;
  bool _tunnelsStarted = false;
  ConnState _last = ConnState.connecting;

  /// Is this session's page on screen (not the server list, not paused)?
  bool get inFront => app.front == server.id && app.foreground;

  void _onConn() {
    final s = conn.state;
    if (s == ConnState.ready && !_restored) {
      _restored = true;
      _restore();
    } else if (s == ConnState.ready && _last != ConnState.ready && files.loaded) {
      files.refresh();
    }
    if (s == ConnState.ready && !_tunnelsStarted) {
      _tunnelsStarted = true;
      _startTunnels();
    }
    _last = s;
    notifyListeners();
  }

  // Re-attach every tmux session left from last time (phone or PC): 1:1.
  Future<void> _restore() async {
    final names = server.persist && conn.hasTmux ? (conn.knownSessions.toList()..sort()) : <String>[];
    try {
      if (names.isEmpty) {
        active = await conn.openShell();
      } else {
        for (final n in names) {
          await conn.openShell(attach: n);
        }
        active = conn.shells.first;
      }
    } catch (_) {}
    notifyListeners();
  }

  // The tunnels saved with this server start with the first connection.
  Future<void> _startTunnels() async {
    for (final t in server.tunnels) {
      try {
        await tunnels.add('${t['remoteHost']}', t['remotePort'] as int, local: t['localPort'] as int?, save: false);
      } catch (_) {}
    }
  }

  void _saveTunnels() {
    server.tunnels = [for (final t in tunnels.list) t.toJson()];
    final stored = app.store.server(server.id);
    if (stored != null) {
      stored.tunnels = server.tunnels;
      app.store.saveServer(stored);
    }
  }

  void _onShellExit(RemoteShell sh) {
    // `exit` in one of several terminals simply closes that tab.
    if (conn.shells.length > 1) closeShell(sh);
    notifyListeners();
  }

  void setTab(int t) {
    tab = t;
    if (t == 1) files.init(server.startDir).catchError((_) {});
    notifyListeners();
  }

  Future<void> newShell() async {
    if (!conn.isReady) return;
    active = await conn.openShell();
    tab = 0;
    notifyListeners();
  }

  void select(RemoteShell s) {
    active = s;
    s.attention = false;
    notifyListeners();
  }

  // A bell in a terminal you are not looking at marks its tab. With Claude's
  // hooks on, its own events say exactly what happened instead.
  void _onShellBell(RemoteShell sh) {
    if (agents.hooks && agentIn(sh) == Agent.claude) return;
    if (identical(sh, active) && tab == 0 && inFront) return;
    if (sh.attention) return;
    sh.attention = true;
    notifyListeners();
  }

  // Claude asks for permission (or a reply) in some terminal.
  void _onClaudeWaiting(String session, ClaudeEvent ev) {
    final sh = conn.shells.where((s) => s.session == session).firstOrNull;
    if (sh == null) return;
    final looking = identical(sh, active) && tab == 0 && inFront;
    if (looking) return;
    sh.attention = true;
    notifyListeners();
    final ctx = app.navKey.currentContext;
    final n = conn.shells.indexOf(sh) + 1;
    if (ctx != null && app.foreground) toast(ctx, '${inFront ? '' : '${server.name} · '}Terminal $n: Claude ${waitText(ev)}');
  }

  /// What runs in [sh] right now: Claude Code, agy or nothing.
  Agent? agentIn(RemoteShell? sh) => sh?.session == null ? null : agents.panes[sh!.session]?.agent;

  /// Claude's state in [sh] from its hooks (null without hooks or Claude).
  ({ClaudeState state, ClaudeEvent ev})? claudeIn(RemoteShell? sh) {
    final name = sh?.session;
    if (name == null || agentIn(sh) != Agent.claude) return null;
    final ev = agents.claudeEvents[name];
    if (ev == null || ev.e == 'end') return null;
    final state = ev.e == 'wait' && ev.kind != 'idle_prompt'
        ? ClaudeState.wait
        : ev.e == 'done' || ev.e == 'wait'
            ? ClaudeState.done
            : ClaudeState.work;
    return (state: state, ev: ev);
  }

  /// A program other than the shell in [sh] (Claude Code, vim, a build…), or null.
  String? busyIn(RemoteShell sh) {
    if (sh.exited || !sh.persistent) return null;
    final pane = agents.panes[sh.session];
    final cmd = (pane?.command ?? '').replaceFirst(RegExp('^-'), '').trim();
    if (cmd.isEmpty || _shells.contains(cmd)) return null;
    final agent = pane?.agent;
    return agent == Agent.claude ? 'Claude Code' : agent == Agent.agy ? 'agy' : cmd;
  }

  /// Start an agent in a new terminal, in [dir] or where the current terminal is.
  Future<void> launchAgent(Agent kind, {String? dir, bool resume = false}) async {
    if (!conn.isReady) return;
    dir ??= active?.session == null ? null : agents.panes[active!.session]?.cwd;
    final cmd = '${kind == Agent.claude ? 'claude' : 'agy'}${resume ? ' -c' : ''}';
    final sh = await conn.openShell();
    active = sh;
    tab = 0;
    notifyListeners();
    sh.write('${dir != null && dir.isNotEmpty ? 'cd -- ${shq(dir)} && ' : ''}$cmd\r');
  }

  /// Type a saved command into the current terminal (and press Enter if [Snippet.run]).
  void runSnippet(Snippet s) {
    final sh = active;
    if (sh == null || sh.exited || !conn.isReady) return;
    tab = 0;
    notifyListeners();
    final cmd = s.cmd.trim();
    if (cmd.isEmpty) return;
    sh.terminal.paste(cmd);
    if (s.run) sh.write('\r');
  }

  /// Upload phone files to ~/.pult/uploads/<time>/ and type their paths into
  /// [sh] once they are on the server (Claude Code / agy read files by path).
  Future<void> sendFiles(RemoteShell sh, List<String> localPaths) async {
    if (localPaths.isEmpty || !conn.isReady) return;
    final dir = await agents.uploadDir();
    final job = app.transfers.upload(conn, localPaths, dir);
    final remote = [for (final p in localPaths) '$dir/${p.split(RegExp(r'[\\/]')).last}'];
    app.whenDone(job, (j) {
      if (j.state == JobState.done && !sh.exited) sh.terminal.paste('${remote.map(pathArg).join(' ')} ');
    });
  }

  Future<void> closeShell(RemoteShell s) async {
    final i = conn.shells.indexOf(s);
    await conn.closeShell(s);
    if (active == s) active = conn.shells.isEmpty ? null : conn.shells[(i).clamp(0, conn.shells.length - 1)];
    if (conn.shells.isEmpty && conn.isReady) active = await conn.openShell();
    notifyListeners();
  }

  @override
  void dispose() {
    conn.removeListener(_onConn);
    agents.dispose();
    tunnels.closeAll();
    super.dispose();
  }
}

/// Files waiting to be pasted (copy / cut). Pasting works on the same server.
class FileClip {
  FileClip(this.conn, this.cut, this.items);
  final Connection conn;
  final bool cut;
  final List<Item> items;
}

class AppState extends ChangeNotifier with WidgetsBindingObserver {
  AppState(this.store);

  final Store store;
  final transfers = Transfers();
  final sessions = <Session>[];

  FileClip? fileClip;
  void setClip(FileClip? c) {
    fileClip = c;
    notifyListeners();
  }

  final navKey = GlobalKey<NavigatorState>();
  late final Prompter prompter = DialogPrompter(navKey);
  StreamSubscription<dynamic>? _net;
  String? _downloadDir;

  /// The server whose page is on screen (null: the server list).
  String? front;

  /// The app is visible (not in the background).
  bool foreground = true;

  /// A newer Pult on GitHub (shown on the server list).
  Release? update;
  int _updateCheckedAt = 0;

  final _waiters = <Job, void Function(Job)>{};

  /// Run [fn] when [job] ends (done, failed or cancelled).
  void whenDone(Job job, void Function(Job) fn) {
    _waiters[job] = fn;
    if (!_watching) {
      _watching = true;
      transfers.addListener(_checkWaiters);
    }
  }

  bool _watching = false;
  void _checkWaiters() {
    for (final j in _waiters.keys.where((j) => !j.active).toList()) {
      _waiters.remove(j)?.call(j);
    }
  }

  void init() {
    WidgetsBinding.instance.addObserver(this);
    _net = Connectivity().onConnectivityChanged.listen((_) => _nudge());
    transfers.fast = store.settings.transferPace == 'fast';
    store.addListener(() => transfers.fast = store.settings.transferPace == 'fast');
    transfers.onDone = (j) {
      final ctx = navKey.currentContext;
      if (ctx != null) toast(ctx, '${j.upload ? 'Yuklandi' : 'Yuklab olindi'}: ${j.name}');
      if (j.upload) {
        for (final s in sessions) {
          if (s.conn == j.conn) s.files.refresh();
        }
      }
    };
    if (store.settings.checkUpdates) Timer(const Duration(seconds: 6), checkUpdate);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    foreground = state == AppLifecycleState.resumed;
    if (state == AppLifecycleState.resumed) {
      _nudge();
      if (store.settings.checkUpdates && nowMs() - _updateCheckedAt > 12 * 3600 * 1000) checkUpdate();
    }
  }

  // Back from background or a new network: check links now, not in 20 s.
  void _nudge() {
    for (final s in sessions) {
      s.conn.retryNow();
      s.conn.probe();
    }
  }

  Session? sessionFor(String serverId) => sessions.where((s) => s.server.id == serverId).firstOrNull;

  Session open(Server server) {
    final existing = sessionFor(server.id);
    if (existing != null) {
      if (existing.conn.state == ConnState.failed) existing.conn.retryNow();
      return existing;
    }
    final conn = Connection(server.copy(), store: store, prompter: prompter);
    final s = Session(this, server, conn);
    sessions.add(s);
    conn.start();
    store.touch(server.id);
    _saveLayout();
    notifyListeners();
    return s;
  }

  Future<void> close(Session s) async {
    sessions.remove(s);
    transfers.cancelFor(s.conn);
    if (front == s.server.id) front = null;
    _saveLayout();
    notifyListeners();
    await s.conn.close();
    s.dispose();
  }

  /// The session page in front changed (null: back on the server list).
  void setFront(String? serverId) {
    if (front == serverId) return;
    front = serverId;
    _saveLayout();
  }

  // Which servers are open, and which one is in front: reopened next start.
  void _saveLayout() {
    final st = store.settings;
    final ids = [for (final s in sessions) s.server.id];
    if (listEquals(ids, st.openServers) && st.lastServer == front) return;
    st.openServers = ids;
    st.lastServer = front;
    store.saveSettings();
  }

  bool _restoredLayout = false;

  /// Settings → "Oxirgi serverlarga ulanish": reconnect to the servers that
  /// were open last time; returns the one that was in front.
  Session? restoreLayout() {
    if (_restoredLayout) return null;
    _restoredLayout = true;
    final st = store.settings;
    if (!st.restoreSessions || st.openServers.isEmpty) return null;
    final lastFront = st.lastServer;
    Session? shown;
    for (final id in st.openServers) {
      final server = store.server(id);
      if (server == null) continue;
      final s = open(server);
      if (id == lastFront) shown = s;
    }
    return shown;
  }

  /// Look for a newer Pult on GitHub Releases ([manual]: report "up to date" too).
  Future<Release?> checkUpdate({bool manual = false}) async {
    _updateCheckedAt = nowMs();
    try {
      final r = await latestRelease();
      final available = newerVersion(r.version, kAppVersion) && r.apkUrl != null;
      update = available && (manual || store.settings.skipVersion != r.version) ? r : null;
      notifyListeners();
      return available ? r : null;
    } catch (e) {
      if (manual) rethrow;
      return null;
    }
  }

  /// "O‘tkazib yuborish": this version is not offered again.
  void skipUpdate(String version) {
    store.settings.skipVersion = version;
    store.saveSettings();
    update = null;
    notifyListeners();
  }

  /// Downloads go to the phone's public Download/Pult folder when possible.
  Future<String> downloadDir() async {
    if (_downloadDir != null) return _downloadDir!;
    final candidates = <String>[
      if (Platform.isAndroid) '/storage/emulated/0/Download/Pult',
      if ((await getExternalStorageDirectory()) case final d?) '${d.path}/Download',
      '${(await getApplicationDocumentsDirectory()).path}/Download',
    ];
    for (final c in candidates) {
      try {
        final d = Directory(c);
        await d.create(recursive: true);
        final probe = File('${d.path}/.pult-write-test');
        await probe.writeAsString('ok');
        await probe.delete();
        return _downloadDir = c;
      } catch (_) {}
    }
    return _downloadDir = candidates.last;
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _net?.cancel();
    super.dispose();
  }
}
