// Server-side file operations: copy / move, archives, search, properties.
// They run as shell commands on the server (cp, mv, tar, zip, find, grep…),
// so big folders are copied in place, not through the phone. Same commands
// as the desktop app (src/main/fsops.js).

import 'package:dartssh2/dartssh2.dart';

import 'connection.dart';
import 'format.dart';

class Item {
  const Item(this.path, this.type);
  final String path;
  final String type; // dir | file | link
  String get name => pBasename(path);
}

class SearchHit {
  SearchHit({required this.path, required this.type, this.size, this.mtime, this.line, this.text});
  final String path;
  final String type;
  final int? size, mtime, line;
  final String? text;
}

class FileInfo {
  FileInfo({this.size, this.owner, this.group, this.mode, this.mtime, this.mime, this.real});
  final int? size, mode, mtime;
  final String? owner, group, mime, real;
}

final archiveRe = RegExp(r'(\.tar\.(?:gz|bz2|xz|zst|lz4)|\.tgz|\.tbz2?|\.txz|\.tar|\.zip|\.7z|\.rar|\.gz|\.bz2|\.xz|\.zst)$', caseSensitive: false);

bool isArchiveName(String name) => archiveRe.hasMatch(name);

/// "report.pdf" → "report (1).pdf"; keeps double extensions like .tar.gz.
String uniqueName(Set<String> taken, String name, bool isDir) {
  if (!taken.contains(name)) return name;
  var stem = name;
  var ext = '';
  final m = isDir ? null : RegExp(r'^(.+?)((?:\.tar)?\.[^./]{1,8})$').firstMatch(name);
  if (m != null) {
    stem = m.group(1)!;
    ext = m.group(2)!;
  }
  for (var i = 1;; i++) {
    final c = '$stem ($i)$ext';
    if (!taken.contains(c)) return c;
  }
}

class FsOps {
  FsOps(this.conn);
  final Connection conn;

  static const _hour = Duration(hours: 1);

  Future<Set<String>> _names(String dir) async {
    final sftp = await conn.sftp();
    return (await sftp.listdir(dir)).map((e) => e.filename).toSet();
  }

  Future<String> _run(String script, Duration timeout) async {
    final r = await conn.exec(script, timeout);
    if (r.code != 0) {
      final msg = '${r.stderr}\n${r.stdout}'.trim().split('\n').where((l) => l.trim().isNotEmpty).toList();
      throw ConnError(r.code == 127 ? 'NO_TOOL' : 'EXEC_FAILED', msg.isEmpty ? 'Server buyrug‘i bajarilmadi' : msg.skip(msg.length > 2 ? msg.length - 2 : 0).join(' · '));
    }
    return r.stdout;
  }

  /// Copy or move items into destDir. Name clashes get " (1)" — never overwrite.
  Future<int> copy(List<Item> items, String destDir, {bool move = false}) async {
    final taken = await _names(destDir);
    final cmds = <String>[];
    for (final it in items) {
      if (it.type == 'dir' && (destDir == it.path || destDir.startsWith('${it.path}/'))) {
        throw ConnError('SELF', '“${it.name}” papkasini o‘z ichiga ${move ? 'ko‘chirib' : 'nusxalab'} bo‘lmaydi');
      }
      if (move && pDirname(it.path) == destDir) continue;
      final name = uniqueName(taken, it.name, it.type == 'dir');
      taken.add(name);
      cmds.add('${move ? 'mv' : 'cp -a'} -- ${shq(it.path)} ${shq(pJoin(destDir, name))}');
    }
    if (cmds.isEmpty) return 0;
    try {
      await _run(cmds.join(' && '), _hour * 2);
    } on ConnError catch (e) {
      if (!move || e.code != 'NO_TOOL') rethrow;
      final sftp = await conn.sftp(); // no shell (e.g. Windows server): rename over SFTP
      for (final it in items) {
        await sftp.rename(it.path, pJoin(destDir, it.name));
      }
    }
    return cmds.length;
  }

