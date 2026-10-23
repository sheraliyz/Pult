// Upload / download engine. Many SFTP requests stay in flight (fast on mobile
// latency) and each file remembers the last contiguous byte that is safely on
// the other side: when the link drops, the job waits for the reconnect and
// resumes from there instead of starting over.

import 'dart:async';
import 'dart:io';
import 'dart:math';

import 'package:dartssh2/dartssh2.dart';
import 'package:flutter/foundation.dart';

import 'connection.dart';
import 'format.dart';

const _chunk = 32 * 1024;
const _inFlight = 48;
const _maxActive = 2;

enum JobState { queued, running, waiting, done, error, cancelled }

class _Cancelled implements Exception {}

class _File {
  _File(this.local, this.remote, this.size, {this.mtime});
  final String local, remote;
  final int size;
  final int? mtime;
  int done = 0;
}

class Job {
  Job(this.id, this.conn, this.upload, this.name, {this.localPaths = const [], this.remotePaths = const [], required this.dir});
  final String id;
  final Connection conn;
  final bool upload;
  final String name;
  final List<String> localPaths, remotePaths;
  final String dir; // remote dir for uploads, local dir for downloads
  String? target; // the downloaded file/folder, for "open"
  JobState state = JobState.queued;
  String? error;
  int totalBytes = 0, doneBytes = 0, finishedBytes = 0, doneFiles = 0;
  double speed = 0;
  bool cancelled = false;
  bool planning = false;
  final files = <_File>[];
  final open = <SftpFile>{};
  DateTime _sampleAt = DateTime.now();
  int _sampleBytes = 0;

  bool get active => state == JobState.queued || state == JobState.running || state == JobState.waiting;
  double get progress => totalBytes == 0 ? (state == JobState.done ? 1 : 0) : doneBytes / totalBytes;
}

/// Bytes [start, size) through `chunk(off, len)` with bounded concurrency;
/// `progress(confirmed)` gets the end of the contiguous completed prefix.
Future<void> _pipeline(int start, int size, Future<void> Function(int off, int len) chunk, void Function(int) progress, bool Function() cancelled) {
  final done = Completer<void>();
  var pos = start;
  var active = 0;
  final pending = SplayTreeSetLite();
  void finish([Object? err]) {
    if (done.isCompleted) return;
    err == null ? done.complete() : done.completeError(err);
  }

  void launch() {
    if (done.isCompleted) return;
    if (cancelled()) return finish(_Cancelled());
    while (active < _inFlight && pos < size) {
      final off = pos;
      final len = min(_chunk, size - off);
      pos += len;
      active++;
      pending.add(off);
      chunk(off, len).then((_) {
        active--;
        pending.remove(off);
        if (done.isCompleted) return;
        progress(pending.isEmpty ? pos : pending.first);
        if (pos >= size && active == 0) {
          finish();
        } else {
          launch();
        }
      }, onError: (Object e) => finish(e));
    }
    if (pos >= size && active == 0) finish();
  }

  launch();
  return done.future;
}

/// Minimal ordered set of ints (pending chunk offsets are few).
class SplayTreeSetLite {
  final _s = <int>{};
  void add(int v) => _s.add(v);
  void remove(int v) => _s.remove(v);
  bool get isEmpty => _s.isEmpty;
  int get first => _s.reduce(min);
}

class Transfers extends ChangeNotifier {
  final jobs = <Job>[];
  int _seq = 0;
  Timer? _emit;

  void Function(Job job)? onDone;

  int get activeCount => jobs.where((j) => j.active).length;

  void _changed({bool now = false}) {
    if (now) {
      _emit?.cancel();
      _emit = null;
      notifyListeners();
      return;
    }
    _emit ??= Timer(const Duration(milliseconds: 200), () {
      _emit = null;
      notifyListeners();
    });
  }

  static String _localName(String p) => p.split(RegExp(r'[\\/]')).lastWhere((s) => s.isNotEmpty, orElse: () => p);

  Job upload(Connection conn, List<String> localPaths, String remoteDir) {
    final name = localPaths.length == 1 ? _localName(localPaths.first) : '${localPaths.length} ta element';
    return _add(Job('x${++_seq}', conn, true, name, localPaths: localPaths, dir: remoteDir));
  }

