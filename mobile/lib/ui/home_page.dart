// Start screen: the server list — keys on a light chassis, like the desktop.

import 'package:flutter/material.dart';

import '../app_state.dart';
import '../core/connection.dart';
import '../core/format.dart';
import '../core/store.dart';
import '../core/update.dart';
import '../theme.dart';
import 'server_form.dart';
import 'session_page.dart';
import 'settings_sheet.dart';
import 'update_sheet.dart';
import 'widgets.dart';

/// Two letters for a server's key: "acme-prod" → "AC".
String monogram(Server s) {
  final src = (s.name.isEmpty ? s.host : s.name).replaceAll(RegExp(r'[^\p{L}\p{N}]', unicode: true), '');
  if (src.isEmpty) return '#';
  return src.characters.take(2).toString().toUpperCase();
}

class HomePage extends StatefulWidget {
  const HomePage({super.key, required this.app});
  final AppState app;

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  AppState get app => widget.app;

  @override
  void initState() {
    super.initState();
    // The servers that were open last time, and the one that was in front.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final shown = app.restoreLayout();
      if (shown != null && mounted) _show(shown);
    });
  }

  void _show(Session session) {
    Navigator.of(context).push(MaterialPageRoute(builder: (_) => SessionPage(app: app, session: session)));
  }

  void _open(Server s) => _show(app.open(s));

  Future<void> _edit([Server? s]) async {
    final r = await Navigator.of(context).push<FormResult>(MaterialPageRoute(builder: (_) => ServerFormPage(store: app.store, server: s)));
    if (r != null && r.connect && mounted) _open(r.server);
  }

  void _actions(Server s) {
    final live = app.sessionFor(s.id);
    showActions(context, title: s.name, subtitle: s.address, actions: [
      SheetAction('Ulanish', Icons.terminal_rounded, () => _open(s)),
      SheetAction('Tahrirlash', Icons.edit_outlined, () => _edit(s)),
      SheetAction('Manzilni nusxalash', Icons.copy_rounded, () => copyText(context, '${s.username}@${s.host}')),
      if (live != null) SheetAction('Ulanishni yopish', Icons.power_settings_new_rounded, () => app.close(live)),
      null,
      SheetAction('O‘chirish', Icons.delete_outline_rounded, () async {
        final ok = await confirm(context,
            title: 'Serverni o‘chirish', message: '“${s.name}” ro‘yxatdan o‘chirilsinmi? Serverning o‘ziga hech narsa bo‘lmaydi.', ok: 'O‘chirish', danger: true);
        if (!ok) return;
        final open = app.sessionFor(s.id);
        if (open != null) await app.close(open);
        await app.store.deleteServer(s.id);
      }, danger: true),
    ]);
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    return Scaffold(
      body: SafeArea(
        child: ListenableBuilder(
          listenable: Listenable.merge([app.store, app]),
          builder: (context, _) {
            final servers = [...app.store.servers]..sort((a, b) {
                final c = b.lastUsed.compareTo(a.lastUsed);
                return c != 0 ? c : a.name.toLowerCase().compareTo(b.name.toLowerCase());
              });
            final update = app.update;
            return CustomScrollView(slivers: [
              SliverToBoxAdapter(
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(20, 14, 16, 0),
                  child: Row(children: [
                    const PultLogo(),
                    const Spacer(),
                    KeyIcon(Icons.tune_rounded, tip: 'Sozlamalar', onTap: () => showSettings(context, app)),
                  ]),
                ),
              ),
              SliverToBoxAdapter(
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(20, 22, 16, 14),
                  child: Row(children: [
                    const Text('Serverlar', style: TextStyle(fontSize: 28, fontWeight: FontWeight.w700, letterSpacing: -0.6)),
                    if (servers.isNotEmpty) ...[
                      const SizedBox(width: 10),
                      Container(
                        height: 30,
                        constraints: const BoxConstraints(minWidth: 30),
                        padding: const EdgeInsets.symmetric(horizontal: 6),
                        alignment: Alignment.center,
                        decoration: BoxDecoration(color: p.key, borderRadius: BorderRadius.circular(8), border: Border.all(color: p.stroke, width: 1.4)),
                        child: Text('${servers.length}', style: dotStyle(19, color: p.ink)),
                      ),
                    ],
                    const Spacer(),
                    if (servers.isNotEmpty) Btn('Yangi', icon: Icons.add_rounded, kind: BtnKind.primary, onTap: () => _edit()),
                  ]),
                ),
              ),
              if (update != null)
                SliverToBoxAdapter(
                  child: Padding(padding: const EdgeInsets.fromLTRB(16, 0, 16, 14), child: _UpdateCard(app: app, release: update)),
                ),
              if (servers.isEmpty)
                SliverFillRemaining(hasScrollBody: false, child: _Empty(onAdd: () => _edit()))
              else
                SliverPadding(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  sliver: SliverList.separated(
                    itemCount: servers.length,
                    separatorBuilder: (_, _) => const SizedBox(height: 10),
                    itemBuilder: (context, i) => _ServerKey(
                      server: servers[i],
                      live: app.sessionFor(servers[i].id)?.conn.state,
                      onTap: () => _open(servers[i]),
                      onMore: () => _actions(servers[i]),
                    ),
                  ),
                ),
              SliverToBoxAdapter(
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(20, 26, 20, 24),
                  child: Row(children: [
                    Text('PULT', style: capsStyle(p.ink3, size: 10.5)),
                    const SizedBox(width: 6),
                    Text(kAppVersion, style: dotStyle(15, color: p.ink3)),
                    const SizedBox(width: 10),
                    Expanded(child: Text('SSH · SFTP · tmux', style: TextStyle(color: p.ink4, fontSize: 12.5))),
                  ]),
                ),
              ),
            ]);
          },
        ),
      ),
    );
  }
}