  /// Pack names (inside cwd) into .zip or .tar.gz. Returns the archive name.
  Future<String> compress(String cwd, List<String> names, String archiveName, String format) async {
    final taken = await _names(cwd);
    final ext = format == 'zip' ? '.zip' : '.tar.gz';
    var name = archiveName.trim().replaceAll(RegExp(r'/+'), '-');
    if (name.isEmpty) name = 'arxiv';
    if (!name.toLowerCase().endsWith(ext)) name += ext;
    name = uniqueName(taken, name, false);
    final list = names.map(shq).join(' ');
    final script = format == 'zip'
        ? 'cd -- ${shq(cwd)} && if command -v zip >/dev/null 2>&1; then zip -rqy -- ${shq(name)} $list; '
            'elif command -v python3 >/dev/null 2>&1; then python3 -m zipfile -c ${shq(name)} $list; '
            'else echo "Serverda zip yo‘q — .tar.gz tanlang" >&2; exit 3; fi'
        : 'tar -czf ${shq(pJoin(cwd, name))} -C ${shq(cwd)} -- $list';
    await _run(script, _hour * 4);
    return name;
  }

  /// Extract next to the archive ('here') or into a new folder ('folder').
  Future<String?> extract(String filePath, String mode) async {
    final dir = pDirname(filePath);
    final base = pBasename(filePath);
    final m = archiveRe.firstMatch(base);
    if (m == null) throw ConnError('UNSUPPORTED', 'Bu arxiv turi qo‘llab-quvvatlanmaydi');
    final ext = m.group(1)!.toLowerCase();
    final stem = base.substring(0, base.length - m.group(1)!.length);
    final taken = await _names(dir);
    final f = shq(filePath);

    const single = {'.gz': 'gzip', '.bz2': 'bzip2', '.xz': 'xz', '.zst': 'zstd'};
    if (single.containsKey(ext)) {
      final out = pJoin(dir, uniqueName(taken, stem.isEmpty ? base : stem, false));
      await _run('${single[ext]} -dc -- $f > ${shq(out)}', _hour * 4);
      return pBasename(out);
    }
    final dest = mode == 'folder' ? pJoin(dir, uniqueName(taken, stem.isEmpty ? base : stem, true)) : dir;
    final d = shq(dest);
    final String cmd;
    if (RegExp(r'^\.(tar(\..+)?|tgz|tbz2?|txz)$').hasMatch(ext)) {
      cmd = 'tar -xf $f -C $d';
    } else if (ext == '.zip') {
      cmd = 'if command -v unzip >/dev/null 2>&1; then unzip -oq $f -d $d; '
          'elif command -v python3 >/dev/null 2>&1; then python3 -m zipfile -e $f $d; '
          'elif command -v bsdtar >/dev/null 2>&1; then bsdtar -xf $f -C $d; '
          'else echo "Serverda unzip yo‘q (sudo apt install unzip)" >&2; exit 3; fi';
    } else if (ext == '.7z') {
      cmd = '7z x -y ${shq('-o$dest')} $f >/dev/null';
    } else {
      cmd = 'unrar x -o+ $f ${shq('$dest/')} >/dev/null';
    }
    await _run('mkdir -p -- $d && $cmd', _hour * 4);
    return mode == 'folder' ? pBasename(dest) : null;
  }

