// One SSH connection to one server — the same design as the desktop app:
// keepalive pings detect a dead link, the client reconnects with backoff and
// every shell re-attaches to its tmux session, so remote programs never notice
// that the phone switched networks or slept.

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:dartssh2/dartssh2.dart';
import 'package:flutter/foundation.dart';
import 'package:xterm/xterm.dart';

import 'format.dart';
import 'store.dart';

enum ConnState { connecting, ready, reconnecting, failed, closed }

class ConnError implements Exception {
  ConnError(this.code, this.message);
  final String code;
  final String message;
  @override
  String toString() => message;
}

typedef ExecResult = ({int? code, String stdout, String stderr});

const ExecResult execFailed = (code: null, stdout: '', stderr: '');

class SecretAnswer {
  SecretAnswer(this.value, this.save);
  final String value;
  final bool save;
}

/// Questions a connection needs a person to answer.
abstract class Prompter {
  Future<bool> hostKey({required String server, required String host, required String type, required String fingerprint, String? previous});
  Future<SecretAnswer?> secret({required String server, required String label, required bool passphrase, required bool retry});
  Future<List<String>?> interactive({required String server, required String name, required String instruction, required List<SSHUserInfoPrompt> prompts});
}

class Stats {
  int? rtt;
  double? cpu;
  int? memUsed, memTotal, diskUsed, diskTotal;
  double? uptime;
}

const _backoff = [1, 2, 3, 5, 8, 12, 15];
const _tmux = 'tmux -u -L pult -f /dev/null';
final _sessionRe = RegExp(r'^pult-\d{4}$');

/// Attach to (or create) a private tmux session; plain login shell without tmux.
/// Identical to the desktop app, so sessions are shared between phone and PC.
String tmuxScript(String name, int cols, int rows) {
  final opts = [
    'set -g status off',
    'set -g escape-time 0',
    'set -g default-terminal screen-256color',
    'set -ga terminal-overrides ",xterm*:smcup@:rmcup@:Tc"',
    'set -g focus-events on',
  ].join(r' \; ');
  final create = '\$T new-session -d -s "\$S" -x $cols -y $rows';
  final everyTime = ['set -g set-clipboard on', 'set -g allow-passthrough on'].map((o) => '\$T $o >/dev/null 2>&1').join('; ');
  return [
    'S=$name',
    'if command -v tmux >/dev/null 2>&1; then',
    'T="$_tmux"',
    'if ! \$T has-session 2>/dev/null; then $create \\; $opts >/dev/null 2>&1',
    'elif ! \$T has-session -t "\$S" 2>/dev/null; then $create >/dev/null 2>&1',
    'fi',
    everyTime,
    '\$T attach -t "\$S" && exit 0',
    'fi',
    r'exec "${SHELL:-/bin/sh}" -l',
  ].join('; ').replaceAll('then; ', 'then ');
}

const _monitorScript = 'while IFS= read -r l; do case "\$l" in '
    'p) echo p;; '
    's) read -r x c < /proc/stat; echo "cpu \$c"; '
    'm=""; while read -r k v u; do case "\$k" in MemTotal:|MemAvailable:) m="\$m \$v";; esac; done < /proc/meminfo; echo "mem\$m"; '
    'echo "disk \$(df -Pk / 2>/dev/null | tail -n 1)"; '
    'read -r up idle < /proc/uptime; echo "up \$up"; '
    'echo end;; '
    'esac; done';

const _probeScript =
    'command -v tmux >/dev/null 2>&1 && { echo T; tmux -L pult ls -F "#{session_name}" 2>/dev/null; true; } || echo N; echo "H \$HOME"';

