// Renders the main screens to PNG (phone size) for design review:
//   flutter test test/screens_test.dart --update-goldens

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pult/app_state.dart';
import 'package:pult/core/connection.dart';
import 'package:pult/core/files.dart';
import 'package:pult/core/fsops.dart';
import 'package:pult/ui/editor_page.dart';
import 'package:pult/ui/files_pane.dart';
import 'package:pult/core/store.dart';
import 'package:pult/theme.dart';
import 'package:pult/ui/home_page.dart';
import 'package:pult/ui/server_form.dart';
import 'package:pult/ui/session_page.dart';

Future<void> loadFonts() async {
  Future<ByteData> asset(String p) => rootBundle.load(p);
  await (FontLoader('Inter')
        ..addFont(asset('assets/fonts/Inter-Regular.ttf'))
        ..addFont(asset('assets/fonts/Inter-Medium.ttf'))
        ..addFont(asset('assets/fonts/Inter-SemiBold.ttf')))
      .load();
  await (FontLoader('JetBrainsMono')
        ..addFont(asset('assets/fonts/JetBrainsMono-Regular.ttf'))
        ..addFont(asset('assets/fonts/JetBrainsMono-Bold.ttf')))
      .load();
  final flutterRoot = Platform.environment['FLUTTER_ROOT'] ?? '../.tools/flutter';
  final icons = File('$flutterRoot/bin/cache/artifacts/material_fonts/MaterialIcons-Regular.otf');
  await (FontLoader('MaterialIcons')..addFont(Future.value(ByteData.sublistView(icons.readAsBytesSync())))).load();
}

class NoPrompts implements Prompter {
  @override
  dynamic noSuchMethod(Invocation i) => Future.value(null);
}

const demoTerminal = 'Welcome to Ubuntu 24.04.1 LTS (GNU/Linux 6.8.0-45-generic x86_64)\r\n\r\n'
    '\x1b[2m  System load:  0.21    Processes:  142\r\n  Usage of /:   44.1%   Memory:     38%\x1b[0m\r\n\r\n'
    '\x1b[1;32mroot@acme-prod\x1b[0m:\x1b[1;34m~\x1b[0m\$ docker ps --format "{{.Names}}  {{.Status}}"\r\n'
    'api       Up 12 days\r\npostgres  Up 12 days\r\nnginx     Up 12 days\r\n'
    '\x1b[1;32mroot@acme-prod\x1b[0m:\x1b[1;34m~\x1b[0m\$ systemctl status nginx\r\n'
    '\x1b[32m●\x1b[0m nginx.service - A high performance web server\r\n'
    '   Active: \x1b[1;32mactive (running)\x1b[0m since Thu; 12 days ago\r\n'
    '   Memory: 6.1M\r\n'
    '\x1b[1;32mroot@acme-prod\x1b[0m:\x1b[1;34m~\x1b[0m\$ df -h /\r\n'
    'Filesystem  Size  Used Avail Use% Mounted on\r\n/dev/sda1    40G   17G   21G  44% /\r\n'
    '\x1b[1;32mroot@acme-prod\x1b[0m:\x1b[1;34m~\x1b[0m\$ ';

const demoYaml = '''# API + database
services:
  api:
    image: ghcr.io/acme/api:2.4.1
    restart: unless-stopped
    env_file: .env
    ports:
      - "8080:8080"
    depends_on: [db]
  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: \${DB_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata: {}
''';

const demoShell = r'''#!/usr/bin/env bash
set -euo pipefail

# Deploy the API: pull, build, restart.
cd ~/apps/api
git pull --ff-only
docker compose up -d --build
echo "Deployed at $(date +%H:%M)"
''';

