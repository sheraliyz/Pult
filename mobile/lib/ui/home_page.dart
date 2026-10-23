// Start screen: the server list.

import 'package:flutter/material.dart';

import '../app_state.dart';
import '../core/connection.dart';
import '../core/format.dart';
import '../core/store.dart';
import '../theme.dart';
import 'server_form.dart';
import 'session_page.dart';
import 'settings_sheet.dart';
import 'widgets.dart';

class HomePage extends StatelessWidget {
  const HomePage({super.key, required this.app});
  final AppState app;

  void _open(BuildContext context, Server s) {
    final session = app.open(s);
    Navigator.of(context).push(MaterialPageRoute(builder: (_) => SessionPage(app: app, session: session)));
  }

  Future<void> _edit(BuildContext context, [Server? s]) async {
    final r = await Navigator.of(context).push<FormResult>(MaterialPageRoute(builder: (_) => ServerFormPage(store: app.store, server: s)));
    if (r != null && r.connect && context.mounted) _open(context, r.server);
  }

  void _actions(BuildContext context, Server s) {
    showActions(context, title: s.name, subtitle: s.address, actions: [
      SheetAction('Ulanish', Icons.terminal_rounded, () => _open(context, s)),
      SheetAction('Tahrirlash', Icons.edit_outlined, () => _edit(context, s)),
      SheetAction('Manzilni nusxalash', Icons.copy_rounded, () => copyText(context, '${s.username}@${s.host}')),
      null,
      SheetAction('O‘chirish', Icons.delete_outline_rounded, () async {
        final ok = await confirm(context,
            title: 'Serverni o‘chirish', message: '“${s.name}” ro‘yxatdan o‘chirilsinmi? Serverning o‘ziga hech narsa bo‘lmaydi.', ok: 'O‘chirish', danger: true);
        if (ok) await app.store.deleteServer(s.id);
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
            return CustomScrollView(slivers: [
              SliverToBoxAdapter(
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(20, 18, 8, 18),
                  child: Row(children: [
                    const Text('Serverlar', style: TextStyle(fontSize: 26, fontWeight: FontWeight.w600, letterSpacing: -0.5)),
                    if (servers.isNotEmpty) ...[
                      const SizedBox(width: 10),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                        decoration: BoxDecoration(color: p.hover, borderRadius: BorderRadius.circular(99)),
                        child: Text('${servers.length}', style: TextStyle(color: p.fg2, fontSize: 12.5, fontWeight: FontWeight.w500)),
                      ),
                    ],
                    const Spacer(),
                    IconBtn(Icons.tune_rounded, tip: 'Sozlamalar', onTap: () => showSettings(context, app.store)),
                    IconBtn(Icons.add_rounded, tip: 'Yangi server', size: 25, color: p.fg, onTap: () => _edit(context)),
                  ]),
                ),
              ),
              if (servers.isEmpty)
                SliverFillRemaining(hasScrollBody: false, child: _Empty(onAdd: () => _edit(context)))
              else
                SliverPadding(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  sliver: SliverToBoxAdapter(
                    child: Container(
                      decoration: BoxDecoration(border: Border.all(color: p.line), borderRadius: BorderRadius.circular(16)),
                      clipBehavior: Clip.antiAlias,
                      child: Column(children: [
                        for (var i = 0; i < servers.length; i++) ...[
                          if (i > 0) Divider(color: p.line, height: 1),
                          _ServerRow(
                            server: servers[i],
                            live: app.sessionFor(servers[i].id)?.conn.state,
                            onTap: () => _open(context, servers[i]),
                            onLong: () => _actions(context, servers[i]),
                          ),
                        ],
                      ]),
                    ),
                  ),
                ),
              const SliverToBoxAdapter(child: SizedBox(height: 28)),
            ]);
          },
        ),
      ),
    );
  }
}

class _ServerRow extends StatelessWidget {
  const _ServerRow({required this.server, required this.live, required this.onTap, required this.onLong});
  final Server server;
  final ConnState? live;
  final VoidCallback onTap, onLong;

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final s = server;
    final liveColor = switch (live) {
      ConnState.ready => p.ok,
      ConnState.failed => p.err,
      null || ConnState.closed => null,
      _ => p.warn,
    };
    return InkWell(
      onTap: onTap,
      onLongPress: onLong,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 13, 8, 13),
        child: Row(children: [
          Container(
            width: 40,
            height: 40,
            alignment: Alignment.center,
            decoration: BoxDecoration(color: p.bg3, border: Border.all(color: p.line), borderRadius: BorderRadius.circular(11)),
            child: Text((s.name.isEmpty ? s.host : s.name).characters.first.toUpperCase(),
                style: TextStyle(color: p.fg2, fontWeight: FontWeight.w600, fontSize: 15)),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Flexible(child: Text(s.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 15.5, fontWeight: FontWeight.w500))),
                if (liveColor != null) ...[const SizedBox(width: 8), Dot(liveColor)],
              ]),
              const SizedBox(height: 3),
              Row(children: [
                Icon(s.auth == 'key' ? Icons.key_rounded : Icons.lock_outline_rounded, size: 12.5, color: p.fg3),
                const SizedBox(width: 5),
                Flexible(
                  child: Text(s.address, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontFamily: kMono, fontSize: 12, color: p.fg3)),
                ),
              ]),
            ]),
          ),
          const SizedBox(width: 8),
          Text(fmtAgo(s.lastUsed), style: TextStyle(color: p.fg3, fontSize: 12)),
          IconBtn(Icons.more_vert_rounded, size: 19, color: p.fg3, onTap: onLong),
        ]),
      ),
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
        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 48),
        decoration: BoxDecoration(border: Border.all(color: p.line2), borderRadius: BorderRadius.circular(18)),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Container(
            width: 56,
            height: 56,
            decoration: BoxDecoration(color: p.bg3, border: Border.all(color: p.line), borderRadius: BorderRadius.circular(16)),
            child: Icon(Icons.dns_outlined, color: p.fg2, size: 26),
          ),
          const SizedBox(height: 18),
          const Text('Hali server qo‘shilmagan', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
          const SizedBox(height: 6),
          Text('Server qo‘shing — terminal va fayllar bir joyda, aloqa uzilsa ham sessiya saqlanadi.',
              textAlign: TextAlign.center, style: TextStyle(color: p.fg2, height: 1.45)),
          const SizedBox(height: 22),
          Btn('Server qo‘shish', icon: Icons.add_rounded, kind: BtnKind.primary, onTap: onAdd),
        ]),
      ),
    );
  }
}