/// dart:io socket with Nagle off: every keystroke goes out at once.
class _FastSocket implements SSHSocket {
  _FastSocket(this._s) {
    try {
      _s.setOption(SocketOption.tcpNoDelay, true);
    } catch (_) {}
  }
  final Socket _s;
  static Future<SSHSocket> connect(String host, int port) async =>
      _FastSocket(await Socket.connect(host, port, timeout: const Duration(seconds: 15)));
  @override
  Stream<Uint8List> get stream => _s;
  @override
  StreamSink<List<int>> get sink => _s;
  @override
  Future<void> get done => _s.done;
  @override
  Future<void> close() => _s.close();
  @override
  void destroy() => _s.destroy();
  @override
  Future<void> flush() => _s.flush();
}

ConnError classify(Object e) {
  if (e is ConnError) return e;
  final s = e.toString();
  if (e is SSHAuthFailError || e is SSHAuthAbortError) return ConnError('AUTH', s);
  if (e is SSHHostkeyError) return ConnError('HOSTKEY', s);
  if (e is SSHKeyDecodeError) return ConnError('KEY', s);
  if (e is TimeoutException) return ConnError('TIMEOUT', s);
  if (e is SocketException || e is SSHSocketError) {
    if (s.contains('host lookup') || s.contains('No address')) return ConnError('NOT_FOUND', s);
    if (s.contains('refused')) return ConnError('REFUSED', s);
    if (s.contains('timed out')) return ConnError('TIMEOUT', s);
    if (s.contains('unreachable')) return ConnError('UNREACHABLE', s);
    return ConnError('RESET', s);
  }
  return ConnError('OTHER', s);
}

class Connection extends ChangeNotifier {
  Connection(this.server, {required this.store, required this.prompter});

  final Server server;
  final Store store;
  final Prompter prompter;

  ConnState state = ConnState.connecting;
  ConnError? error;
  int attempt = 0;
  DateTime? retryAt;
  bool everReady = false;
  bool closed = false;
  bool fatal = false;

  bool hasTmux = false;
  String? home;
  final knownSessions = <String>{};
  final shells = <RemoteShell>[];
  final stats = Stats();

  /// OSC 52 from a remote program: put this text on the phone's clipboard.
  void Function(String text)? onClipboard;

  /// A shell whose remote process ended by itself.
  void Function(RemoteShell shell)? onShellExit;

  SSHClient? _client;
  SSHSocket? _socket;
  Future<SftpClient>? _sftp;
  Timer? _retryTimer, _readyTimer, _watchdog, _monitorTimer;
  SSHSession? _monitor;
  DateTime? _pingSentAt;
  List<int>? _cpuPrev;
  String? _password, _passphrase;
  List<SSHKeyPair>? _identities;
  bool _authRejected = false;
  bool _savePassword = false;
  ConnError? _lastError;
  int _gen = 0, _closedGen = 0;
  final _waiters = <Completer<void>>[];

  bool get isReady => state == ConnState.ready;

  void _set(ConnState s) {
    state = s;
    notifyListeners();
  }

  /* ---------------- lifecycle ---------------- */

  Future<void> start() async {
    closed = false;
    fatal = false;
    await _connect();
  }

  Future<void> _connect() async {
    _retryTimer?.cancel();
    retryAt = null;
    if (closed) return;
    final gen = ++_gen;
    _lastError = null;
    _set(everReady ? ConnState.reconnecting : ConnState.connecting);

    try {
      await _loadSecrets();
    } catch (e) {
      _fail(classify(e));
      return;
    }
    if (closed || gen != _gen) return;

    final SSHSocket socket;
    try {
      socket = await _FastSocket.connect(server.host, server.port);
    } catch (e) {
      _onClosed(gen, classify(e));
      return;
    }
    if (closed || gen != _gen) {
      socket.destroy();
      return;
    }
    _socket = socket;
    _armReadyTimer(gen);

    final client = SSHClient(
      socket,
      username: server.username,
      keepAliveInterval: null, // our watchdog pings and acts on silence
      onVerifyHostKey: (type, fp) => _verifyHost(gen, type, utf8.decode(fp)),
      onPasswordRequest: server.auth == 'password' ? () => _password : null,
      identities: server.auth == 'key' ? _identities : null,
      onUserInfoRequest: (req) => _interactive(gen, req),
    );
    _client = client;
    client.done.then((_) => _onClosed(gen, null), onError: (Object e) => _onClosed(gen, classify(e)));

    try {
      await client.authenticated;
    } catch (e) {
      _lastError ??= classify(e);
      socket.destroy();
      return;
    }
    _readyTimer?.cancel();
    if (gen != _gen || closed) return;
    await _onReady(gen, client);
  }

