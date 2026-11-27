// Integration test of the SSH core against dev/mock-server.js (127.0.0.1:2222).
//   node dev/mock-server.js   (MOCK_ROOT=<dir>, MOCK_SLOW=60)
//   flutter test test/core_test.dart --dart-define=MOCK_ROOT=<dir>

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:crypto/crypto.dart' show sha256;
import 'package:dartssh2/dartssh2.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pult/core/agents.dart';
import 'package:pult/core/connection.dart';
import 'package:pult/core/files.dart';
import 'package:pult/core/fsops.dart';
import 'package:pult/core/keys.dart';
import 'package:pult/core/store.dart';
import 'package:pult/core/transfers.dart';
import 'package:pult/core/tunnels.dart';

const mockRoot = String.fromEnvironment('MOCK_ROOT');

class FakePrompter implements Prompter {
  @override
  Future<bool> hostKey({required String server, required String host, required String type, required String fingerprint, String? previous}) async => true;
  @override
  Future<SecretAnswer?> secret({required String server, required String label, required bool passphrase, required bool retry}) async => SecretAnswer('demo', false);
  @override
  Future<List<String>?> interactive({required String server, required String name, required String instruction, required List<SSHUserInfoPrompt> prompts}) async => null;
}

Future<void> until(bool Function() ok, {Duration timeout = const Duration(seconds: 15), String what = ''}) async {
  final end = DateTime.now().add(timeout);
  while (!ok()) {
    if (DateTime.now().isAfter(end)) throw TimeoutException('timed out waiting for $what');
    await Future<void>.delayed(const Duration(milliseconds: 50));
  }
}

String screen(RemoteShell s) => s.terminal.buffer.getText();

String sha(String path) => sha256.convert(File(path).readAsBytesSync()).toString();