void main() {
  late Store store;
  late AppState app;

  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
    await loadFonts();
    final tmp = await Directory.systemTemp.createTemp('pult-shots-');
    store = Store(tmp, MemorySecrets());
    await store.load();
    final now = DateTime.now().millisecondsSinceEpoch;
    for (final s in [
      Server(id: 'a', name: 'acme-prod', host: '45.12.80.4', username: 'root', auth: 'key', hasKey: true, lastUsed: now - 2 * 3600000),
      Server(id: 'b', name: 'db-01', host: 'db.acme.uz', username: 'postgres', auth: 'key', hasKey: true, lastUsed: now - 26 * 3600000),
      Server(id: 'c', name: 'staging', host: '10.0.8.21', port: 2200, username: 'deploy', lastUsed: now - 5 * 86400000),
      Server(id: 'd', name: 'vpn-gateway', host: 'vpn.acme.uz', username: 'root'),
    ]) {
      await store.saveServer(s);
    }
    app = AppState(store);
  });

  Future<void> shoot(WidgetTester t, Widget home, String name, {Pal pal = Pal.dark, double keyboard = 0}) async {
    t.view.physicalSize = const Size(1170, 2532);
    t.view.devicePixelRatio = 3;
    t.view.padding = const FakeViewPadding(top: 141, bottom: 102);
    t.view.viewInsets = FakeViewPadding(bottom: keyboard * 3);
    final app = MaterialApp(debugShowCheckedModeBanner: false, theme: buildTheme(pal), home: home);
    if (home is EditorPage) {
      // The code editor highlights in a background isolate: build it in real time.
      await t.runAsync(() async {
        await t.pumpWidget(app);
        await Future<void>.delayed(const Duration(seconds: 3));
      });
    } else {
      await t.pumpWidget(app);
    }
    await t.pump(const Duration(milliseconds: 400));
    // Like a real shell: output arrives after the view has sized the terminal.
    if (home is SessionPage) home.session.active?.terminal.write(demoTerminal);
    await t.pump(const Duration(milliseconds: 400));
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('shots/$name.png'));
    await t.pumpWidget(const SizedBox()); // dispose timers
    await t.pump(const Duration(seconds: 2));
  }

  Session demoSession() {
    final server = store.server('a')!;
    final conn = Connection(server.copy(), store: store, prompter: NoPrompts())
      ..state = ConnState.ready
      ..everReady = true
      ..hasTmux = true
      ..home = '/root';
    conn.stats
      ..rtt = 31
      ..cpu = 0.12
      ..memUsed = 1600 * 1024 * 1024
      ..memTotal = 3900 * 1024 * 1024
      ..diskUsed = 17 * 1024 * 1024 * 1024
      ..diskTotal = 40 * 1024 * 1024 * 1024;
    final sh = RemoteShell(conn, session: 'pult-0001');
    conn.shells
      ..add(sh)
      ..add(RemoteShell(conn, session: 'pult-0002'));
    final s = Session(app, server, conn)..active = sh;
    final f = s.files
      ..cwd = '/root/apps/api'
      ..loaded = true;
    final day = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    f.entries = [
      Entry(name: 'src', type: EntryType.dir, mtime: day - 3600),
      Entry(name: 'logs', type: EntryType.dir, mtime: day - 600),
      Entry(name: 'current', type: EntryType.link, target: EntryType.dir, mtime: day - 300),
      Entry(name: 'Pult.apk', type: EntryType.file, size: 38063104, mtime: day - 1800),
      Entry(name: 'Pult Setup 1.0.0.exe', type: EntryType.file, size: 115448832, mtime: day - 1900),
      Entry(name: 'backup-2026-10-21.tar.gz', type: EntryType.file, size: 25165824, mtime: day - 3600 * 20),
      Entry(name: 'deploy.sh', type: EntryType.file, size: 812, mtime: day - 86400 * 2, mode: 0x1ED),
      Entry(name: 'docker-compose.yml', type: EntryType.file, size: 1234, mtime: day - 7200),
      Entry(name: 'index.js', type: EntryType.file, size: 4420, mtime: day - 7300),
      Entry(name: 'logo.png', type: EntryType.file, size: 48211, mtime: day - 86400 * 5),
      Entry(name: 'demo.mp4', type: EntryType.file, size: 7340032, mtime: day - 86400 * 6),
      Entry(name: 'dump.sql', type: EntryType.file, size: 2097152, mtime: day - 86400 * 7),
      Entry(name: 'server.pem', type: EntryType.file, size: 1704, mtime: day - 86400 * 30),
      Entry(name: 'README.md', type: EntryType.file, size: 3020, mtime: day - 86400 * 40),
    ];
    return s;
  }

  testWidgets('home', (t) async => shoot(t, HomePage(app: app), 'home'));
  testWidgets('home light', (t) async => shoot(t, HomePage(app: app), 'home-light', pal: Pal.light));
  testWidgets('form', (t) async => shoot(t, ServerFormPage(store: store), 'form'));
  testWidgets('form key', (t) async => shoot(t, ServerFormPage(store: store, server: store.server('a')), 'form-key'));
  testWidgets('terminal', (t) async => shoot(t, SessionPage(app: app, session: demoSession()), 'terminal'));
  testWidgets('terminal keyboard', (t) async => shoot(t, SessionPage(app: app, session: demoSession()), 'terminal-keys', keyboard: 300));
  testWidgets('files', (t) async => shoot(t, SessionPage(app: app, session: demoSession()..tab = 1), 'files'));
  testWidgets('files light', (t) async => shoot(t, SessionPage(app: app, session: demoSession()..tab = 1), 'files-light', pal: Pal.light));
  testWidgets('files kinds', (t) async {
    final s = demoSession()..tab = 1;
    s.files.entries = s.files.entries.where((e) => !e.isDir && !const {'index.js', 'docker-compose.yml', 'deploy.sh'}.contains(e.name)).toList();
    await shoot(t, SessionPage(app: app, session: s), 'files-kinds');
  });
  testWidgets('files select', (t) async {
    final s = demoSession()..tab = 1;
    s.files.selected.addAll(['Pult.apk', 'logo.png', 'dump.sql']);
    await shoot(t, SessionPage(app: app, session: s), 'files-select');
  });
  testWidgets('files clip', (t) async {
    final s = demoSession()..tab = 1;
    app.fileClip = FileClip(s.conn, false, [const Item('/root/scripts/install.sh', 'file'), const Item('/root/scripts/deploy.sh', 'file')]);
    await shoot(t, SessionPage(app: app, session: s), 'files-clip');
    app.fileClip = null;
  });
  testWidgets('editor', (t) async {
    final s = demoSession();
    await shoot(t, EditorPage(files: s.files, path: '/root/apps/api/docker-compose.yml', text: demoYaml), 'editor');
  });
  testWidgets('editor light', (t) async {
    final s = demoSession();
    await shoot(t, EditorPage(files: s.files, path: '/root/deploy.sh', text: demoShell), 'editor-light', pal: Pal.light);
  });
  testWidgets('properties', (t) async {
    final s = demoSession()..tab = 1;
    t.view.physicalSize = const Size(1170, 2532);
    t.view.devicePixelRatio = 3;
    t.view.padding = const FakeViewPadding(top: 141, bottom: 102);
    await t.pumpWidget(MaterialApp(debugShowCheckedModeBanner: false, theme: buildTheme(Pal.dark), home: SessionPage(app: app, session: s)));
    await t.pump(const Duration(milliseconds: 300));
    showProperties(t.element(find.byType(SessionPage)), s, s.files.entries.firstWhere((e) => e.name == 'Pult.apk'));
    await t.pump(const Duration(milliseconds: 500));
    await t.pump(const Duration(milliseconds: 500));
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('shots/properties.png'));
    await t.pumpWidget(const SizedBox());
    await t.pump(const Duration(seconds: 2));
  });
  testWidgets('reconnecting', (t) async {
    final s = demoSession();
    s.conn
      ..state = ConnState.reconnecting
      ..retryAt = DateTime.now().add(const Duration(seconds: 3));
    await shoot(t, SessionPage(app: app, session: s), 'reconnecting');
  });
}