  // A person reading a dialog must not make the handshake time out.
  void _armReadyTimer(int gen) {
    _readyTimer?.cancel();
    _readyTimer = Timer(const Duration(seconds: 30), () {
      if (gen != _gen || state == ConnState.ready) return;
      _lastError = ConnError('TIMEOUT', 'Server javob bermadi');
      _socket?.destroy();
    });
  }

  Future<void> _loadSecrets() async {
    if (server.auth == 'key') {
      final pem = await store.privateKey(server.id);
      if (pem == null || pem.trim().isEmpty) {
        throw ConnError('KEY', 'SSH kalit saqlanmagan. Server sozlamalarida kalit qo‘shing yoki yarating.');
      }
      _passphrase ??= await store.passphrase(server.id);
      for (;;) {
        final encrypted = SSHKeyPair.isEncryptedPem(pem);
        if (encrypted && (_passphrase == null || _passphrase!.isEmpty)) {
          final a = await prompter.secret(server: server.name, label: 'Kalit paroli', passphrase: true, retry: false);
          if (a == null) throw ConnError('CANCELLED', 'Bekor qilindi');
          _passphrase = a.value;
          if (a.save) await store.rememberPassphrase(server.id, a.value);
        }
        try {
          _identities = SSHKeyPair.fromPem(pem, encrypted ? _passphrase : null);
          return;
        } on SSHKeyDecryptError {
          final a = await prompter.secret(server: server.name, label: 'Kalit paroli', passphrase: true, retry: true);
          if (a == null) throw ConnError('CANCELLED', 'Bekor qilindi');
          _passphrase = a.value;
          if (a.save) await store.rememberPassphrase(server.id, a.value);
        } catch (e) {
          throw ConnError('KEY', 'Kalit yaroqsiz: $e');
        }
      }
    }
    if (!_authRejected) _password ??= await store.password(server.id);
    if (_password == null || _password!.isEmpty) {
      final a = await prompter.secret(
        server: server.name,
        label: '${server.username}@${server.host} uchun parol',
        passphrase: false,
        retry: _authRejected,
      );
      if (a == null) throw ConnError('CANCELLED', 'Bekor qilindi');
      _password = a.value;
      _savePassword = a.save;
    }
  }

  Future<bool> _verifyHost(int gen, String type, String fp) async {
    final hp = '${server.host}:${server.port}';
    final known = store.hostKey(hp);
    if (known != null && known['fingerprint'] == fp) return true;
    _readyTimer?.cancel();
    final ok = await prompter.hostKey(
      server: server.name,
      host: hp,
      type: type,
      fingerprint: fp,
      previous: known?['fingerprint'] as String?,
    );
    if (gen != _gen) return false;
    _armReadyTimer(gen);
    if (ok) {
      await store.trustHostKey(hp, type, fp);
    } else {
      _lastError = ConnError('HOSTKEY', 'Server kaliti rad etildi');
    }
    return ok;
  }

  Future<List<String>?> _interactive(int gen, SSHUserInfoRequest req) async {
    if (req.prompts.isEmpty) return [];
    if (req.prompts.length == 1 && !req.prompts.first.echo && (_password?.isNotEmpty ?? false)) {
      return [_password!];
    }
    _readyTimer?.cancel();
    final answers = await prompter.interactive(
      server: server.name,
      name: req.name,
      instruction: req.instruction,
      prompts: req.prompts,
    );
    if (gen == _gen) _armReadyTimer(gen);
    return answers;
  }

