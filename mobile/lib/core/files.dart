// SFTP directory browsing and file operations for one connection.

import 'dart:convert';

import 'package:dartssh2/dartssh2.dart';
import 'package:flutter/foundation.dart';

import 'connection.dart';
import 'format.dart';
import 'fsops.dart';

enum EntryType { dir, file, link, other }

class Entry {
  Entry({required this.name, required this.type, this.target, this.size = 0, this.mtime = 0, this.mode = 0, this.owner = ''});
  final String name;
  final EntryType type;
  final EntryType? target; // for links: what they point to (null = broken)
  final int size, mtime, mode;
  final String owner;

  bool get isDir => type == EntryType.dir || (type == EntryType.link && target == EntryType.dir);
  bool get hidden => name.startsWith('.');
}

EntryType _type(SftpFileAttrs a) => switch (a.mode?.type) {
      SftpFileType.directory => EntryType.dir,
      SftpFileType.regularFile => EntryType.file,
      SftpFileType.symbolicLink => EntryType.link,
      _ => EntryType.other,
    };

const maxEditBytes = 5 * 1024 * 1024;

class FilesController extends ChangeNotifier {
  FilesController(this.conn);
  final Connection conn;

  String cwd = '';
  List<Entry> entries = [];
  bool loading = false;
  bool loaded = false;
  String? error;
  bool showHidden = false;
  final history = <String>[];

  /// Multi-select mode (long press): names in the current folder.
  final selected = <String>{};
  bool get selecting => selected.isNotEmpty;

  void toggleSelect(String name) {
    selected.contains(name) ? selected.remove(name) : selected.add(name);
    notifyListeners();
  }

  void selectAll() {
    selected.addAll(visible.map((e) => e.name));
    notifyListeners();
  }

  void clearSelection() {
    if (selected.isEmpty) return;
    selected.clear();
    notifyListeners();
  }

  List<Entry> get selectedEntries => entries.where((e) => selected.contains(e.name)).toList();

  List<Entry> get visible {
    final list = entries.where((e) => showHidden || !e.hidden).toList();
    list.sort((a, b) {
      if (a.isDir != b.isDir) return a.isDir ? -1 : 1;
      return a.name.toLowerCase().compareTo(b.name.toLowerCase());
    });
    return list;
  }

  Future<void> init(String? startDir) async {
    if (loaded || loading) return;
    var start = (startDir ?? '').trim();
    final home = conn.home ?? '';
    if (start.isEmpty) start = home.isNotEmpty ? home : '.';
    if (start.startsWith('~')) start = home + start.substring(1);
    await go(start, record: false);
  }

  Future<bool> go(String path, {bool record = true}) async {
    loading = true;
    notifyListeners();
    try {
      final sftp = await conn.sftp();
      final real = await sftp.absolute(path);
      final names = await sftp.listdir(real);
      final list = <Entry>[];
      for (final n in names) {
        if (n.filename == '.' || n.filename == '..') continue;
        final t = _type(n.attr);
        EntryType? target;
        if (t == EntryType.link) {
          try {
            target = _type(await sftp.stat(pJoin(real, n.filename)));
          } catch (_) {}
        }
        final parts = n.longname.split(RegExp(r'\s+'));
        list.add(Entry(
          name: n.filename,
          type: t,
          target: target,
          size: n.attr.size ?? 0,
          mtime: n.attr.modifyTime ?? 0,
          mode: (n.attr.mode?.value ?? 0) & 0xFFF,
          owner: parts.length > 2 ? parts[2] : '${n.attr.userID ?? ''}',
        ));
      }
      if (record && cwd.isNotEmpty && real != cwd) history.add(cwd);
      if (real != cwd) selected.clear();
      cwd = real;
      selected.removeWhere((n) => !list.any((e) => e.name == n));
      entries = list;
      loaded = true;
      error = null;
      return true;
    } catch (e) {
      if (!loaded) error = classify(e).message;
      rethrow;
    } finally {
      loading = false;
      notifyListeners();
    }
  }

  Future<void> refresh() => cwd.isEmpty ? Future.value() : go(cwd, record: false).then((_) {}, onError: (_) {});

  Future<bool> up() async => cwd != '/' && cwd.isNotEmpty ? go(pDirname(cwd)) : false;

  Future<bool> back() async {
    if (history.isEmpty) return false;
    return go(history.removeLast(), record: false);
  }

  String path(Entry e) => pJoin(cwd, e.name);

  Future<void> mkdir(String name) async => (await conn.sftp()).mkdir(pJoin(cwd, name));

  Future<void> touch(String name) async {
    final f = await (await conn.sftp()).open(pJoin(cwd, name), mode: SftpFileOpenMode.create | SftpFileOpenMode.write | SftpFileOpenMode.exclusive);
    await f.close();
  }

  Future<void> rename(Entry e, String name) async => (await conn.sftp()).rename(path(e), pJoin(cwd, name));

  Future<void> chmod(Entry e, int mode) async {
    await (await conn.sftp()).setStat(path(e), SftpFileAttrs(mode: SftpFileMode.value(mode)));
  }

  Future<void> delete(List<Entry> items) async {
    final sftp = await conn.sftp();
    Future<void> tree(String p) async {
      for (final n in await sftp.listdir(p)) {
        if (n.filename == '.' || n.filename == '..') continue;
        final child = pJoin(p, n.filename);
        if (_type(n.attr) == EntryType.dir) {
          await tree(child);
        } else {
          await sftp.remove(child);
        }
      }
      await sftp.rmdir(p);
    }

    for (final e in items) {
      final p = path(e);
      if (e.type != EntryType.dir) {
        await sftp.remove(p);
        continue;
      }
      // rm -rf is far faster for big trees; SFTP walk is the portable fallback.
      final r = await conn.exec('rm -rf -- ${shq(p)}', const Duration(minutes: 2)).catchError((_) => execFailed);
      if (r.code == 0) continue;
      await tree(p);
    }
  }

  late final ops = FsOps(conn);

  Future<String> readText(Entry e) => readPath(path(e), size: e.size);

  Future<String> readPath(String p, {int? size}) async {
    final sftp = await conn.sftp();
    size ??= (await sftp.stat(p)).size ?? 0;
    if (size > maxEditBytes) throw ConnError('TOO_BIG', 'Fayl tahrirlash uchun juda katta (5 MB dan ortiq)');
    final f = await sftp.open(p);
    try {
      final Uint8List data = await f.readBytes();
      if (data.contains(0)) throw ConnError('BINARY', 'Bu matnli fayl emas');
      return utf8.decode(data, allowMalformed: true);
    } finally {
      await f.close();
    }
  }

  Future<void> writeText(String p, String text) async {
    final f = await (await conn.sftp()).open(p, mode: SftpFileOpenMode.create | SftpFileOpenMode.write | SftpFileOpenMode.truncate);
    try {
      await f.writeBytes(Uint8List.fromList(utf8.encode(text)));
    } finally {
      await f.close();
    }
  }
}
