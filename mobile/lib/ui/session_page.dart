// A connected server: terminal and files, sharing one SSH link.

import 'dart:async';

import 'package:flutter/material.dart';

import '../app_state.dart';
import '../core/connection.dart';
import '../core/store.dart';
import '../theme.dart';
import 'files_pane.dart';
import 'prompts.dart';
import 'server_form.dart';
import 'terminal_pane.dart';
import 'transfers_sheet.dart';
import 'widgets.dart';

class SessionPage extends StatefulWidget {
  const SessionPage({super.key, required this.app, required this.session});
  final AppState app;
  final Session session;

  @override
  State<SessionPage> createState() => _SessionPageState();
}

class _SessionPageState extends State<SessionPage> {
  Session get s => widget.session;
  Connection get conn => s.conn;
  Store get store => widget.app.store;
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    // Countdown in the reconnect banner.
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (conn.state == ConnState.reconnecting && mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  Future<void> _close() async {
    Navigator.of(context).pop();
    await widget.app.close(s);
  }

  Future<void> _editServer() async {
    final r = await Navigator.of(context).push<FormResult>(MaterialPageRoute(builder: (_) => ServerFormPage(store: store, server: s.server)));
    if (r == null || !mounted) return;
    s.server = r.server;
    if (conn.state == ConnState.failed) {
      // Credentials changed: start over with a fresh connection.
      final app = widget.app;
      Navigator.of(context).pop();
      await app.close(s);
      final fresh = app.open(r.server);
      app.navKey.currentState?.push(MaterialPageRoute(builder: (_) => SessionPage(app: app, session: fresh)));
    }
  }

  void _menu() {
    final term = s.tab == 0;
    showActions(context, title: s.server.name, subtitle: s.server.address, actions: [
      if (term) SheetAction('Yangi terminal', Icons.add_rounded, () => s.newShell()),
      if (term && s.active != null) SheetAction('Terminalni yopish', Icons.close_rounded, () => s.closeShell(s.active!)),
      if (term)
        SheetAction('Shriftni kattalashtirish', Icons.text_increase_rounded, () {
          store.settings.fontSize = (store.settings.fontSize + 1).clamp(8, 22);
          store.saveSettings();
        }),
      if (term)
        SheetAction('Shriftni kichraytirish', Icons.text_decrease_rounded, () {
          store.settings.fontSize = (store.settings.fontSize - 1).clamp(8, 22);
          store.saveSettings();
        }),
      if (!term && widget.app.fileClip?.conn == conn)
        SheetAction('Shu yerga qo‘yish (${widget.app.fileClip!.items.length})', Icons.content_paste_rounded, () => FilesPane.paste(context, s)),
      if (!term) SheetAction('Qidirish', Icons.search_rounded, () => FilesPane.openSearch(context, s)),
      if (!term) SheetAction('Yangi papka', Icons.create_new_folder_outlined, () => FilesPane.newFolder(context, s)),
      if (!term) SheetAction('Yangi fayl', Icons.note_add_outlined, () => FilesPane.newFile(context, s)),
      if (!term) SheetAction('Tanlash', Icons.checklist_rounded, s.files.selectAll),
      if (!term) SheetAction('Papka xususiyatlari', Icons.info_outline_rounded, () => showProperties(context, s, null)),
      if (!term)
        SheetAction(s.files.showHidden ? 'Yashirin fayllarni berkitish' : 'Yashirin fayllarni ko‘rsatish',
            s.files.showHidden ? Icons.visibility_off_outlined : Icons.visibility_outlined, () {
          s.files.showHidden = !s.files.showHidden;
          s.files.refresh();
        }),
      if (conn.state == ConnState.reconnecting) SheetAction('Hozir qayta ulash', Icons.sync_rounded, conn.retryNow),
      null,
      SheetAction('Server sozlamalari', Icons.tune_rounded, _editServer),
      SheetAction('Ulanishni yopish', Icons.power_settings_new_rounded, _close, danger: true),
    ]);
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    return ListenableBuilder(
      listenable: Listenable.merge([s, conn, store, s.files]),
      builder: (context, _) {
        final keyboard = MediaQuery.viewInsetsOf(context).bottom > 0;
        final showCurtain = !conn.everReady || conn.state == ConnState.failed;
        final active = s.active;
        return PopScope(
          canPop: s.tab == 0 || (!s.files.selecting && (s.files.cwd == '/' || s.files.cwd.isEmpty)),
          onPopInvokedWithResult: (didPop, _) {
            if (didPop || s.tab != 1) return;
            if (s.files.selecting) {
              s.files.clearSelection();
            } else {
              s.files.up().catchError((_) => false);
            }
          },
          child: Scaffold(
            resizeToAvoidBottomInset: true,
            body: SafeArea(
              child: Column(children: [
                _TopBar(session: s, onMenu: _menu, onUpload: () => FilesPane.upload(context, s)),
                if (s.tab == 0 && !showCurtain) _ShellStrip(session: s),
                Expanded(
                  child: Stack(children: [
                    Positioned.fill(
                      // Dimmed while the link is down: visibly "not live".
                      child: AnimatedOpacity(
                        duration: const Duration(milliseconds: 300),
                        opacity: conn.state == ConnState.reconnecting ? 0.45 : 1,
                        child: IndexedStack(index: s.tab, children: [
                          if (showCurtain) const SizedBox() else TerminalPane(session: s, fontSize: store.settings.fontSize),
                          if (showCurtain) const SizedBox() else FilesPane(session: s),
                        ]),
                      ),
                    ),
                    if (conn.state == ConnState.reconnecting && conn.everReady) Positioned(top: 10, left: 0, right: 0, child: _Banner(conn: conn)),
                    if (showCurtain) Positioned.fill(child: _Curtain(session: s, onClose: _close, onEdit: _editServer)),
                  ]),
                ),
                if (keyboard && s.tab == 0 && active != null && store.settings.extraKeys) ExtraKeys(shell: active),
                if (!keyboard)
                  Container(
                    padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
                    decoration: BoxDecoration(border: Border(top: BorderSide(color: p.line))),
                    child: Row(children: [
                      Expanded(
                        child: Seg<int>(
                          expand: true,
                          items: const [(0, 'Terminal', Icons.terminal_rounded), (1, 'Fayllar', Icons.folder_outlined)],
                          value: s.tab,
                          onChanged: (t) {
                            FocusManager.instance.primaryFocus?.unfocus();
                            s.setTab(t);
                          },
                        ),
                      ),
                      const SizedBox(width: 10),
                      TransfersChip(transfers: widget.app.transfers),
                    ]),
                  ),
              ]),
            ),
          ),
        );
      },
    );
  }
}

class _TopBar extends StatelessWidget {
  const _TopBar({required this.session, required this.onMenu, required this.onUpload});
  final Session session;
  final VoidCallback onMenu, onUpload;

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final c = session.conn;
    final st = c.stats;
    final (color, label) = switch (c.state) {
      ConnState.ready => (p.ok, 'Ulangan'),
      ConnState.connecting => (p.warn, 'Ulanmoqda'),
      ConnState.reconnecting => (p.warn, 'Qayta ulanmoqda'),
      ConnState.failed => (p.err, 'Ulanmadi'),
      ConnState.closed => (p.fg3, 'Yopilgan'),
    };
    final bits = <String>[
      label,
      if (c.isReady && st.rtt != null) '${st.rtt} ms',
      if (c.isReady && st.cpu != null) 'CPU ${(st.cpu! * 100).round()}%',
      if (c.isReady && st.memTotal != null && st.memTotal! > 0) 'RAM ${(st.memUsed! * 100 / st.memTotal!).round()}%',
    ];
    return Container(
      height: 56,
      padding: const EdgeInsets.only(left: 4, right: 4),
      decoration: BoxDecoration(border: Border(bottom: BorderSide(color: p.line))),
      child: Row(children: [
        IconBtn(Icons.arrow_back_rounded, tip: 'Serverlar', color: p.fg, onTap: () => Navigator.of(context).maybePop()),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisAlignment: MainAxisAlignment.center, children: [
            Row(children: [
              Flexible(child: Text(session.server.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600))),
              if (session.active?.persistent ?? false) ...[
                const SizedBox(width: 8),
                Tooltip(message: 'tmux: aloqa uzilsa ham sessiya saqlanadi', child: Icon(Icons.shield_outlined, size: 14, color: p.fg3)),
              ],
            ]),
            const SizedBox(height: 2),
            Row(children: [
              Dot(color, size: 6, pulse: c.state == ConnState.connecting || c.state == ConnState.reconnecting),
              const SizedBox(width: 6),
              Flexible(
                child: Text(bits.join(' · '),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(color: p.fg3, fontSize: 12, fontFeatures: const [FontFeature.tabularFigures()])),
              ),
            ]),
          ]),
        ),
        if (session.tab == 1 && c.isReady) IconBtn(Icons.search_rounded, tip: 'Qidirish', onTap: () => FilesPane.openSearch(context, session)),
        if (session.tab == 1 && c.isReady) IconBtn(Icons.upload_rounded, tip: 'Yuklash', onTap: onUpload),
        if (session.tab == 0 && c.isReady) IconBtn(Icons.add_rounded, tip: 'Yangi terminal', size: 24, onTap: session.newShell),
        IconBtn(Icons.more_vert_rounded, tip: 'Yana', onTap: onMenu),
      ]),
    );
  }
}