  Future<void> _onReady(int gen, SSHClient client) async {
    attempt = 0;
    error = null;
    _authRejected = false;
    if (_savePassword && _password != null) {
      _savePassword = false;
      await store.rememberPassword(server.id, _password!);
    }
    try {
      final out = await _execOn(client, _probeScript, const Duration(seconds: 6));
      final lines = out.stdout.split('\n').map((l) => l.trim()).where((l) => l.isNotEmpty).toList();
      hasTmux = lines.isNotEmpty && lines.first == 'T';
      for (final l in lines) {
        if (_sessionRe.hasMatch(l)) knownSessions.add(l);
        if (l.startsWith('H ')) home = l.substring(2);
      }
    } catch (_) {
      hasTmux = false;
    }
    if (gen != _gen || closed) return;

    final wasReady = everReady;
    everReady = true;
    _set(ConnState.ready);
    for (final w in _waiters) {
      w.complete();
    }
    _waiters.clear();

    _startWatchdog(gen, client);
    _startMonitor(gen, client);
    if (wasReady) {
      for (final s in shells) {
        if (!s.exited && !s.closing) unawaited(s._open(client).catchError((_) {}));
      }
    }
  }

  void _onClosed(int gen, ConnError? err) {
    if (gen != _gen || _closedGen == gen) return;
    _closedGen = gen;
    _readyTimer?.cancel();
    _stopWatch();
    _sftp = null;
    _client = null;
    _socket = null;
    for (final s in shells) {
      s._detach();
    }
    if (closed) {
      _set(ConnState.closed);
      return;
    }
    err = _lastError ?? err;
    if (err?.code == 'AUTH') {
      if (server.auth == 'password') {
        _password = null;
        _authRejected = true;
      }
      _fail(err!);
      return;
    }
    if (const {'HOSTKEY', 'KEY', 'CANCELLED'}.contains(err?.code)) {
      _fail(err!);
      return;
    }
    if (!everReady) {
      _fail(err ?? ConnError('OTHER', 'Ulanish yopildi'));
      return;
    }
    _scheduleReconnect();
  }

  void _fail(ConnError e) {
    error = e;
    fatal = true;
    attempt = 0;
    _set(ConnState.failed);
    for (final w in _waiters) {
      w.completeError(e);
    }
    _waiters.clear();
  }

  void _scheduleReconnect() {
    final delay = _backoff[attempt.clamp(0, _backoff.length - 1)];
    attempt++;
    retryAt = DateTime.now().add(Duration(seconds: delay));
    _set(ConnState.reconnecting);
    _retryTimer?.cancel();
    _retryTimer = Timer(Duration(seconds: delay), _connect);
  }

  /// Skip the backoff wait (network came back, app resumed, user tapped).
  void retryNow() {
    if (closed) return;
    if (state == ConnState.reconnecting && _retryTimer?.isActive == true) {
      _connect();
    } else if (state == ConnState.failed) {
      fatal = false;
      _connect();
    }
  }

  /// After sleep or a network switch the socket may be silently dead.
  Future<void> probe() async {
    final client = _client;
    if (state != ConnState.ready || client == null) return;
    try {
      await client.ping().timeout(const Duration(seconds: 4));
    } catch (_) {
      if (identical(client, _client)) {
        _lastError = ConnError('TIMEOUT', 'Javob yo‘q');
        _socket?.destroy();
      }
    }
  }

  Future<void> whenReady() {
    if (state == ConnState.ready) return Future.value();
    if (closed) return Future.error(ConnError('CLOSED', 'Ulanish yopilgan'));
    if (fatal) return Future.error(error ?? ConnError('OTHER', 'Ulanib bo‘lmadi'));
    final c = Completer<void>();
    _waiters.add(c);
    return c.future;
  }

  Future<void> close() async {
    closed = true;
    _retryTimer?.cancel();
    _readyTimer?.cancel();
    _stopWatch();
    for (final w in _waiters) {
      w.completeError(ConnError('CLOSED', 'Ulanish yopilgan'));
    }
    _waiters.clear();
    for (final s in shells) {
      s.closing = true;
      s._ch?.close();
    }
    final client = _client;
    final socket = _socket;
    if (client == null) {
      _set(ConnState.closed);
      return;
    }
    client.close();
    Timer(const Duration(milliseconds: 1500), () => socket?.destroy());
  }

