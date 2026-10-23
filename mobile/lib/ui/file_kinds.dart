// What kind of file is this? Icon + colour per type, so folders, APKs,
// EXEs, archives… are told apart at a glance. Same table as the desktop app
// (src/renderer/filekinds.js).

import 'package:flutter/material.dart';

import '../core/files.dart';

enum FileKind { folder, apk, exe, package, archive, image, video, audio, code, script, web, config, text, pdf, doc, table, db, key, log, font, file }

const _byExt = <String, FileKind>{
  // Android
  'apk': FileKind.apk, 'aab': FileKind.apk, 'xapk': FileKind.apk, 'apks': FileKind.apk,
  // Windows programs
  'exe': FileKind.exe, 'msi': FileKind.exe, 'msix': FileKind.exe, 'appx': FileKind.exe, 'dll': FileKind.exe,
  'bat': FileKind.exe, 'cmd': FileKind.exe, 'ps1': FileKind.exe, 'com': FileKind.exe,
  // Other installers / packages
  'deb': FileKind.package, 'rpm': FileKind.package, 'appimage': FileKind.package, 'snap': FileKind.package,
  'flatpak': FileKind.package, 'pkg': FileKind.package, 'dmg': FileKind.package, 'ipa': FileKind.package,
  // Archives
  'zip': FileKind.archive, 'tar': FileKind.archive, 'gz': FileKind.archive, 'tgz': FileKind.archive,
  'bz2': FileKind.archive, 'tbz2': FileKind.archive, 'xz': FileKind.archive, 'txz': FileKind.archive,
  '7z': FileKind.archive, 'rar': FileKind.archive, 'zst': FileKind.archive, 'lz4': FileKind.archive,
  'lzma': FileKind.archive, 'z': FileKind.archive, 'cab': FileKind.archive, 'iso': FileKind.archive, 'img': FileKind.archive,
  // Media
  'png': FileKind.image, 'jpg': FileKind.image, 'jpeg': FileKind.image, 'gif': FileKind.image, 'webp': FileKind.image,
  'svg': FileKind.image, 'ico': FileKind.image, 'bmp': FileKind.image, 'tif': FileKind.image, 'tiff': FileKind.image,
  'heic': FileKind.image, 'avif': FileKind.image, 'psd': FileKind.image,
  'mp4': FileKind.video, 'mkv': FileKind.video, 'mov': FileKind.video, 'avi': FileKind.video, 'webm': FileKind.video,
  'flv': FileKind.video, 'wmv': FileKind.video, 'm4v': FileKind.video, '3gp': FileKind.video,
  'mp3': FileKind.audio, 'wav': FileKind.audio, 'flac': FileKind.audio, 'ogg': FileKind.audio, 'm4a': FileKind.audio,
  'aac': FileKind.audio, 'opus': FileKind.audio, 'wma': FileKind.audio,
  // Code
  'js': FileKind.code, 'mjs': FileKind.code, 'cjs': FileKind.code, 'jsx': FileKind.code, 'ts': FileKind.code, 'tsx': FileKind.code,
  'py': FileKind.code, 'go': FileKind.code, 'rs': FileKind.code, 'java': FileKind.code, 'kt': FileKind.code,
  'kts': FileKind.code, 'c': FileKind.code, 'h': FileKind.code, 'cpp': FileKind.code, 'hpp': FileKind.code,
  'cc': FileKind.code, 'cs': FileKind.code, 'php': FileKind.code, 'rb': FileKind.code, 'dart': FileKind.code,
  'swift': FileKind.code, 'lua': FileKind.code, 'pl': FileKind.code, 'r': FileKind.code, 'scala': FileKind.code,
  'vue': FileKind.code, 'svelte': FileKind.code,
  'sh': FileKind.script, 'bash': FileKind.script, 'zsh': FileKind.script, 'fish': FileKind.script,
  'html': FileKind.web, 'htm': FileKind.web, 'css': FileKind.web, 'scss': FileKind.web, 'sass': FileKind.web, 'less': FileKind.web,
  // Config
  'json': FileKind.config, 'yml': FileKind.config, 'yaml': FileKind.config, 'toml': FileKind.config, 'ini': FileKind.config,
  'conf': FileKind.config, 'cfg': FileKind.config, 'env': FileKind.config, 'xml': FileKind.config,
  'properties': FileKind.config, 'lock': FileKind.config, 'plist': FileKind.config, 'service': FileKind.config,
  'timer': FileKind.config, 'socket': FileKind.config,
  // Documents
  'txt': FileKind.text, 'md': FileKind.text, 'rst': FileKind.text,
  'pdf': FileKind.pdf,
  'doc': FileKind.doc, 'docx': FileKind.doc, 'odt': FileKind.doc, 'rtf': FileKind.doc,
  'csv': FileKind.table, 'tsv': FileKind.table, 'xls': FileKind.table, 'xlsx': FileKind.table, 'ods': FileKind.table,
  // Data, keys, logs, fonts
  'sql': FileKind.db, 'db': FileKind.db, 'sqlite': FileKind.db, 'sqlite3': FileKind.db, 'dump': FileKind.db,
  'pem': FileKind.key, 'key': FileKind.key, 'crt': FileKind.key, 'cer': FileKind.key, 'csr': FileKind.key,
  'pub': FileKind.key, 'p12': FileKind.key, 'pfx': FileKind.key, 'jks': FileKind.key, 'gpg': FileKind.key, 'asc': FileKind.key,
  'log': FileKind.log,
  'ttf': FileKind.font, 'otf': FileKind.font, 'woff': FileKind.font, 'woff2': FileKind.font,
};

