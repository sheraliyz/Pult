// Updates from GitHub Releases: is there a newer Pult? Its APK is downloaded
// into the app's cache and handed to Android's installer, which asks the user
// to confirm. (It installs over this app only when signed with the same key.)

import 'dart:async';
import 'dart:convert';
import 'dart:io';

/// This build's version — keep in step with pubspec.yaml (a test checks it).
const kAppVersion = '1.2.0';
const _repo = 'sheraliyz/Pult';

class Release {
  const Release({required this.version, required this.name, required this.notes, required this.page, this.apkUrl, this.apkSize = 0});
  final String version, name, notes, page;
  final String? apkUrl;
  final int apkSize;
}

List<int> _parse(String v) {
  final parts = v.replaceFirst(RegExp(r'^v', caseSensitive: false), '').split(RegExp(r'[.+-]'));
  return [for (var i = 0; i < 3; i++) i < parts.length ? int.tryParse(parts[i]) ?? 0 : 0];
}

/// True when version [a] is newer than [b] ("1.10.0" > "1.9.3").
bool newerVersion(String a, String b) {
  final x = _parse(a), y = _parse(b);
  for (var i = 0; i < 3; i++) {
    if (x[i] != y[i]) return x[i] > y[i];
  }
  return false;
}

/// The latest release, from the GitHub API JSON.
Release parseRelease(Map<String, dynamic> j) {
  final assets = (j['assets'] as List? ?? const []).whereType<Map>();
  final apk = assets.where((a) => '${a['name']}'.toLowerCase().endsWith('.apk')).firstOrNull;
  final url = apk?['browser_download_url'];
  return Release(
    version: '${j['tag_name'] ?? ''}'.replaceFirst(RegExp(r'^v', caseSensitive: false), ''),
    name: '${j['name'] ?? j['tag_name'] ?? ''}',
    notes: '${j['body'] ?? ''}'.length > 6000 ? '${j['body']}'.substring(0, 6000) : '${j['body'] ?? ''}',
    page: '${j['html_url'] ?? 'https://github.com/$_repo/releases'}',
    // Only GitHub's own download links are followed.
    apkUrl: url is String && url.startsWith('https://github.com/') ? url : null,
    apkSize: apk?['size'] is int ? apk!['size'] as int : 0,
  );
}

Future<Release> latestRelease() async {
  final c = HttpClient()..userAgent = 'Pult/$kAppVersion (Android)';
  try {
    final req = await c.getUrl(Uri.parse('https://api.github.com/repos/$_repo/releases/latest')).timeout(const Duration(seconds: 20));
    req.headers.set('Accept', 'application/vnd.github+json');
    final res = await req.close().timeout(const Duration(seconds: 20));
    final body = await res.transform(utf8.decoder).join().timeout(const Duration(seconds: 20));
    if (res.statusCode != 200) throw HttpException('GitHub javob bermadi (${res.statusCode})');
    return parseRelease(jsonDecode(body) as Map<String, dynamic>);
  } finally {
    c.close(force: true);
  }
}

/// Download the release APK into [dir]; [progress] gets (done, total) bytes.
Future<File> downloadApk(Release r, String dir, {void Function(int done, int total)? progress, bool Function()? cancelled}) async {
  final url = r.apkUrl;
  if (url == null) throw const HttpException('Bu versiyada APK fayl yo‘q');
  final c = HttpClient()..userAgent = 'Pult/$kAppVersion (Android)';
  final file = File('$dir/Pult-${r.version}.apk');
  final part = File('${file.path}.part');
  try {
    final req = await c.getUrl(Uri.parse(url)).timeout(const Duration(seconds: 30));
    final res = await req.close().timeout(const Duration(seconds: 30));
    if (res.statusCode != 200) throw HttpException('Yuklab bo‘lmadi (${res.statusCode})');
    final total = res.contentLength > 0 ? res.contentLength : r.apkSize;
    final out = part.openWrite();
    var done = 0;
    var last = 0;
    try {
      await for (final chunk in res) {
        if (cancelled?.call() ?? false) throw const HttpException('Bekor qilindi');
        out.add(chunk);
        done += chunk.length;
        final now = DateTime.now().millisecondsSinceEpoch;
        if (now - last > 150) {
          last = now;
          progress?.call(done, total);
        }
      }
    } finally {
      await out.close();
    }
    if (total > 0 && done < total) throw const HttpException('Yuklash to‘liq tugamadi');
    progress?.call(done, total);
    if (await file.exists()) await file.delete();
    return await part.rename(file.path);
  } finally {
    c.close(force: true);
  }
}