  /* ---------------- watchdog + monitor ---------------- */

  void _startWatchdog(int gen, SSHClient client) {
    _watchdog?.cancel();
    var busy = false;
    _watchdog = Timer.periodic(const Duration(seconds: 6), (_) async {
      if (busy || gen != _gen) return;
      busy = true;
      try {
        await client.ping().timeout(const Duration(seconds: 15));
      } catch (_) {
        if (gen == _gen && identical(client, _client)) {
          _lastError = ConnError('TIMEOUT', 'Aloqa javob bermayapti');
          _socket?.destroy();
        }
      } finally {
        busy = false;
      }
    });
  }

  void _startMonitor(int gen, SSHClient client) async {
    _cpuPrev = null;
    try {
      final m = await client.execute('sh -c ${shq(_monitorScript)}');
      if (gen != _gen) {
        m.close();
        return;
      }
      _monitor = m;
      var buf = '';
      m.stdout.cast<List<int>>().transform(const Utf8Decoder(allowMalformed: true)).listen((d) {
        buf += d;
        int i;
        while ((i = buf.indexOf('\n')) >= 0) {
          _onMonitorLine(buf.substring(0, i));
          buf = buf.substring(i + 1);
        }
      }, onError: (_) {});
      m.stderr.listen((_) {}, onError: (_) {});
      void tick() {
        if (gen != _gen || _monitor == null) return;
        _pingSentAt = DateTime.now();
        try {
          m.write(Uint8List.fromList(utf8.encode('p\ns\n')));
        } catch (_) {}
      }

      tick();
      _monitorTimer = Timer.periodic(const Duration(seconds: 2), (_) => tick());
    } catch (_) {
      // No sh or /proc (e.g. a Windows server): simply no stats.
    }
  }

  void _stopWatch() {
    _watchdog?.cancel();
    _monitorTimer?.cancel();
    _monitor?.close();
    _monitor = null;
  }

  void _onMonitorLine(String line) {
    final parts = line.trim().split(RegExp(r'\s+'));
    if (parts.isEmpty) return;
    final nums = parts.skip(1).map((e) => int.tryParse(e) ?? double.tryParse(e)?.toInt() ?? 0).toList();
    switch (parts.first) {
      case 'p':
        if (_pingSentAt != null) stats.rtt = DateTime.now().difference(_pingSentAt!).inMilliseconds;
      case 'cpu':
        final total = nums.fold<int>(0, (a, b) => a + b);
        final idle = (nums.length > 4 ? nums[3] + nums[4] : 0);
        final prev = _cpuPrev;
        if (prev != null && total > prev[0]) {
          stats.cpu = (1 - (idle - prev[1]) / (total - prev[0])).clamp(0.0, 1.0);
        }
        _cpuPrev = [total, idle];
      case 'mem':
        if (nums.isNotEmpty && nums[0] > 0) {
          stats.memTotal = nums[0] * 1024;
          stats.memUsed = (nums[0] - (nums.length > 1 ? nums[1] : 0)) * 1024;
        }
      case 'disk':
        // Filesystem 1024-blocks Used Available Capacity Mounted
        final f = parts.skip(1).toList();
        if (f.length >= 4) {
          final used = int.tryParse(f[2]);
          final avail = int.tryParse(f[3]);
          if (used != null && avail != null) {
            stats.diskUsed = used * 1024;
            stats.diskTotal = (used + avail) * 1024;
          }
        }
      case 'up':
        stats.uptime = double.tryParse(parts.length > 1 ? parts[1] : '');
      case 'end':
        notifyListeners();
    }
  }

  /* ---------------- exec ---------------- */

