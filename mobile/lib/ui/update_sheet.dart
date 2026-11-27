// "Pult 1.3.0 chiqdi": release notes, then download the APK and hand it to
// Android's installer.

import 'package:flutter/material.dart';
import 'package:open_filex/open_filex.dart';
import 'package:path_provider/path_provider.dart';
import 'package:url_launcher/url_launcher.dart';

import '../app_state.dart';
import '../core/format.dart';
import '../core/update.dart';
import '../theme.dart';
import 'widgets.dart';

Future<void> showUpdateSheet(BuildContext context, AppState app, Release r) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    builder: (ctx) => _UpdateBody(app: app, release: r),
  );
}

class _UpdateBody extends StatefulWidget {
  const _UpdateBody({required this.app, required this.release});
  final AppState app;
  final Release release;

  @override
  State<_UpdateBody> createState() => _UpdateBodyState();
}

class _UpdateBodyState extends State<_UpdateBody> {
  int done = 0, total = 0;
  bool busy = false;
  bool cancelled = false;
  String? error, status;

  Release get r => widget.release;

  Future<void> _install() async {
    setState(() {
      busy = true;
      error = null;
      status = 'Yuklab olinmoqda…';
    });
    try {
      final dir = (await getTemporaryDirectory()).path;
      final file = await downloadApk(r, dir, cancelled: () => cancelled, progress: (d, t) {
        if (!mounted) return;
        setState(() {
          done = d;
          total = t;
        });
      });
      if (!mounted) return;
      setState(() => status = 'O‘rnatish oynasi ochilmoqda…');
      final res = await OpenFilex.open(file.path, type: 'application/vnd.android.package-archive');
      if (!mounted) return;
      if (res.type != ResultType.done) {
        setState(() => error = 'Android o‘rnatish oynasini ochmadi: ${res.message}');
      } else {
        setState(() => status = 'Android so‘ragan oynada “O‘rnatish”ni bosing. Birinchi marta Pult’ga ilova o‘rnatishga ruxsat berish so‘raladi.');
      }
    } catch (e) {
      if (mounted) setState(() => error = cancelled ? null : '$e'.replaceFirst('HttpException: ', ''));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  void dispose() {
    cancelled = true;
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final pct = total > 0 ? done / total : null;
    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.85),
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
              const Text('Pult ', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
              Text(r.version, style: dotStyle(24, color: p.ink)),
              const SizedBox(width: 10),
              Padding(padding: const EdgeInsets.only(bottom: 2), child: Text('hozirgi: $kAppVersion', style: TextStyle(color: p.ink3, fontSize: 13))),
            ]),
            if (r.notes.trim().isNotEmpty) ...[
              const SizedBox(height: 14),
              Container(
                constraints: const BoxConstraints(maxHeight: 260),
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(color: p.well, borderRadius: BorderRadius.circular(12), border: Border.all(color: p.line2, width: 1.4)),
                child: SingleChildScrollView(child: SelectableText(r.notes.trim(), style: TextStyle(color: p.ink2, fontSize: 13.5, height: 1.5))),
              ),
            ],
            if (busy || done > 0) ...[
              const SizedBox(height: 16),
              ClipRRect(
                borderRadius: BorderRadius.circular(4),
                child: LinearProgressIndicator(value: pct, minHeight: 8, backgroundColor: p.well, color: p.signal),
              ),
              const SizedBox(height: 6),
              Text(total > 0 ? '${fmtBytes(done)} / ${fmtBytes(total)}' : fmtBytes(done), style: TextStyle(color: p.ink2, fontSize: 12.5)),
            ],
            if (status != null && error == null) ...[
              const SizedBox(height: 10),
              Text(status!, style: TextStyle(color: p.ink2, height: 1.4)),
            ],
            if (error != null) ...[
              const SizedBox(height: 10),
              Text(error!, style: TextStyle(color: p.err, height: 1.4)),
            ],
            const SizedBox(height: 18),
            Btn(busy ? 'Yuklanmoqda…' : 'Yuklab olish va o‘rnatish', icon: Icons.download_rounded, kind: BtnKind.primary, busy: busy, expand: true, onTap: r.apkUrl == null ? null : _install),
            const SizedBox(height: 10),
            Row(children: [
              Expanded(
                child: Btn('GitHub’da ochish', icon: Icons.open_in_new_rounded, small: true, onTap: () => launchUrl(Uri.parse(r.page), mode: LaunchMode.externalApplication)),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Btn('O‘tkazib yuborish', small: true, onTap: () {
                  widget.app.skipUpdate(r.version);
                  Navigator.pop(context);
                }),
              ),
            ]),
            const SizedBox(height: 10),
            Text('Yangi versiya joriy ilova ustidan o‘rnatiladi, serverlar va sozlamalar saqlanib qoladi.', style: TextStyle(color: p.ink3, fontSize: 12.5, height: 1.4)),
          ]),
        ),
      ),
    );
  }
}
