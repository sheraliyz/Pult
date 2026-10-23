// App-wide state: open sessions, transfers, and keeping connections alive
// across app pauses and network switches.

import 'dart:async';
import 'dart:io';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';

import 'core/connection.dart';
import 'core/files.dart';
import 'core/fsops.dart';
import 'core/store.dart';
import 'core/transfers.dart';
import 'ui/prompts.dart';
import 'ui/widgets.dart';

/// One open server: a connection plus what the screen shows for it.
class Session extends ChangeNotifier {
  Session(this.app, this.server, this.conn) : files = FilesController(conn) {
    conn.addListener(_onConn);
    conn.onShellExit = _onShellExit;
    conn.onClipboard = (text) {
      Clipboard.setData(ClipboardData(text: text));
      final ctx = app.navKey.currentContext;
      if (ctx != null) toast(ctx, 'Nusxalandi');
    };
  }

  final AppState app;
  Server server;
  final Connection conn;
  final FilesController files;
  int tab = 0; // 0 = terminal, 1 = files
  RemoteShell? active;
  bool _restored = false;
  ConnState _last = ConnState.connecting;

  void _onConn() {
    final s = conn.state;
    if (s == ConnState.ready && !_restored) {
      _restored = true;
      _restore();
    } else if (s == ConnState.ready && _last != ConnState.ready && files.loaded) {
      files.refresh();
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
    notifyListeners();
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

  void init() {
    WidgetsBinding.instance.addObserver(this);
    _net = Connectivity().onConnectivityChanged.listen((_) => _nudge());
    transfers.onDone = (j) {
      final ctx = navKey.currentContext;
      if (ctx != null) toast(ctx, '${j.upload ? 'Yuklandi' : 'Yuklab olindi'}: ${j.name}');
      if (j.upload) {
        for (final s in sessions) {
          if (s.conn == j.conn) s.files.refresh();
        }
      }
    };
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _nudge();
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
    notifyListeners();
    return s;
  }

  Future<void> close(Session s) async {
    sessions.remove(s);
    transfers.cancelFor(s.conn);
    notifyListeners();
    await s.conn.close();
    s.dispose();
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