  Future<ExecResult> exec(String script, [Duration timeout = const Duration(seconds: 15)]) {
    final c = _client;
    if (c == null || !isReady) return Future.error(ConnError('NOT_CONNECTED', 'Server bilan aloqa yo‘q'));
    return _execOn(c, script, timeout);
  }

  Future<ExecResult> _execOn(SSHClient client, String script, Duration timeout) async {
    final s = await client.execute('sh -c ${shq(script)}');
    final out = StringBuffer();
    final err = StringBuffer();
    const dec = Utf8Decoder(allowMalformed: true);
    final sub = s.stdout.cast<List<int>>().transform(dec).listen(out.write);
    final subErr = s.stderr.cast<List<int>>().transform(dec).listen(err.write);
    try {
      await s.done.timeout(timeout);
    } on TimeoutException {
      s.close();
      rethrow;
    } finally {
      await sub.cancel().catchError((_) {});
      await subErr.cancel().catchError((_) {});
    }
    return (code: s.exitCode, stdout: out.toString(), stderr: err.toString());
  }

  /* ---------------- shells ---------------- */

  String _nextSessionName() {
    var n = 0;
    for (final s in knownSessions) {
      n = n > int.parse(s.substring(5)) ? n : int.parse(s.substring(5));
    }
    for (final sh in shells) {
      final name = sh.session;
      if (name != null) n = n > int.parse(name.substring(5)) ? n : int.parse(name.substring(5));
    }
    return 'pult-${(n + 1).toString().padLeft(4, '0')}';
  }

  Future<RemoteShell> openShell({String? attach}) async {
    final persist = server.persist && hasTmux;
    String? name;
    if (persist) name = attach != null && _sessionRe.hasMatch(attach) ? attach : _nextSessionName();
    final shell = RemoteShell(this, session: name);
    shells.add(shell);
    if (name != null) knownSessions.add(name);
    notifyListeners();
    final c = _client;
    if (isReady && c != null) await shell._open(c);
    return shell;
  }

  Future<void> reopenShell(RemoteShell shell) async {
    shell.exited = false;
    shell.reopening = true;
    final c = _client;
    if (isReady && c != null) await shell._open(c);
    notifyListeners();
  }

  Future<void> closeShell(RemoteShell shell, {bool kill = true}) async {
    shell.closing = true;
    shells.remove(shell);
    shell._ch?.close();
    final name = shell.session;
    if (name != null) {
      knownSessions.remove(name);
      if (kill && isReady) await exec('$_tmux kill-session -t $name 2>/dev/null; true', const Duration(seconds: 5)).catchError((_) => execFailed);
    }
    notifyListeners();
  }

  void _shellExited(RemoteShell s) {
    onShellExit?.call(s);
    notifyListeners();
  }

  /* ---------------- sftp ---------------- */

  /// wait=true: transfers block until the link is back; UI calls fail fast.
  Future<SftpClient> sftp({bool wait = false}) async {
    if (!isReady) {
      if (!wait) throw ConnError('NOT_CONNECTED', 'Server bilan aloqa yo‘q');
      await whenReady();
    }
    final client = _client!;
    final f = _sftp ??= client.sftp();
    try {
      return await f;
    } catch (_) {
      if (identical(_sftp, f)) _sftp = null;
      rethrow;
    }
  }

  @override
  void dispose() {
    close();
    super.dispose();
  }
}

class RemoteShell {
  RemoteShell(this.conn, {this.session}) {
    terminal = Terminal(
      maxLines: 10000,
      platform: TerminalTargetPlatform.android,
      onOutput: write,
      onResize: (w, h, pw, ph) {
        try {
          _ch?.resizeTerminal(w, h, pw, ph);
        } catch (_) {}
      },
      onTitleChange: (t) => title = t,
      onPrivateOSC: _osc,
    );
  }

  final Connection conn;
  late final Terminal terminal;
  final controller = TerminalController();
  final String? session;
  String title = '';
  bool exited = false;
  bool closing = false;
  bool reopening = false;
  int channels = 0;
  SSHSession? _ch;
  StreamSubscription<String>? _out, _err;