/// "pult" in dot-matrix with the signal dot.
class PultLogo extends StatelessWidget {
  const PultLogo({super.key, this.size = 30});
  final double size;

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    return Row(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.center, children: [
      Text('pult', style: dotStyle(size, color: p.ink)),
      SizedBox(width: size * 0.22),
      Dot(p.signal, size: size * 0.36, ring: true),
    ]);
  }
}

class _ServerKey extends StatelessWidget {
  const _ServerKey({required this.server, required this.live, required this.onTap, required this.onMore});
  final Server server;
  final ConnState? live;
  final VoidCallback onTap, onMore;

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final s = server;
    final (Color? liveColor, String? liveText) = switch (live) {
      ConnState.ready => (p.signal, 'ulangan'),
      ConnState.failed => (p.err, 'ulanmadi'),
      ConnState.connecting => (p.warn, 'ulanmoqda'),
      ConnState.reconnecting => (p.warn, 'qayta ulanmoqda'),
      null || ConnState.closed => (null, null),
    };
    return KeyCap(
      onTap: onTap,
      onLongPress: onMore,
      height: null,
      radius: 14,
      padding: const EdgeInsets.fromLTRB(12, 12, 4, 12),
      child: Row(children: [
        Container(
          width: 46,
          height: 46,
          alignment: Alignment.center,
          decoration: BoxDecoration(color: p.key2, borderRadius: BorderRadius.circular(10), border: Border.all(color: p.stroke, width: 1.4)),
          child: Text(monogram(s), style: dotStyle(21, color: p.ink)),
        ),
        const SizedBox(width: 13),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Flexible(child: Text(s.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600, color: p.ink))),
              if (liveColor != null) ...[
                const SizedBox(width: 8),
                Dot(liveColor, size: 10, ring: true, pulse: live == ConnState.connecting || live == ConnState.reconnecting),
              ],
            ]),
            const SizedBox(height: 4),
            Row(children: [
              Icon(s.auth == 'key' ? Icons.key_rounded : Icons.lock_outline_rounded, size: 13, color: p.ink3),
              const SizedBox(width: 5),
              Flexible(
                child: Text(s.address, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontFamily: kMono, fontSize: 12.5, color: p.ink2, fontWeight: FontWeight.w400)),
              ),
            ]),
            const SizedBox(height: 3),
            Text(liveText ?? fmtAgo(s.lastUsed), style: TextStyle(color: liveColor == p.signal ? p.ink2 : liveColor ?? p.ink3, fontSize: 12.5, fontWeight: FontWeight.w500)),
          ]),
        ),
        IconBtn(Icons.more_vert_rounded, size: 20, color: p.ink3, onTap: onMore),
      ]),
    );
  }
}

class _UpdateCard extends StatelessWidget {
  const _UpdateCard({required this.app, required this.release});
  final AppState app;
  final Release release;

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    return KeyCap(
      tone: KeyTone.signal,
      height: null,
      radius: 14,
      padding: const EdgeInsets.fromLTRB(14, 12, 10, 12),
      onTap: () => showUpdateSheet(context, app, release),
      child: Row(children: [
        Icon(Icons.system_update_rounded, size: 22, color: p.onSignal),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Text('Pult ', style: TextStyle(fontSize: 15.5, fontWeight: FontWeight.w700, color: p.onSignal)),
              Text(release.version, style: dotStyle(18, color: p.onSignal)),
              Text(' chiqdi', style: TextStyle(fontSize: 15.5, fontWeight: FontWeight.w700, color: p.onSignal)),
            ]),
            const SizedBox(height: 2),
            Text('Ko‘rish va o‘rnatish', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w500, color: p.onSignal)),
          ]),
        ),
        Icon(Icons.chevron_right_rounded, color: p.onSignal),
      ]),
    );
  }
}

class _Empty extends StatelessWidget {
  const _Empty({required this.onAdd});
  final VoidCallback onAdd;

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 80),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 40),
        decoration: BoxDecoration(color: p.paper, border: Border.all(color: p.stroke, width: 1.4), borderRadius: BorderRadius.circular(18), boxShadow: [BoxShadow(color: p.keyShadow, offset: const Offset(0, 3))]),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Container(
            width: 58,
            height: 58,
            decoration: BoxDecoration(color: p.key2, border: Border.all(color: p.stroke, width: 1.4), borderRadius: BorderRadius.circular(14)),
            child: Icon(Icons.dns_outlined, color: p.ink, size: 27),
          ),
          const SizedBox(height: 18),
          const Text('Hali server qo‘shilmagan', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
          const SizedBox(height: 8),
          Text('Server qo‘shing — terminal va fayllar bir joyda, aloqa uzilsa ham sessiya saqlanadi.',
              textAlign: TextAlign.center, style: TextStyle(color: p.ink2, height: 1.45, fontSize: 15)),
          const SizedBox(height: 22),
          Btn('Server qo‘shish', icon: Icons.add_rounded, kind: BtnKind.primary, onTap: onAdd),
        ]),
      ),
    );
  }
}
