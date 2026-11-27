// SSH tunnels (local port forwarding): a web panel or API that the server only
// serves on its own localhost opens in the phone's browser at
// http://127.0.0.1:<port>. Each tunnel listens on the phone and opens a
// direct-tcpip channel over the existing SSH link for every connection, so a
// reconnect is picked up by the next request. Same as the desktop app.

import 'dart:async';
import 'dart:io';

import 'package:dartssh2/dartssh2.dart';
import 'package:flutter/foundation.dart';

import 'connection.dart';

bool validPort(int? p) => p != null && p > 0 && p < 65536;
bool validHost(String h) => RegExp(r'^[\w.:-]{1,253}$').hasMatch(h);

class Tunnel {
  Tunnel(this.remoteHost, this.remotePort, this.wanted);
  final String remoteHost;
  final int remotePort;
  final int wanted; // the phone port asked for
  int localPort = 0;
  int active = 0, total = 0;
  String? error;
  ServerSocket? _server;
  final _sockets = <Socket>{};

  String get id => '$remoteHost:$remotePort';
  String get url => 'http://127.0.0.1:$localPort';

  /// What the server record keeps (same shape as the desktop app's).
  Map<String, dynamic> toJson() => {'remoteHost': remoteHost, 'remotePort': remotePort, 'localPort': wanted};
}

/// A port the server listens on (from `ss` / `netstat`).
class ListeningPort {
  const ListeningPort(this.port, this.addr, this.proc, this.localOnly);
  final int port;
  final String addr;
  final String? proc;
  final bool localOnly; // only on the server's own localhost
}

/// `ss -ltnp` / `netstat -ltnp` output → listening TCP ports (without SSH's 22).
List<ListeningPort> parseListening(String text) {
  final seen = <int, ListeningPort>{};
  for (final line in text.split('\n')) {
    final cols = line.trim().split(RegExp(r'\s+'));
    if (cols.length < 4 || !RegExp(r'^(LISTEN|tcp6?)$').hasMatch(cols[0])) continue;
    final m = RegExp(r'^(.*):(\d+)$').firstMatch(cols[3]);
    if (m == null) continue;
    final port = int.parse(m[2]!);
    final addr = m[1]!.replaceAll(RegExp(r'^\[|\]$'), '');
    final proc = RegExp(r'users:\(\("([^"]+)"').firstMatch(line)?[1] ?? RegExp(r'\d+/(\S+)\s*$').firstMatch(line)?[1];
    final local = RegExp(r'^(127\.|::1$|localhost)').hasMatch(addr);
    final prev = seen[port];
    seen[port] = prev == null ? ListeningPort(port, addr, proc, local) : ListeningPort(port, prev.addr, prev.proc ?? proc, prev.localOnly && local);
  }
  final list = seen.values.where((p) => p.port != 22).toList()..sort((a, b) => a.port.compareTo(b.port));
  return list;
}

/// Why a tunnel connection failed, in words (channel open failure reasons,
/// RFC 4254: 1 = forwarding is off on the server, 2 = nothing answers there).
String tunnelError(Object e, int port) {
  final s = '$e';
  final code = e is SSHChannelOpenError ? e.code : null;
  if (code == 1 || RegExp('administratively', caseSensitive: false).hasMatch(s)) return 'Serverda tunnel ochish taqiqlangan (sshd: AllowTcpForwarding)';
  if (code == 2 || RegExp('refused|connect failed', caseSensitive: false).hasMatch(s)) return 'Serverda $port-portda hech narsa ishlamayapti';
  return s;
}

class Tunnels extends ChangeNotifier {
  Tunnels(this.conn);
  final Connection conn;
  final list = <Tunnel>[];

  /// Called when the list changes (the session saves it with the server).
  VoidCallback? onSave;

  /// Forward 127.0.0.1:[local] on the phone → [host]:[port] as seen from the server.
  Future<Tunnel> add(String host, int port, {int? local, bool save = true}) async {
    final want = local ?? port;
    if (!validPort(port)) throw const FormatException('Server porti 1–65535 oralig‘ida bo‘lsin');
    if (!validPort(want)) throw const FormatException('Telefondagi port 1–65535 oralig‘ida bo‘lsin');
    if (!validHost(host)) throw const FormatException('Manzil noto‘g‘ri');
    final known = list.where((t) => t.remoteHost == host && t.remotePort == port).firstOrNull;
    if (known != null) return known;
    final t = Tunnel(host, port, want);
    ServerSocket server;
    try {
      server = await ServerSocket.bind(InternetAddress.loopbackIPv4, want);
    } on SocketException {
      // Busy (or below 1024 on Android): any free port, and say so.
      server = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
      t.error = '$want-port band edi — ${server.port} ishlatildi';
    }
    t._server = server;
    t.localPort = server.port;
    server.listen((sock) => _pipe(t, sock), onError: (_) {});
    list.add(t);
    notifyListeners();
    if (save) onSave?.call();
    return t;
  }

  Future<void> _pipe(Tunnel t, Socket sock) async {
    final client = conn.client;
    if (client == null) {
      sock.destroy();
      return;
    }
    try {
      final ch = await client.forwardLocal(t.remoteHost, t.remotePort);
      t.error = null;
      t.active++;
      t.total++;
      t._sockets.add(sock);
      notifyListeners();
      var ended = false;
      void done() {
        if (ended) return;
        ended = true;
        t.active = t.active > 0 ? t.active - 1 : 0;
        t._sockets.remove(sock);
        notifyListeners();
      }

      ch.stream.listen(sock.add, onDone: () {
        sock.destroy();
        done();
      }, onError: (_) {
        sock.destroy();
        done();
      });
      sock.listen(ch.sink.add, onDone: () {
        ch.close().catchError((_) {});
        done();
      }, onError: (_) {
        ch.destroy();
        done();
      });
    } catch (e) {
      t.error = tunnelError(e, t.remotePort);
      sock.destroy();
      notifyListeners();
    }
  }

  void remove(Tunnel t) {
    list.remove(t);
    t._server?.close();
    for (final s in t._sockets.toList()) {
      s.destroy();
    }
    notifyListeners();
    onSave?.call();
  }

  void closeAll() {
    for (final t in list.toList()) {
      t._server?.close();
      for (final s in t._sockets.toList()) {
        s.destroy();
      }
    }
    list.clear();
  }

  /// TCP ports the server listens on (ss, else netstat), with the program when visible.
  Future<List<ListeningPort>> scan() async {
    final r = await conn.exec('ss -ltnpH 2>/dev/null || ss -ltnH 2>/dev/null || netstat -ltnp 2>/dev/null || netstat -ltn 2>/dev/null; true', const Duration(seconds: 10));
    return parseListening(r.stdout);
  }
}