  bool get persistent => session != null;

  Future<void> _open(SSHClient client) async {
    final w = terminal.viewWidth;
    final h = terminal.viewHeight;
    final pty = SSHPtyConfig(type: 'xterm-256color', width: w, height: h);
    final name = session;
    final ch = name != null ? await client.execute('sh -c ${shq(tmuxScript(name, w, h))}', pty: pty) : await client.shell(pty: pty);
    if (closing) {
      ch.close();
      return;
    }
    _detach();
    _ch = ch;
    final afterDrop = channels > 0 && !reopening;
    channels++;
    reopening = false;
    exited = false;
    if (afterDrop && !persistent) terminal.write('\r\n\x1b[2m── aloqa tiklandi · yangi sessiya ──\x1b[0m\r\n');
    const dec = Utf8Decoder(allowMalformed: true);
    _out = ch.stdout.cast<List<int>>().transform(dec).listen(terminal.write, onError: (_) {});
    _err = ch.stderr.cast<List<int>>().transform(dec).listen(terminal.write, onError: (_) {});
    ch.done.then((_) => _ended(ch, client), onError: (_) => _ended(ch, client));
  }

  void _ended(SSHSession ch, SSHClient client) {
    if (!identical(_ch, ch)) return;
    _ch = null;
    // Give the connection a moment to report a dropped link before deciding
    // whether the remote process really ended.
    Timer(const Duration(milliseconds: 200), () {
      if (closing) return;
      final gotExit = ch.exitCode != null || ch.exitSignal != null;
      final linkAlive = conn.isReady && identical(conn._client, client);
      if (gotExit || linkAlive) {
        exited = true;
        conn._shellExited(this);
      }
    });
  }

  void _detach() {
    _out?.cancel();
    _err?.cancel();
    _out = null;
    _err = null;
    _ch = null;
  }

  /// Sticky on-screen Ctrl / Alt: applied to the next typed character.
  bool ctrl = false, alt = false;
  VoidCallback? onModifiersUsed;

  void write(String data) {
    final ch = _ch;
    if (ch == null || exited || !conn.isReady) return;
    // The phone keyboard's Enter / Send key arrives as "\n" (line feed). A real
    // terminal's Enter is "\r": programs like Claude CLI treat "\n" as "insert
    // a new line" instead of "send".
    if (data == '\n') data = '\r';
    if ((ctrl || alt) && data.runes.length == 1) {
      data = applyModifiers(data, ctrl: ctrl, alt: alt);
      ctrl = alt = false;
      onModifiersUsed?.call();
    }
    try {
      ch.write(Uint8List.fromList(utf8.encode(data)));
    } catch (_) {}
  }

  static String applyModifiers(String ch, {required bool ctrl, required bool alt}) {
    var out = ch;
    if (ctrl) {
      final c = ch.toLowerCase().codeUnitAt(0);
      if (c >= 0x61 && c <= 0x7a) {
        out = String.fromCharCode(c - 0x60);
      } else if (c >= 0x5b && c <= 0x5f) {
        out = String.fromCharCode(c - 0x40); // [ \ ] ^ _
      } else if (ch == ' ' || ch == '2' || ch == '@') {
        out = '\x00';
      } else if (ch == '?') {
        out = '\x7f';
      }
    }
    return alt ? '\x1b$out' : out;
  }

  // "52;c;<base64>" — write only; a remote program never reads our clipboard.
  void _osc(String code, List<String> args) {
    if (code != '52' || args.isEmpty) return;
    final payload = args.last;
    if (payload.isEmpty || payload == '?' || payload.length > 4 * 1024 * 1024) return;
    try {
      final text = utf8.decode(base64.decode(payload), allowMalformed: true);
      if (text.isNotEmpty) conn.onClipboard?.call(text);
    } catch (_) {}
  }

  String selectedText() {
    final sel = controller.selection;
    if (sel == null) return '';
    return terminal.buffer.getText(sel);
  }
}
