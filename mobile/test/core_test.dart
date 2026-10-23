// Integration test of the SSH core against dev/mock-server.js (127.0.0.1:2222).
//   node dev/mock-server.js   (MOCK_ROOT=<dir>, MOCK_SLOW=60)
//   flutter test test/core_test.dart --dart-define=MOCK_ROOT=<dir>

import 'dart:async';
import 'dart:io';
import 'dart:math';

import 'package:crypto/crypto.dart' show sha256;
import 'package:dartssh2/dartssh2.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pult/core/connection.dart';
import 'package:pult/core/files.dart';
import 'package:pult/core/fsops.dart';
import 'package:pult/core/keys.dart';
import 'package:pult/core/store.dart';
import 'package:pult/core/transfers.dart';

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

  test('generated ed25519 key parses and matches its public line', () {
    final k = generateEd25519();
    final pairs = SSHKeyPair.fromPem(k.privatePem);
    expect(pairs.single.type, 'ssh-ed25519');
    expect(k.publicLine.startsWith(publicLineOf(k.privatePem)!), isTrue);
  });
}
