// "Portlar": SSH tunnels. A port the server listens on (often only on its own
// localhost — a web panel, an API, a dev server) opens on the phone at
// http://127.0.0.1:<port>, through the existing SSH link.

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../app_state.dart';
import '../core/tunnels.dart';
import '../theme.dart';
import 'widgets.dart';

Future<void> showTunnels(BuildContext context, Session session) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    builder: (ctx) => Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(ctx).bottom),
      child: _TunnelsBody(session: session),
    ),
  );
}

class _TunnelsBody extends StatefulWidget {
  const _TunnelsBody({required this.session});
  final Session session;

  @override
  State<_TunnelsBody> createState() => _TunnelsBodyState();
}

class _TunnelsBodyState extends State<_TunnelsBody> {
  Tunnels get tunnels => widget.session.tunnels;
  late final Future<List<ListeningPort>> _scan = tunnels.scan();
  final _port = TextEditingController();
  final _local = TextEditingController();
  final _host = TextEditingController(text: '127.0.0.1');
  String? _error;

  Future<void> _add(String host, int? port, {int? local}) async {
    setState(() => _error = null);
    try {
      final t = await tunnels.add(host, port ?? 0, local: local);
      _port.clear();
      _local.clear();
      if (mounted && t.error != null) toast(context, t.error!);
    } on FormatException catch (e) {
      setState(() => _error = e.message);
    } catch (e) {
      setState(() => _error = '$e');
    }
  }

  Future<void> _open(Tunnel t) async {
    final ok = await launchUrl(Uri.parse(t.url), mode: LaunchMode.externalApplication);
    if (!ok && mounted) toast(context, 'Brauzer ochilmadi — manzilni nusxalab oling', error: true);
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.88),
        child: ListenableBuilder(
          listenable: tunnels,
          builder: (context, _) => ListView(shrinkWrap: true, padding: const EdgeInsets.fromLTRB(18, 0, 18, 18), children: [
            const Text('Portlar (SSH tunnel)', style: TextStyle(fontSize: 19, fontWeight: FontWeight.w700)),
            const SizedBox(height: 6),
            Text('Serverdagi port telefonda 127.0.0.1 manzilida ochiladi — masalan, faqat serverning o‘zida ishlayotgan veb-panelni brauzerda ko‘rish uchun. Ilova ochiq turganda ishlaydi.',
                style: TextStyle(color: p.ink2, fontSize: 13.5, height: 1.45)),
            if (tunnels.list.isNotEmpty) ...[
              const GroupTitle('Ochiq tunnellar'),
              for (final t in tunnels.list) _TunnelRow(tunnel: t, onOpen: () => _open(t), onRemove: () => tunnels.remove(t)),
            ],
            const GroupTitle('Serverda ochiq portlar'),
            FutureBuilder<List<ListeningPort>>(
              future: _scan,
              builder: (context, snap) {
                if (snap.connectionState != ConnectionState.done) {
                  return Padding(padding: const EdgeInsets.all(12), child: Center(child: SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: p.signal))));
                }
                final list = (snap.data ?? const <ListeningPort>[]).where((l) => !tunnels.list.any((t) => t.remotePort == l.port)).toList();
                if (list.isEmpty) {
                  return Text(snap.hasError ? 'Ro‘yxatni olib bo‘lmadi.' : 'Boshqa ochiq port topilmadi.', style: TextStyle(color: p.ink3));
                }
                return Wrap(spacing: 8, runSpacing: 10, children: [
                  for (final l in list)
                    KeyCap(
                      height: 44,
                      radius: 10,
                      padding: const EdgeInsets.symmetric(horizontal: 12),
                      tip: l.localOnly ? 'Faqat serverning o‘zida ochiq' : 'Tashqaridan ham ochiq',
                      onTap: () => _add('127.0.0.1', l.port),
                      child: Row(mainAxisSize: MainAxisSize.min, children: [
                        Text('${l.port}', style: dotStyle(19, color: p.ink)),
                        if (l.proc != null) ...[const SizedBox(width: 6), Text(l.proc!, style: TextStyle(fontSize: 12.5, color: p.ink2, fontWeight: FontWeight.w500))],
                        const SizedBox(width: 6),
                        Icon(Icons.add_rounded, size: 17, color: p.ink),
                      ]),
                    ),
                ]);
              },
            ),
            const GroupTitle('Qo‘lda qo‘shish'),
            Row(children: [
              Expanded(flex: 3, child: TextField(controller: _host, autocorrect: false, style: const TextStyle(fontFamily: kMono, fontSize: 14), decoration: inputDecoration(context, hint: '127.0.0.1'))),
              const SizedBox(width: 8),
              Expanded(flex: 2, child: TextField(controller: _port, keyboardType: TextInputType.number, style: const TextStyle(fontFamily: kMono, fontSize: 14), decoration: inputDecoration(context, hint: 'port'))),
            ]),
            const SizedBox(height: 8),
            Row(children: [
              Expanded(
                child: TextField(
                  controller: _local,
                  keyboardType: TextInputType.number,
                  style: const TextStyle(fontFamily: kMono, fontSize: 14),
                  decoration: inputDecoration(context, hint: 'telefondagi port (ixtiyoriy)'),
                ),
              ),
              const SizedBox(width: 8),
              Btn('Ulash', kind: BtnKind.primary, onTap: () => _add(_host.text.trim(), int.tryParse(_port.text.trim()), local: int.tryParse(_local.text.trim()))),
            ]),
            if (_error != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_error!, style: TextStyle(color: p.err))),
          ]),
        ),
      ),
    );
  }
}

class _TunnelRow extends StatelessWidget {
  const _TunnelRow({required this.tunnel, required this.onOpen, required this.onRemove});
  final Tunnel tunnel;
  final VoidCallback onOpen, onRemove;

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final t = tunnel;
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.fromLTRB(12, 10, 6, 10),
      decoration: BoxDecoration(color: p.key, borderRadius: BorderRadius.circular(12), border: Border.all(color: p.stroke, width: 1.4), boxShadow: [BoxShadow(color: p.keyShadow, offset: const Offset(0, 3))]),
      child: Row(children: [
        Text('${t.localPort}', style: dotStyle(24, color: p.ink)),
        const SizedBox(width: 10),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('→ ${t.remoteHost}:${t.remotePort}', style: TextStyle(fontFamily: kMono, fontSize: 13, color: p.ink, fontWeight: FontWeight.w600)),
            Text(
              t.error ?? (t.active > 0 ? '${t.active} ta ulanish ochiq' : t.total > 0 ? '${t.total} marta ishlatildi' : t.url),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(color: t.error != null ? p.warn : p.ink3, fontSize: 12.5),
            ),
          ]),
        ),
        IconBtn(Icons.open_in_browser_rounded, size: 21, tip: 'Brauzerda ochish', onTap: onOpen),
        IconBtn(Icons.copy_rounded, size: 19, tip: 'Manzilni nusxalash', onTap: () => copyText(context, t.url)),
        IconBtn(Icons.close_rounded, size: 20, tip: 'O‘chirish', onTap: onRemove),
      ]),
    );
  }
}
