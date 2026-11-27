// Unit tests for the pieces added with the redesign (no server needed):
//   flutter test test/parts_test.dart

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pult/core/connection.dart';
import 'package:pult/core/store.dart';
import 'package:pult/core/transfers.dart';
import 'package:pult/core/tunnels.dart';
import 'package:pult/core/update.dart';

void main() {
  test('app version matches pubspec.yaml', () {
    final m = RegExp(r'^version:\s*(\S+?)\+', multiLine: true).firstMatch(File('pubspec.yaml').readAsStringSync());
    expect(m?.group(1), kAppVersion);
  });

  test('newerVersion compares numerically', () {
    expect(newerVersion('1.10.0', '1.9.3'), isTrue);
    expect(newerVersion('v1.2.1', '1.2.0'), isTrue);
    expect(newerVersion('1.2.0', '1.2.0'), isFalse);
    expect(newerVersion('1.1.9', '1.2.0'), isFalse);
  });

  test('parseRelease finds the APK and only trusts GitHub links', () {
    final r = parseRelease({
      'tag_name': 'v1.3.0',
      'html_url': 'https://github.com/sheraliyz/Pult/releases/tag/1.3.0',
      'body': 'Yangi narsalar',
      'assets': [
        {'name': 'Pult.Setup.1.3.0.exe', 'browser_download_url': 'https://github.com/a.exe', 'size': 1},
        {'name': 'Pult.apk', 'browser_download_url': 'https://github.com/sheraliyz/Pult/releases/download/1.3.0/Pult.apk', 'size': 42},
      ],
    });
    expect(r.version, '1.3.0');
    expect(r.apkUrl, endsWith('/Pult.apk'));
    expect(r.apkSize, 42);
    final evil = parseRelease({
      'tag_name': '9.9.9',
      'assets': [
        {'name': 'Pult.apk', 'browser_download_url': 'https://evil.example/Pult.apk'},
      ],
    });
    expect(evil.apkUrl, isNull);
  });

  test('parsePs: busiest first, arguments kept', () {
    final list = parsePs(' 10 root 1.5 0.1 1000 /usr/sbin/cron -f\n 22 demo 55.0 3.0 2048 python3 train.py --epochs 3\n bad line\n');
    expect(list.map((p) => p.pid), [22, 10]);
    expect(list.first.command, 'python3 train.py --epochs 3');
    expect(list.first.rss, 2048 * 1024);
  });

  test('parseListening reads ss and netstat', () {
    final ss = parseListening('LISTEN 0 4096 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=5,fd=3))\nLISTEN 0 128 [::]:3000 [::]:*\nLISTEN 0 128 0.0.0.0:22 0.0.0.0:*\n');
    expect(ss.single.port, 3000);
    expect(ss.single.proc, 'node');
    expect(ss.single.localOnly, isFalse); // also on [::]
    final ns = parseListening('tcp 0 0 127.0.0.1:5432 0.0.0.0:* LISTEN 812/postgres\n');
    expect(ns.single.proc, 'postgres');
    expect(ns.single.localOnly, isTrue);
  });

  test('pacer: backs off when the ping rises, grows when it is quiet', () {
    final p = Pacer();
    for (var i = 0; i < 10; i++) {
      p.onPing(40, 40);
    }
    final grown = p.window;
    expect(grown, greaterThan(8));
    p.lastCut = 0;
    p.onPing(400, 40); // a full buffer
    expect(p.window, lessThan(grown));
    expect(p.window, greaterThanOrEqualTo(2));
    expect(Pacer(fast: () => true).limit, 64);
  });

  test('settings and servers keep the new fields', () {
    final s = Settings.fromJson({'signal': 'blue', 'body': 'sand', 'transferPace': 'fast', 'snippets': [{'name': 'Disk', 'cmd': 'df -h', 'run': false}, {'cmd': '  '}], 'openServers': ['a', 1], 'lastServer': 'a'});
    expect((s.signal, s.body, s.transferPace), ('blue', 'sand', 'fast'));
    expect(s.snippets.single.label, 'Disk');
    expect(s.snippets.single.run, isFalse);
    expect(s.openServers, ['a']);
    final back = Settings.fromJson(s.toJson());
    expect(back.toJson(), s.toJson());
    expect(Settings.fromJson({'signal': 'pink'}).signal, 'orange');
    expect(Settings().snippets.map((e) => e.cmd), contains('docker ps'));

    final server = Server.fromJson({'id': 'x', 'name': 'n', 'host': 'h', 'username': 'u', 'tunnels': [{'remotePort': 3000}, {'remotePort': 'bad'}]});
    expect(server.tunnels.single, {'remoteHost': '127.0.0.1', 'remotePort': 3000, 'localPort': 3000});
    expect(Server.fromJson(server.toJson()).tunnels, server.tunnels);
  });

  test('restored tmux history lands above an empty screen', () {
    final conn = Connection(Server(id: 'x', name: 'n', host: 'h', username: 'u'), store: Store(Directory.systemTemp, MemorySecrets()), prompter: _NoPrompts());
    final sh = RemoteShell(conn, session: 'pult-0001');
    sh.terminal.resize(40, 10);
    sh.writeHistory('one   \n\x1b[32mtwo\x1b[0m   \n');
    final text = sh.terminal.buffer.getText();
    expect(text, contains('one'));
    expect(text, contains('two'));
    expect(sh.terminal.buffer.cursorY, 0); // tmux paints the screen from the top
    expect(sh.terminal.buffer.lines.length, greaterThanOrEqualTo(12)); // the history is in the scrollback
  });
}

class _NoPrompts implements Prompter {
  @override
  dynamic noSuchMethod(Invocation i) => Future.value(null);
}
