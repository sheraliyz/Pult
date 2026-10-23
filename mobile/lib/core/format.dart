// Uzbek formatting helpers (sizes, dates, durations, permissions).

const _months = ['yan', 'fev', 'mar', 'apr', 'may', 'iyun', 'iyul', 'avg', 'sen', 'okt', 'noy', 'dek'];

String _pad(int n) => n.toString().padLeft(2, '0');

String fmtBytes(num? n) {
  if (n == null) return '—';
  if (n < 1024) return '${n.toInt()} B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  var v = n / 1024;
  var i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return '${v >= 100 ? v.round() : v.toStringAsFixed(1)} ${units[i]}';
}

String fmtDate(int? sec) {
  if (sec == null || sec == 0) return '—';
  final d = DateTime.fromMillisecondsSinceEpoch(sec * 1000);
  final now = DateTime.now();
  final time = '${_pad(d.hour)}:${_pad(d.minute)}';
  bool same(DateTime a, DateTime b) => a.year == b.year && a.month == b.month && a.day == b.day;
  if (same(d, now)) return 'bugun, $time';
  if (same(d, now.subtract(const Duration(days: 1)))) return 'kecha, $time';
  if (d.year == now.year) return '${d.day} ${_months[d.month - 1]}, $time';
  return '${d.day} ${_months[d.month - 1]} ${d.year}';
}

String fmtAgo(int? ms) {
  if (ms == null || ms == 0) return 'hali ulanilmagan';
  final s = (DateTime.now().millisecondsSinceEpoch - ms) ~/ 1000;
  if (s < 60) return 'hozirgina';
  if (s < 3600) return '${s ~/ 60} daqiqa oldin';
  if (s < 86400) return '${s ~/ 3600} soat oldin';
  if (s < 172800) return 'kecha';
  if (s < 2592000) return '${s ~/ 86400} kun oldin';
  return fmtDate(ms ~/ 1000);
}

String fmtUptime(double? sec) {
  if (sec == null || sec == 0) return '—';
  final d = sec ~/ 86400;
  if (d > 0) return '$d kun';
  final h = sec ~/ 3600;
  if (h > 0) return '$h soat';
  return '${(sec ~/ 60).clamp(1, 59)} daq';
}

String fmtMode(int mode, {bool dir = false, bool link = false}) {
  const bits = 'rwxrwxrwx';
  final b = StringBuffer(dir ? 'd' : link ? 'l' : '-');
  for (var i = 0; i < 9; i++) {
    b.write(mode & (1 << (8 - i)) != 0 ? bits[i] : '-');
  }
  return b.toString();
}

String fmtOctal(int mode) => (mode & 0xFFF).toRadixString(8).padLeft(3, '0');

String fmtSpeed(double bps) => bps > 0 ? '${fmtBytes(bps.round())}/s' : '';

/* ---------------- posix paths ---------------- */

String pJoin(String a, String b) {
  if (b.startsWith('/')) return b;
  if (a.endsWith('/')) return '$a$b';
  return '$a/$b';
}

String pDirname(String p) {
  if (p == '/' || !p.contains('/')) return '/';
  final d = p.replaceAll(RegExp(r'/+$'), '').replaceAll(RegExp(r'/[^/]*$'), '');
  return d.isEmpty ? '/' : d;
}

String pBasename(String p) {
  final parts = p.replaceAll(RegExp(r'/+$'), '').split('/');
  return parts.isEmpty || parts.last.isEmpty ? '/' : parts.last;
}

/// Quote for the remote POSIX shell.
String shq(String s) => "'${s.replaceAll("'", r"'\''")}'";