class _ShellStrip extends StatelessWidget {
  const _ShellStrip({required this.session});
  final Session session;

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final shells = session.conn.shells;
    if (shells.length < 2) return const SizedBox.shrink();
    return Container(
      height: 44,
      decoration: BoxDecoration(border: Border(bottom: BorderSide(color: p.line))),
      child: ListView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6), children: [
        for (var i = 0; i < shells.length; i++)
          Padding(
            padding: const EdgeInsets.only(right: 6),
            child: InkWell(
              borderRadius: BorderRadius.circular(8),
              onTap: () => session.select(shells[i]),
              onLongPress: () => showActions(context, title: 'Terminal ${i + 1}', actions: [
                SheetAction('Yopish', Icons.close_rounded, () => session.closeShell(shells[i]), danger: true),
              ]),
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 14),
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: identical(shells[i], session.active) ? p.active : Colors.transparent,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text('${i + 1}',
                    style: TextStyle(
                      fontFamily: kMono,
                      fontWeight: FontWeight.w500,
                      color: identical(shells[i], session.active) ? p.fg : p.fg3,
                      decoration: shells[i].exited ? TextDecoration.lineThrough : null,
                    )),
              ),
            ),
          ),
      ]),
    );
  }
}

class _Banner extends StatelessWidget {
  const _Banner({required this.conn});
  final Connection conn;

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final secs = conn.retryAt == null ? 0 : conn.retryAt!.difference(DateTime.now()).inSeconds + 1;
    final text = secs > 0 ? 'Aloqa uzildi · $secs s dan so‘ng ulanadi' : 'Aloqa uzildi · qayta ulanmoqda…';
    return Center(
      child: Material(
        color: p.bg2,
        elevation: 6,
        shadowColor: Colors.black54,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(99), side: BorderSide(color: p.line2)),
        child: InkWell(
          borderRadius: BorderRadius.circular(99),
          onTap: conn.retryNow,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              SizedBox(width: 13, height: 13, child: CircularProgressIndicator(strokeWidth: 1.6, color: p.warn)),
              const SizedBox(width: 10),
              Text(text, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w500)),
              if (secs > 0) ...[const SizedBox(width: 10), Text('Hozir', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: p.fg, decoration: TextDecoration.underline))],
            ]),
          ),
        ),
      ),
    );
  }
}