  Job download(Connection conn, List<String> remotePaths, String localDir) {
    final name = remotePaths.length == 1 ? pBasename(remotePaths.first) : '${remotePaths.length} ta element';
    return _add(Job('x${++_seq}', conn, false, name, remotePaths: remotePaths, dir: localDir));
  }

  Job _add(Job j) {
    jobs.add(j);
    _changed(now: true);
    _pump();
    return j;
  }

  void cancel(Job j) {
    if (!j.active) return;
    j.cancelled = true;
    for (final f in j.open.toList()) {
      f.close().catchError((_) {});
    }
    if (j.state == JobState.queued) {
      j.state = JobState.cancelled;
      _changed(now: true);
    }
  }

  void cancelFor(Connection conn) {
    for (final j in jobs.where((j) => j.conn == conn).toList()) {
      cancel(j);
    }
  }

  void clearFinished() {
    jobs.removeWhere((j) => !j.active);
    _changed(now: true);
  }

  void _pump() {
    var slots = _maxActive - jobs.where((j) => j.state == JobState.running || j.state == JobState.waiting || j.planning).length;
    for (final j in jobs) {
      if (slots <= 0) break;
      if (j.state == JobState.queued && !j.planning && !j.cancelled) {
        slots--;
        _run(j);
      }
    }
  }

  Future<void> _run(Job j) async {
    j.planning = true;
    try {
      j.state = JobState.running;
      _changed(now: true);
      if (j.upload) {
        await _planUpload(j);
      } else {
        await _planDownload(j);
      }
      j.planning = false;
      _changed(now: true);
      for (final f in j.files) {
        await _move(j, f);
        j.finishedBytes += f.size;
        j.doneFiles++;
        j.doneBytes = j.finishedBytes;
        _changed();
      }
      j.state = JobState.done;
      j.speed = 0;
      _changed(now: true);
      onDone?.call(j);
    } catch (e) {
      if (e is _Cancelled || j.cancelled) {
        j.state = JobState.cancelled;
      } else {
        j.state = JobState.error;
        j.error = e is SftpStatusError ? e.message : e.toString();
      }
      j.speed = 0;
      _changed(now: true);
    } finally {
      j.planning = false;
      _pump();
    }
  }

  /* ---------------- planning ---------------- */

  Future<void> _planUpload(Job j) async {
    final sftp = await j.conn.sftp(wait: true);
    final dirs = <String>[];
    Future<void> walk(FileSystemEntity e, String remote) async {
      if (j.cancelled) throw _Cancelled();
      if (e is Directory) {
        dirs.add(remote);
        await for (final c in e.list(followLinks: true)) {
          await walk(c, pJoin(remote, _localName(c.path)));
        }
      } else if (e is File) {
        final size = await e.length();
        j.files.add(_File(e.path, remote, size));
        j.totalBytes += size;
      }
    }

    for (final p in j.localPaths) {
      final type = FileSystemEntity.typeSync(p);
      final ent = type == FileSystemEntityType.directory ? Directory(p) : File(p);
      await walk(ent, pJoin(j.dir, _localName(p)));
    }
    for (final d in dirs) {
      try {
        await sftp.mkdir(d);
      } catch (_) {
        final st = await sftp.stat(d).catchError((_) => SftpFileAttrs());
        if (st.mode?.type != SftpFileType.directory) rethrow;
      }
    }
  }

  Future<void> _planDownload(Job j) async {
    final sftp = await j.conn.sftp(wait: true);
    Future<void> walk(String remote, String local, SftpFileAttrs a) async {
      if (j.cancelled) throw _Cancelled();
      if (a.mode?.type == SftpFileType.directory) {
        await Directory(local).create(recursive: true);
        for (final e in await sftp.listdir(remote)) {
          if (e.filename == '.' || e.filename == '..') continue;
          var attrs = e.attr;
          if (attrs.mode?.type == SftpFileType.symbolicLink) {
            attrs = await sftp.stat(pJoin(remote, e.filename)).catchError((_) => SftpFileAttrs());
          }
          if (attrs.mode == null) continue;
          await walk(pJoin(remote, e.filename), '$local/${e.filename}', attrs);
        }
      } else {
        j.files.add(_File(local, remote, a.size ?? 0, mtime: a.modifyTime));
        j.totalBytes += a.size ?? 0;
      }
    }

    for (final r in j.remotePaths) {
      final a = await sftp.stat(r);
      final local = await _unique('${j.dir}/${pBasename(r)}');
      if (j.remotePaths.length == 1) j.target = local;
      await walk(r, local, a);
    }
    j.target ??= j.dir;
  }