void main() {
  late Directory tmp;
  late Store store;
  late Connection conn;
  final clipboard = <String>[];

  setUpAll(() async {
    tmp = await Directory.systemTemp.createTemp('pult-test-');
    store = Store(Directory('${tmp.path}/data'), MemorySecrets());
    await store.load();
    final s = Server(id: 't1', name: 'mock', host: '127.0.0.1', port: const int.fromEnvironment('MOCK_PORT', defaultValue: 2222), username: 'demo');
    await store.saveServer(s, password: 'demo');
    conn = Connection(s, store: store, prompter: FakePrompter());
    conn.onClipboard = clipboard.add;
    await conn.start();
    await until(() => conn.isReady, what: 'ready');
  });

  tearDownAll(() async {
    await conn.close();
  });

  test('connects, probes tmux and home', () {
    expect(conn.hasTmux, isTrue);
    expect(conn.home, '/home/demo');
  });

  test('shell: output and input', () async {
    final sh = await conn.openShell();
    expect(sh.persistent, isTrue);
    expect(sh.session, matches(RegExp(r'^pult-\d{4}$')));
    await until(() => screen(sh).contains('demo@acme-prod'), what: 'prompt');
    sh.write('whoami\r');
    await until(() => RegExp(r'whoami\s+demo').hasMatch(screen(sh)), what: 'whoami');
  });

  test('phone keyboard Enter ("\\n") is sent as a real Enter ("\\r")', () async {
    final sh = conn.shells.first;
    sh.write('uptime');
    sh.write('\n'); // what the Android keyboard's Enter / Send key produces
    await until(() => screen(sh).contains('load average'), what: 'uptime ran');
  });

  test('OSC 52 reaches the clipboard, read requests are ignored', () async {
    final sh = conn.shells.first;
    sh.write('copytest\r');
    await until(() => clipboard.isNotEmpty, what: 'clipboard');
    await Future<void>.delayed(const Duration(milliseconds: 300));
    expect(clipboard, ['Salom, dunyo! oʻzbekcha ✓']);
  });

  test('sticky Ctrl turns c into ^C', () {
    expect(RemoteShell.applyModifiers('c', ctrl: true, alt: false), '\x03');
    expect(RemoteShell.applyModifiers('x', ctrl: false, alt: true), '\x1bx');
  });

  test('monitor reports latency and load', () async {
    await until(() => conn.stats.rtt != null && conn.stats.cpu != null && conn.stats.memTotal != null, what: 'stats');
    expect(conn.stats.diskTotal, greaterThan(0));
  });

  test('ping replies feed the quiet ping (the pacer\'s base)', () async {
    final seen = <int>[];
    void listen(int rtt) => seen.add(rtt);
    conn.pongs.add(listen);
    addTearDown(() => conn.pongs.remove(listen));
    conn.setFastPing(true);
    await until(() => seen.length >= 3, what: 'fast pings');
    conn.setFastPing(false);
    expect(conn.quietPing, isNotNull);
    expect(conn.quietPing!, lessThanOrEqualTo(seen.reduce(min)));
  });

  test('tmux history, processes and listening ports', () async {
    expect(await conn.history('pult-0001'), contains('earlier output 2'));
    expect(await conn.history('not a session; rm -rf /'), '');
    final procs = await conn.processes();
    expect(procs.first.command, startsWith('/usr/bin/dockerd'));
    expect(procs.first.cpu, 38.5);
    expect(procs.map((p) => p.pid), containsAll([812, 2210, 1203, 1]));
    final ports = await Tunnels(conn).scan();
    expect(ports.map((p) => p.port), [443, 5432, 18080]);
    expect(ports.firstWhere((p) => p.port == 5432).localOnly, isTrue);
    expect(ports.firstWhere((p) => p.port == 443).proc, 'nginx');
  });

  test('SSH tunnel: a server-side web page opens on the phone', () async {
    // The "server's" web panel: on the mock, the server is this machine.
    final web = await HttpServer.bind(InternetAddress.loopbackIPv4, 18080);
    web.listen((r) {
      r.response.write('salom ${r.uri.path}');
      r.response.close();
    });
    addTearDown(() => web.close(force: true));
    final tunnels = Tunnels(conn);
    addTearDown(tunnels.closeAll);
    final t = await tunnels.add('127.0.0.1', 18080, local: 18182);
    expect(t.localPort, 18182);
    final http = HttpClient();
    addTearDown(() => http.close(force: true));
    final res = await (await http.getUrl(Uri.parse('${t.url}/panel'))).close();
    expect(await res.transform(utf8.decoder).join(), 'salom /panel');
    await until(() => t.total == 1, what: 'counted');
    // The same port twice: the second one gets a free port and says so.
    final busy = await ServerSocket.bind(InternetAddress.loopbackIPv4, 18183);
    addTearDown(busy.close);
    // A port where nothing listens on the "server" (free right now on this machine).
    final probe = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final dead = probe.port;
    await probe.close();
    final t2 = await tunnels.add('127.0.0.1', dead, local: 18183);
    expect(t2.localPort, isNot(18183));
    expect(t2.error, contains('band edi'));
    // A clear error, not a hang.
    final res2 = await HttpClient().getUrl(Uri.parse(t2.url)).then((r) => r.close()).then<Object?>((r) => r, onError: (Object e) => e);
    expect(res2, isNot(isA<HttpClientResponse>()));
    await until(() => t2.error != null && t2.error!.contains('$dead-portda hech narsa'), what: 'refused message');
  });

  test('files: list, mkdir, write, read, rename, delete', () async {
    final f = FilesController(conn);
    await f.init(null);
    expect(f.cwd, '/home/demo');
    expect(f.visible.map((e) => e.name), containsAll(['backups', 'scripts', 'docker-compose.yml']));
    expect(f.visible.first.isDir, isTrue); // folders first

    await f.mkdir('t-dir');
    await f.writeText('/home/demo/t-dir/a.txt', 'salom\nдунё ✓\n');
    await f.go('/home/demo/t-dir');
    final a = f.visible.single;
    expect(await f.readText(a), 'salom\nдунё ✓\n');
    await f.rename(a, 'b.txt');
    await f.refresh();
    expect(f.visible.single.name, 'b.txt');
    await f.up();
    await f.delete([f.visible.firstWhere((e) => e.name == 't-dir')]);
    await f.refresh();
    expect(f.visible.any((e) => e.name == 't-dir'), isFalse);
  });

  test('download survives a dropped link and resumes (byte-exact)', () async {
    final xfer = Transfers();
    final out = Directory('${tmp.path}/dl')..createSync();
    final job = xfer.download(conn, ['/home/demo/backups'], out.path);
    var cut = false;
    final sawWaiting = Completer<void>();
    xfer.addListener(() {
      if (!cut && job.doneBytes > 2 * 1024 * 1024) {
        cut = true;
        conn.exec('echo MOCK_OUTAGE 3').catchError((_) => execFailed);
      }
      if (job.state == JobState.waiting && !sawWaiting.isCompleted) sawWaiting.complete();
    });
    await until(() => !job.active, timeout: const Duration(seconds: 90), what: 'download');
    expect(job.state, JobState.done, reason: job.error);
    expect(sawWaiting.isCompleted, isTrue, reason: 'the link should have dropped mid-transfer');
    for (final name in ['app-2026-10-20.sql.gz', 'app-2026-10-21.sql.gz']) {
      expect(sha('${out.path}/backups/$name'), sha('$mockRoot/home/demo/backups/$name'), reason: name);
    }
    expect(conn.isReady, isTrue);
    expect(conn.shells.first.channels, greaterThanOrEqualTo(2), reason: 'shell re-attached after reconnect');
  }, timeout: const Timeout(Duration(minutes: 2)));

  test('upload (byte-exact)', () async {
    final xfer = Transfers();
    final local = File('${tmp.path}/up.bin');
    final r = Random(7);
    local.writeAsBytesSync(List.generate(3 * 1024 * 1024 + 123, (_) => r.nextInt(256)));
    final job = xfer.upload(conn, [local.path], '/home/demo');
    await until(() => !job.active, timeout: const Duration(seconds: 60), what: 'upload');
    expect(job.state, JobState.done, reason: job.error);
    expect(sha('$mockRoot/home/demo/up.bin'), sha(local.path));
    File('$mockRoot/home/demo/up.bin').deleteSync();
  });

  test('server file ops: copy, unique names, move, archive, extract, search', () async {
    final ops = FsOps(conn);
    final f = FilesController(conn);
    const play = '/home/demo/mplay';
    final local = Directory('$mockRoot$play');
    if (local.existsSync()) local.deleteSync(recursive: true);
    local.createSync(recursive: true);
    Directory('$mockRoot$play/src/sub').createSync(recursive: true);
    Directory('$mockRoot$play/dst').createSync();
    await f.writeText('$play/src/a.txt', 'alpha\nNEEDLE here\n');
    await f.writeText('$play/src/sub/b.conf', 'listen 80;\n');

    await ops.copy([const Item('$play/src', 'dir')], '$play/dst');
    expect(File('$mockRoot$play/dst/src/sub/b.conf').existsSync(), isTrue);
    await ops.copy([const Item('$play/src', 'dir')], '$play/dst');
    expect(Directory('$mockRoot$play/dst/src (1)').existsSync(), isTrue);
    await expectLater(ops.copy([const Item('$play/src', 'dir')], '$play/src/sub'), throwsA(isA<ConnError>()));
    await ops.copy([const Item('$play/dst/src (1)', 'dir')], play, move: true);
    expect(Directory('$mockRoot$play/src (1)').existsSync() && !Directory('$mockRoot$play/dst/src (1)').existsSync(), isTrue);

    final archive = await ops.compress(play, ['src'], 'backup', 'tar.gz');
    expect(archive, 'backup.tar.gz');
    expect(await ops.extract('$play/backup.tar.gz', 'folder'), 'backup');
    expect(File('$mockRoot$play/backup/src/a.txt').readAsStringSync(), 'alpha\nNEEDLE here\n');

    final byName = await ops.search(play, 'B.CONF', 'name');
    expect(byName.any((h) => h.path == '$play/src/sub/b.conf' && h.type == 'file'), isTrue);
    final byText = await ops.search(play, 'needle', 'content');
    expect(byText.any((h) => h.path == '$play/src/a.txt' && h.line == 2 && h.text!.contains('NEEDLE')), isTrue);
    expect(uniqueName({'a.tar.gz'}, 'a.tar.gz', false), 'a (1).tar.gz');
  }, skip: const bool.fromEnvironment('MOCK_SH') ? false : 'needs the mock server with MOCK_SH (real cp/tar/find)');

  test('AI agents: detection, agy usage, Claude bridge, panes', () async {
    // The mock has a fake `claude` / `agy` (dev/mock-server.js).
    final home = '$mockRoot/home/demo';
    final settings = File('$home/.claude/settings.json');
    for (final d in ['$home/.claude', '$home/.pult']) {
      if (Directory(d).existsSync()) Directory(d).deleteSync(recursive: true);
    }
    settings.createSync(recursive: true);
    const user = '{\n  "model": "opus",\n  "statusLine": { "type": "command", "command": "~/.claude/my-status.sh", "padding": 1 }\n}\n';
    settings.writeAsStringSync(user);

    final a = Agents(conn);
    addTearDown(a.dispose);
    await until(() => a.detected, what: 'detect');
    expect(a.claudePath, '/home/demo/.local/bin/claude');
    expect(a.agyPath, '/home/demo/.local/bin/agy');
    expect(a.bridged, isFalse);

    await a.refreshAgy();
    expect(a.agyError, isNull, reason: a.agyError?.message);
    expect(a.agyUsage!.map((g) => g.name), ['Gemini Models', 'Claude and GPT models']);

    await a.installClaude();
    final s = jsonDecode(settings.readAsStringSync()) as Map<String, dynamic>;
    expect(s['statusLine']['command'], bridgeCommand);
    expect(s['statusLine']['padding'], 1);
    expect(s['model'], 'opus');
    expect(s['preferredNotifChannel'], 'terminal_bell');
    expect(File('$home/.pult/claude-statusline.next').readAsStringSync().trim(), '~/.claude/my-status.sh');
    expect(File('$home/.claude/settings.json.pult-backup').readAsStringSync(), user);
    expect(File('$home/.pult/bin/claude-statusline').readAsStringSync(), bridgeScript);

    // A snapshot written by the status line reaches us through the monitor.
    final t = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    File('$home/.pult/state/claude.pult-0009.json')
      ..createSync(recursive: true)
      ..writeAsStringSync('{"t":$t,"d":{"model":{"display_name":"Opus 5.5"},"context_window":{"used_percentage":31},'
          '"rate_limits":{"five_hour":{"used_percentage":64,"resets_at":${t + 3600}},"seven_day":{"used_percentage":20,"resets_at":${t + 86400}}}}}\n');
    await until(() => a.claudeUsage != null, what: 'usage snapshot');
    expect(a.claudeUsage!.five!.used, closeTo(0.64, 1e-9));
    expect(a.claudeSessions['pult-0009']!.ctx, 31);

    // A terminal that starts claude is recognised.
    final sh = await conn.openShell();
    await until(() => a.panes.containsKey(sh.session), what: 'pane listed');
    sh.write('claude\r');
    await until(() => a.panes[sh.session]?.agent == Agent.claude, what: 'claude pane');
    sh.newline(); // LF reaches the agent as "new line", not Enter
    sh.write('/exit\r');
    await until(() => a.panes[sh.session]?.agent == null, what: 'claude exited');
    await conn.closeShell(sh);

    await a.removeClaude();
    expect(jsonDecode(settings.readAsStringSync()), jsonDecode(user));
    expect(File('$home/.pult/bin/claude-statusline').existsSync(), isFalse);
    expect(File('$home/.pult/state/claude.pult-0009.json').existsSync(), isFalse);

    settings.writeAsStringSync('{ "model": "opus", }');
    await expectLater(a.installClaude(), throwsA(isA<ConnError>()));
    expect(settings.readAsStringSync(), '{ "model": "opus", }');
  }, timeout: const Timeout(Duration(minutes: 1)));

  test('generated ed25519 key parses and matches its public line', () {
    final k = generateEd25519();
    final pairs = SSHKeyPair.fromPem(k.privatePem);
    expect(pairs.single.type, 'ssh-ed25519');
    expect(k.publicLine.startsWith(publicLineOf(k.privatePem)!), isTrue);
  });
}