class _Curtain extends StatelessWidget {
  const _Curtain({required this.session, required this.onClose, required this.onEdit});
  final Session session;
  final VoidCallback onClose, onEdit;

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final c = session.conn;
    final failed = c.state == ConnState.failed;
    final info = describeError(c.error);
    return Container(
      color: p.bg,
      alignment: Alignment.center,
      padding: const EdgeInsets.all(28),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        if (failed)
          Container(
            width: 50,
            height: 50,
            decoration: BoxDecoration(color: p.hover, borderRadius: BorderRadius.circular(14)),
            child: Icon(Icons.warning_amber_rounded, color: p.err),
          )
        else
          SizedBox(width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 2, color: p.fg2)),
        const SizedBox(height: 18),
        Text(failed ? info.title : 'Ulanmoqda…', style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
        if (failed) ...[
          const SizedBox(height: 6),
          Text(info.text, textAlign: TextAlign.center, style: TextStyle(color: p.fg2, height: 1.45)),
        ],
        const SizedBox(height: 10),
        Text(session.server.address, style: TextStyle(fontFamily: kMono, fontSize: 12.5, color: p.fg3)),
        const SizedBox(height: 24),
        if (failed)
          Wrap(spacing: 8, runSpacing: 8, alignment: WrapAlignment.center, children: [
            Btn('Qayta urinish', kind: BtnKind.primary, icon: Icons.refresh_rounded, onTap: c.retryNow),
            Btn('Sozlamalar', onTap: onEdit),
            Btn('Yopish', kind: BtnKind.ghost, onTap: onClose),
          ])
        else
          Btn('Bekor qilish', kind: BtnKind.ghost, onTap: onClose),
      ]),
    );
  }
}