const _byName = <String, FileKind>{
  'dockerfile': FileKind.config, 'makefile': FileKind.config, 'jenkinsfile': FileKind.config, 'vagrantfile': FileKind.config,
  'procfile': FileKind.config, '.bashrc': FileKind.config, '.zshrc': FileKind.config, '.profile': FileKind.config,
  '.bash_profile': FileKind.config, '.gitignore': FileKind.config, '.dockerignore': FileKind.config, '.editorconfig': FileKind.config,
  'authorized_keys': FileKind.key, 'known_hosts': FileKind.key, 'id_rsa': FileKind.key, 'id_ed25519': FileKind.key,
  'id_ecdsa': FileKind.key, 'readme': FileKind.text, 'license': FileKind.text, 'changelog': FileKind.text,
};

FileKind kindOf(Entry e) {
  if (e.isDir) return FileKind.folder;
  final name = e.name.toLowerCase();
  final byName = _byName[name];
  if (byName != null) return byName;
  if (name.startsWith('.env')) return FileKind.config;
  final dot = name.lastIndexOf('.');
  if (dot > 0) {
    final kind = _byExt[name.substring(dot + 1)];
    if (kind != null) return kind;
  }
  if (RegExp(r'\.log(\.\d+)?$').hasMatch(name)) return FileKind.log; // rotated logs: app.log.1
  if (e.mode & 0x49 != 0) return FileKind.script; // executable bit (0o111)
  return FileKind.file;
}

IconData kindIcon(FileKind k) => switch (k) {
      FileKind.folder => Icons.folder_rounded,
      FileKind.apk => Icons.android_rounded,
      FileKind.exe => Icons.web_asset_rounded,
      FileKind.package => Icons.inventory_2_outlined,
      FileKind.archive => Icons.folder_zip_outlined,
      FileKind.image => Icons.image_outlined,
      FileKind.video => Icons.movie_outlined,
      FileKind.audio => Icons.music_note_rounded,
      FileKind.code => Icons.code_rounded,
      FileKind.script => Icons.terminal_rounded,
      FileKind.web => Icons.language_rounded,
      FileKind.config => Icons.tune_rounded,
      FileKind.text => Icons.notes_rounded,
      FileKind.pdf => Icons.picture_as_pdf_outlined,
      FileKind.doc => Icons.description_outlined,
      FileKind.table => Icons.table_chart_outlined,
      FileKind.db => Icons.storage_rounded,
      FileKind.key => Icons.key_rounded,
      FileKind.log => Icons.receipt_long_outlined,
      FileKind.font => Icons.font_download_outlined,
      FileKind.file => Icons.insert_drive_file_outlined,
    };

/// (dark theme, light theme) colours. Folders are the only blue.
(Color, Color) _tones(FileKind k) => switch (k) {
      FileKind.folder => (const Color(0xFF5B9DF5), const Color(0xFF2563EB)),
      FileKind.apk => (const Color(0xFF3DDC84), const Color(0xFF15A35A)),
      FileKind.exe => (const Color(0xFF22D3EE), const Color(0xFF0891B2)),
      FileKind.package => (const Color(0xFFA3E635), const Color(0xFF4D7C0F)),
      FileKind.archive => (const Color(0xFFF59E0B), const Color(0xFFB45309)),
      FileKind.image => (const Color(0xFFF472B6), const Color(0xFFDB2777)),
      FileKind.video => (const Color(0xFFF87171), const Color(0xFFDC2626)),
      FileKind.audio => (const Color(0xFFA78BFA), const Color(0xFF7C3AED)),
      FileKind.code || FileKind.web => (const Color(0xFFFB923C), const Color(0xFFC2410C)),
      FileKind.script => (const Color(0xFF4ADE80), const Color(0xFF16A34A)),
      FileKind.pdf => (const Color(0xFFEF4444), const Color(0xFFB91C1C)),
      FileKind.table => (const Color(0xFF34D399), const Color(0xFF047857)),
      FileKind.db => (const Color(0xFF2DD4BF), const Color(0xFF0F766E)),
      FileKind.key => (const Color(0xFFFACC15), const Color(0xFFA16207)),
      FileKind.config => (const Color(0xFF94A3B8), const Color(0xFF475569)),
      _ => (const Color(0xFF8E8E96), const Color(0xFF71717A)),
    };

Color kindColor(FileKind k, {required bool dark}) {
  final t = _tones(k);
  return dark ? t.$1 : t.$2;
}

String kindLabel(FileKind k) => switch (k) {
      FileKind.folder => 'Papka',
      FileKind.apk => 'Android ilova',
      FileKind.exe => 'Windows dastur',
      FileKind.package => 'O‘rnatish paketi',
      FileKind.archive => 'Arxiv',
      FileKind.image => 'Rasm',
      FileKind.video => 'Video',
      FileKind.audio => 'Audio',
      FileKind.code => 'Kod',
      FileKind.script => 'Skript',
      FileKind.web => 'Veb',
      FileKind.config => 'Sozlama',
      FileKind.text => 'Matn',
      FileKind.pdf => 'PDF',
      FileKind.doc => 'Hujjat',
      FileKind.table => 'Jadval',
      FileKind.db => 'Ma’lumotlar bazasi',
      FileKind.key => 'Kalit',
      FileKind.log => 'Log',
      FileKind.font => 'Shrift',
      FileKind.file => 'Fayl',
    };