  Future<String> _unique(String path) async {
    final dot = path.lastIndexOf('.');
    final slash = path.lastIndexOf('/');
    final hasExt = dot > slash + 1;
    final stem = hasExt ? path.substring(0, dot) : path;
    final ext = hasExt ? path.substring(dot) : '';
    var candidate = path;
    for (var i = 1; await FileSystemEntity.type(candidate) != FileSystemEntityType.notFound; i++) {
      candidate = '$stem ($i)$ext';
    }
    return candidate;
  }

  /* ---------------- moving bytes ---------------- */

  Future<void> _move(Job j, _File f) async {
    var transient = 0;
    for (;;) {
      if (j.cancelled) throw _Cancelled();
      try {
        final sftp = await j.conn.sftp(wait: true);
        if (j.state != JobState.running) {
          j.state = JobState.running;
          _changed(now: true);
        }
        if (j.upload) {
          await _put(sftp, j, f);
        } else {
          await _get(sftp, j, f);
        }
        return;
      } catch (e) {
        if (j.cancelled || e is _Cancelled) {
          await _discard(j, f);
          throw _Cancelled();
        }
        // Did the link drop under us? Then wait for it and resume.
        await Future<void>.delayed(const Duration(milliseconds: 400));
        if (!j.conn.isReady && !j.conn.closed && !j.conn.fatal) {
          j.state = JobState.waiting;
          _changed(now: true);
          await j.conn.whenReady();
          continue;
        }
        if (e is! SftpStatusError && transient++ < 3) continue;
        rethrow;
      }
    }
  }

  Future<void> _discard(Job j, _File f) async {
    if (!j.upload) {
      await File(f.local).delete().catchError((_) => File(f.local));
    } else if (j.conn.isReady && f.done < f.size) {
      final sftp = await j.conn.sftp().catchError((_) => throw _Cancelled());
      await sftp.remove(f.remote).catchError((_) {});
    }
  }

  Future<void> _put(SftpClient sftp, Job j, _File f) async {
    final raf = await File(f.local).open();
    final mode = f.done > 0
        ? SftpFileOpenMode.write
        : SftpFileOpenMode.create | SftpFileOpenMode.write | SftpFileOpenMode.truncate;
    final file = await sftp.open(f.remote, mode: mode);
    j.open.add(file);
    try {
      await _pipeline(f.done, f.size, (off, len) async {
        raf.setPositionSync(off);
        final data = raf.readSync(len);
        if (data.length != len) throw Exception('Fayl o‘qish paytida o‘zgardi');
        await file.writeBytes(data, offset: off);
      }, (c) => _progress(j, f, c), () => j.cancelled);
    } finally {
      j.open.remove(file);
      await file.close().catchError((_) {});
      await raf.close();
    }
  }

  Future<void> _get(SftpClient sftp, Job j, _File f) async {
    final out = await File(f.local).open(mode: f.done > 0 ? FileMode.append : FileMode.write);
    final file = await sftp.open(f.remote);
    j.open.add(file);
    try {
      await _pipeline(f.done, f.size, (off, len) async {
        final Uint8List data = await file.readBytes(length: len, offset: off);
        if (data.isEmpty) return; // file shrank on the server
        out.setPositionSync(off);
        out.writeFromSync(data);
      }, (c) => _progress(j, f, c), () => j.cancelled);
    } finally {
      j.open.remove(file);
      await file.close().catchError((_) {});
      await out.close();
    }
    if (f.mtime != null) {
      try {
        await File(f.local).setLastModified(DateTime.fromMillisecondsSinceEpoch(f.mtime! * 1000));
      } catch (_) {}
    }
  }

  void _progress(Job j, _File f, int confirmed) {
    f.done = confirmed;
    j.doneBytes = j.finishedBytes + confirmed;
    final now = DateTime.now();
    final dt = now.difference(j._sampleAt).inMilliseconds / 1000;
    if (dt >= 0.5) {
      final rate = (j.doneBytes - j._sampleBytes) / dt;
      j.speed = j.speed == 0 ? rate : j.speed * 0.6 + rate * 0.4;
      j._sampleAt = now;
      j._sampleBytes = j.doneBytes;
    }
    _changed();
  }
}