  /// Recursive search below dir: by file name, or by text inside files.
  Future<List<SearchHit>> search(String dir, String query, String mode) async {
    final d = shq(dir);
    const prune = r'\( -name .git -o -name node_modules -o -name .cache \) -prune -o';
    if (mode == 'name') {
      final glob = shq('*${query.replaceAllMapped(RegExp(r'[\\*?[\]]'), (m) => '\\${m[0]}')}*');
      final out = await _run(
        "{ find $d -xdev $prune -iname $glob -printf '%y\\t%s\\t%T@\\t%p\\n' 2>/dev/null || find $d -xdev $prune -iname $glob -print 2>/dev/null; } | head -n 300; true",
        const Duration(minutes: 1),
      );
      return out.split('\n').where((l) => l.isNotEmpty).map((line) {
        final p = line.split('\t');
        if (p.length < 4) return SearchHit(path: line, type: 'file');
        return SearchHit(
          path: p.sublist(3).join('\t'),
          type: p[0] == 'd' ? 'dir' : p[0] == 'l' ? 'link' : 'file',
          size: int.tryParse(p[1]),
          mtime: double.tryParse(p[2])?.floor(),
        );
      }).where((h) => h.path != dir).toList();
    }
    final q = shq(query);
    final out = await _run(
      '{ grep -rIinHZ --exclude-dir=.git --exclude-dir=node_modules -m 3 -F -e $q -- $d 2>/dev/null || '
      'grep -rIinH -m 3 -F -e $q -- $d 2>/dev/null; } | head -n 400; true',
      const Duration(minutes: 1),
    );
    final hits = <SearchHit>[];
    for (final line in out.split('\n')) {
      if (line.isEmpty) continue;
      String path;
      String rest;
      final z = line.indexOf('\x00');
      if (z >= 0) {
        path = line.substring(0, z);
        rest = line.substring(z + 1);
      } else {
        final m = RegExp(r'^(.*?):(\d+):').firstMatch(line);
        if (m == null) continue;
        path = m.group(1)!;
        rest = line.substring(path.length + 1);
      }
      final m2 = RegExp(r'^(\d+):(.*)$').firstMatch(rest);
      if (m2 == null) continue;
      final text = m2.group(2)!.trim();
      hits.add(SearchHit(path: path, type: 'file', line: int.parse(m2.group(1)!), text: text.length > 300 ? text.substring(0, 300) : text));
    }
    return hits;
  }

  Future<FileInfo> info(String p) async {
    final P = shq(p);
    final out = await _run(
      "stat -c '%F|%s|%U|%G|%a|%Y' -- $P 2>/dev/null; echo '---'; file -b --mime-type -- $P 2>/dev/null; echo '---'; readlink -f -- $P 2>/dev/null; true",
      const Duration(seconds: 15),
    );
    final parts = out.split('---\n').map((s) => s.trim()).toList();
    final st = (parts.isNotEmpty ? parts[0] : '').split('|');
    String? at(List<String> l, int i) => l.length > i && l[i].isNotEmpty ? l[i] : null;
    return FileInfo(
      size: int.tryParse(at(st, 1) ?? ''),
      owner: at(st, 2),
      group: at(st, 3),
      mode: int.tryParse(at(st, 4) ?? '', radix: 8),
      mtime: int.tryParse(at(st, 5) ?? ''),
      mime: at(parts, 1),
      real: at(parts, 2),
    );
  }

  /// Folder size and counts (can take a while on big trees).
  Future<({int? bytes, int files, int dirs})> dirSize(String p) async {
    final P = shq(p);
    final out = await _run(
      "echo \"B \$({ du -sb -- $P 2>/dev/null || du -sk -- $P 2>/dev/null | awk '{print \$1*1024}'; } | cut -f1)\"; "
      'echo "F \$(find $P -xdev -type f 2>/dev/null | wc -l)"; echo "D \$(find $P -xdev -mindepth 1 -type d 2>/dev/null | wc -l)"; true',
      const Duration(minutes: 5),
    );
    int? val(String k) {
      final m = RegExp('^$k *(\\d+)', multiLine: true).firstMatch(out);
      return m == null ? null : int.parse(m.group(1)!);
    }

    return (bytes: val('B'), files: val('F') ?? 0, dirs: val('D') ?? 0);
  }

  /// Read a file fully over SFTP (used by the editor for search results).
  Future<SftpFileAttrs> stat(String p) async => (await conn.sftp()).stat(p);
}
