// A connected server: terminal and files, sharing one SSH link. The terminal
// sits on a black screen in a bezel; the mode keys and the status chips (ping,
// CPU, RAM, AI limits) are at the bottom, like the desktop app.

import 'dart:async';

import 'package:flutter/material.dart';

import '../app_state.dart';
import '../core/agents.dart';
import '../core/connection.dart';
import '../core/store.dart';
import '../theme.dart';
import 'agents_ui.dart';
import 'files_pane.dart';
import 'home_page.dart';
import 'prompts.dart';
import 'server_form.dart';
import 'snippets.dart';
import 'stats_sheet.dart';
import 'terminal_pane.dart';
import 'transfers_sheet.dart';
import 'tunnels_sheet.dart';
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
    widget.app.setFront(s.server.id);
    // Countdown in the reconnect banner.
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (conn.state == ConnState.reconnecting && mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _tick?.cancel();
    if (widget.app.front == s.server.id) widget.app.setFront(null);
    super.dispose();
  }

  Future<void> _close() async {
    final busy = [for (final sh in conn.shells) ?s.busyIn(sh)];
    if (busy.isNotEmpty) {
      final ok = await confirm(context,
          title: 'Ulanish yopilsinmi?',
          message: 'Terminallarda ${busy.toSet().join(', ')} ishlayapti. Ulanish yopilsa ham ular serverda (tmux’da) ishlashda davom etadi — keyin qayta ulanib, davom ettirasiz.',
          ok: 'Yopish');
      if (!ok || !mounted) return;
    }
    if (!mounted) return;
    Navigator.of(context).pop();
    await widget.app.close(s);
  }

  /// Closing a terminal kills its tmux session: ask first if a program runs in it.
  Future<void> _closeShell(RemoteShell sh) async {
    final what = s.busyIn(sh);
    if (what != null) {
      final n = conn.shells.indexOf(sh) + 1;
      final ok = await confirm(context,
          title: 'Terminal $n yopilsinmi?', message: 'Unda hozir $what ishlayapti. Terminal yopilsa, u to‘xtaydi va serverdagi sessiya ham o‘chadi.', ok: 'Yopish', danger: true);
      if (!ok) return;
    }
    await s.closeShell(sh);
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
    final ready = conn.isReady;
    showActions(context, title: s.server.name, subtitle: s.server.address, actions: [
      if (term && ready) SheetAction('Yangi terminal', Icons.add_rounded, () => s.newShell()),
      for (final k in Agent.values)
        if (s.agents.has(k)) SheetAction(term ? agentLabel(k) : '${agentLabel(k)} shu papkada', agentIcon(k), () => s.launchAgent(k, dir: term ? null : s.files.cwd)),
      if (s.agents.any) SheetAction('AI limitlari', Icons.speed_rounded, () => showAgentsSheet(context, s)),
      if (term) SheetAction('Tez buyruqlar', Icons.bolt_rounded, () => showSnippets(context, s)),
      if (ready) SheetAction('Portlar (SSH tunnel)', Icons.lan_outlined, () => showTunnels(context, s)),
      SheetAction('Server holati', Icons.monitor_heart_outlined, () => showStats(context, s)),
      if (term && s.active != null) SheetAction('Terminalni yopish', Icons.close_rounded, () => _closeShell(s.active!)),
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

  void _shellActions(RemoteShell sh) {
    final n = conn.shells.indexOf(sh) + 1;
    final agent = s.agentIn(sh);
    final pane = sh.session == null ? null : s.agents.panes[sh.session];
    final title = cleanTitle(pane?.title ?? '');
    showActions(context, title: 'Terminal $n', subtitle: [if (agent != null) agentLabel(agent), if (title.isNotEmpty) title, sh.session ?? 'tmux’siz'].join(' · '), actions: [
      SheetAction('Ochish', Icons.terminal_rounded, () => s.select(sh)),
      if (pane?.cwd != null && pane!.cwd.isNotEmpty) SheetAction('Papkasini fayllarda ochish', Icons.folder_open_rounded, () {
        s.setTab(1);
        s.files.go(pane.cwd).catchError((_) => false);
      }),
      null,
      SheetAction('Yopish', Icons.close_rounded, () => _closeShell(sh), danger: true),
    ]);
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    return ListenableBuilder(
      listenable: Listenable.merge([s, conn, store, s.files, s.agents, s.tunnels]),
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
                if (s.tab == 0 && !showCurtain) _ShellStrip(session: s, onLong: _shellActions),
                Expanded(
                  child: Stack(children: [
                    Positioned.fill(
                      // Dimmed while the link is down: visibly "not live".
                      child: AnimatedOpacity(
                        duration: const Duration(milliseconds: 300),
                        opacity: conn.state == ConnState.reconnecting ? 0.5 : 1,
                        child: IndexedStack(index: s.tab, children: [
                          if (showCurtain) const SizedBox() else _Screen(child: TerminalPane(session: s, fontSize: store.settings.fontSize)),
                          if (showCurtain)
                            const SizedBox()
                          else
                            Padding(
                              padding: const EdgeInsets.fromLTRB(8, 2, 8, 6),
                              child: Container(
                                clipBehavior: Clip.antiAlias,
                                decoration: BoxDecoration(
                                  color: p.paper,
                                  borderRadius: BorderRadius.circular(16),
                                  border: Border.all(color: p.stroke, width: 1.4),
                                  boxShadow: [BoxShadow(color: p.keyShadow, offset: const Offset(0, 3))],
                                ),
                                child: FilesPane(session: s),
                              ),
                            ),
                        ]),
                      ),
                    ),
                    if (conn.state == ConnState.reconnecting && conn.everReady) Positioned(top: 12, left: 0, right: 0, child: _Banner(conn: conn)),
                    if (showCurtain) Positioned.fill(child: _Curtain(session: s, onClose: _close, onEdit: _editServer)),
                  ]),
                ),
                if (keyboard && s.tab == 0 && active != null && store.settings.extraKeys) ExtraKeys(shell: active, session: s),
                if (!keyboard && !showCurtain) StatusChips(session: s),
                if (!keyboard)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(10, 4, 10, 8),
                    child: Seg<int>(
                      expand: true,
                      height: 46,
                      items: const [(0, 'Terminal', Icons.terminal_rounded), (1, 'Fayllar', Icons.folder_outlined)],
                      value: s.tab,
                      onChanged: (t) {
                        FocusManager.instance.primaryFocus?.unfocus();
                        s.setTab(t);
                      },
                    ),
                  ),
              ]),
            ),
          ),
        );
      },
    );
  }
}

/// The black screen in its bezel.
class _Screen extends StatelessWidget {
  const _Screen({required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    return Padding(
      padding: const EdgeInsets.fromLTRB(8, 2, 8, 6),
      child: Container(
        padding: const EdgeInsets.all(4),
        decoration: BoxDecoration(
          color: p.bezel,
          borderRadius: BorderRadius.circular(16),
          boxShadow: [BoxShadow(color: p.isDark ? Colors.black : const Color(0xFF55585C), offset: const Offset(0, 3))],
        ),
        child: Container(
          clipBehavior: Clip.antiAlias,
          decoration: BoxDecoration(color: p.screen, borderRadius: BorderRadius.circular(12), border: Border.all(color: p.screenRing)),
          child: child,
        ),
      ),
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
    final (color, label) = switch (c.state) {
      ConnState.ready => (p.ink, 'Ulangan'),
      ConnState.connecting => (p.warn, 'Ulanmoqda'),
      ConnState.reconnecting => (p.warn, 'Qayta ulanmoqda'),
      ConnState.failed => (p.err, 'Ulanmadi'),
      ConnState.closed => (p.ink4, 'Yopilgan'),
    };
    final bits = <String>[
      label,
      if (c.isReady) (session.active?.persistent ?? false) ? 'tmux saqlaydi' : session.server.address,
    ];
    final files = session.tab == 1;
    return Padding(
      padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
      child: Row(children: [
        KeyIcon(Icons.arrow_back_rounded, tip: 'Serverlar', tone: KeyTone.light, onTap: () => Navigator.of(context).maybePop()),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Text(session.server.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700, letterSpacing: -0.2)),
            const SizedBox(height: 2),
            Row(children: [
              Dot(color, size: 7, pulse: c.state == ConnState.connecting || c.state == ConnState.reconnecting),
              const SizedBox(width: 6),
              Flexible(child: Text(bits.join(' · '), maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: p.ink2, fontSize: 12.5, fontWeight: FontWeight.w500))),
            ]),
          ]),
        ),
        if (files && c.isReady) ...[
          KeyIcon(Icons.search_rounded, tip: 'Qidirish', onTap: () => FilesPane.openSearch(context, session)),
          const SizedBox(width: 8),
          KeyIcon(Icons.upload_rounded, tip: 'Yuklash', tone: KeyTone.signal, onTap: onUpload),
          const SizedBox(width: 8),
        ],
        if (!files && c.isReady && session.agents.any) ...[
          KeyIcon(Icons.auto_awesome_rounded, tip: 'AI agentlar', tone: KeyTone.ink, onTap: () => showAgentsSheet(context, session)),
          const SizedBox(width: 8),
        ],
        KeyIcon(Icons.more_horiz_rounded, tip: 'Yana', onTap: onMenu),
      ]),
    );
  }
}

/// Terminal keys: "1  ✳2 !  3  +  ⚡". The one on screen is ink; a key gets a
/// "!" when Claude waits for you there (or a bell rang), a ✓ when it finished.
class _ShellStrip extends StatelessWidget {
  const _ShellStrip({required this.session, required this.onLong});
  final Session session;
  final void Function(RemoteShell) onLong;

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final shells = session.conn.shells;
    final ready = session.conn.isReady;
    return SizedBox(
      height: 54,
      child: Row(children: [
        Expanded(
          child: ListView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.fromLTRB(10, 7, 4, 0), children: [
            for (var i = 0; i < shells.length; i++) ...[
              _shellKey(context, p, shells[i], i),
              const SizedBox(width: 8),
            ],
            KeyIcon(Icons.add_rounded, tip: 'Yangi terminal', tone: KeyTone.light, onTap: ready ? session.newShell : null),
          ]),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(4, 7, 10, 0),
          child: KeyCap(
            tone: KeyTone.gray,
            tip: 'Tez buyruqlar',
            padding: const EdgeInsets.symmetric(horizontal: 12),
            onTap: ready ? () => showSnippets(context, session) : null,
            child: const Row(mainAxisSize: MainAxisSize.min, children: [Icon(Icons.bolt_rounded, size: 18), SizedBox(width: 4), Text('Buyruqlar', style: TextStyle(fontSize: 13.5))]),
          ),
        ),
      ]),
    );
  }

  Widget _shellKey(BuildContext context, Pal p, RemoteShell sh, int i) {
    final on = identical(sh, session.active);
    final agent = session.agentIn(sh);
    final claude = session.claudeIn(sh);
    final tone = on ? KeyTone.ink : KeyTone.light;
    final fg = keyColors(p, tone).$2;
    Widget? badge;
    if (claude?.state == ClaudeState.wait || sh.attention) {
      badge = const KeyBadge();
    } else if (claude?.state == ClaudeState.done && !on) {
      badge = KeyBadge(text: '✓', color: p.key);
    }
    return KeyCap(
      tone: tone,
      height: 40,
      padding: const EdgeInsets.symmetric(horizontal: 12),
      badge: badge,
      onTap: () => session.select(sh),
      onLongPress: () => onLong(sh),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        if (agent != null) ...[
          claude?.state == ClaudeState.work ? _Working(color: on ? p.signal : fg) : Icon(agentIcon(agent), size: 14, color: on ? p.signal : fg),
          const SizedBox(width: 5),
        ],
        Text('${i + 1}',
            style: dotStyle(20, color: fg).copyWith(
              decoration: sh.exited ? TextDecoration.lineThrough : null,
            )),
      ]),
    );
  }
}

/// Claude is working: a small turning mark.
class _Working extends StatefulWidget {
  const _Working({required this.color});
  final Color color;
  @override
  State<_Working> createState() => _WorkingState();
}

class _WorkingState extends State<_Working> with SingleTickerProviderStateMixin {
  late final _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 1600))..repeat();
  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => RotationTransition(turns: _c, child: Icon(Icons.flare_rounded, size: 14, color: widget.color));
}

/// The compact status row: PING · CPU · RAM · DISK · AI limits · transfers · ports.
class StatusChips extends StatelessWidget {
  const StatusChips({super.key, required this.session});
  final Session session;

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final c = session.conn;
    final st = c.stats;
    final app = session.app;
    void stats() => showStats(context, session);
    final mem = st.memTotal != null && st.memTotal! > 0 && st.memUsed != null ? st.memUsed! / st.memTotal! : null;
    final disk = st.diskTotal != null && st.diskTotal! > 0 && st.diskUsed != null ? st.diskUsed! / st.diskTotal! : null;
    Color? tone(double? v) => v == null ? null : v >= 0.9 ? p.err : v >= 0.75 ? p.warn : null;
    final chips = <Widget>[
      if (app.store.settings.agentUsage) ...agentChips(context, session),
      // Kept (with dashes) while the link is down: no layout jump.
      if (c.isReady || c.state == ConnState.reconnecting) ...[
        StatChip(label: 'Ping', value: st.rtt == null || !c.isReady ? '–' : '${st.rtt}', unit: 'ms', onTap: stats, valueColor: (st.rtt ?? 0) > 400 ? p.warn : null),
        StatChip(label: 'CPU', value: st.cpu == null || !c.isReady ? '–' : '${(st.cpu! * 100).round()}', unit: '%', onTap: stats, valueColor: tone(st.cpu)),
        StatChip(label: 'RAM', value: mem == null || !c.isReady ? '–' : '${(mem * 100).round()}', unit: '%', onTap: stats, valueColor: tone(mem)),
        if (disk != null) StatChip(label: 'Disk', value: '${(disk * 100).round()}', unit: '%', onTap: stats, valueColor: tone(disk)),
        if (session.tunnels.list.isNotEmpty)
          StatChip(label: 'Port', value: '${session.tunnels.list.length}', tone: KeyTone.gray, icon: Icons.lan_outlined, onTap: () => showTunnels(context, session)),
        if (st.uptime != null) StatChip(label: 'Uptime', value: fmtUptimeShort(st.uptime!).$1, unit: fmtUptimeShort(st.uptime!).$2, tone: KeyTone.gray, onTap: stats),
      ],
    ];
    return SizedBox(
      height: 42,
      child: Row(children: [
        Expanded(
          child: ListView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.fromLTRB(10, 4, 6, 0),
            children: [
              for (var i = 0; i < chips.length; i++) ...[if (i > 0) const SizedBox(width: 5), chips[i]],
            ],
          ),
        ),
        Padding(padding: const EdgeInsets.fromLTRB(0, 4, 10, 0), child: TransfersChip(transfers: app.transfers)),
      ]),
    );
  }
}

/// "12 kun", "5 soat", "40 daq" for the uptime chip.
(String, String) fmtUptimeShort(double secs) {
  final s = secs.round();
  if (s >= 86400) return ('${s ~/ 86400}', 'kun');
  if (s >= 3600) return ('${s ~/ 3600}', 'soat');
  return ('${s ~/ 60}', 'daq');
}

class _Banner extends StatelessWidget {
  const _Banner({required this.conn});
  final Connection conn;

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final secs = conn.retryAt == null ? 0 : conn.retryAt!.difference(DateTime.now()).inSeconds + 1;
    final text = secs > 0 ? 'Aloqa uzildi · $secs s dan so‘ng' : 'Aloqa uzildi · qayta ulanmoqda…';
    return Center(
      child: KeyCap(
        tone: KeyTone.signal,
        height: 40,
        radius: 20,
        padding: const EdgeInsets.symmetric(horizontal: 16),
        onTap: conn.retryNow,
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2, color: p.onSignal)),
          const SizedBox(width: 10),
          Text(text, style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600)),
          if (secs > 0) ...[const SizedBox(width: 10), const Text('Hozir', style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w800, decoration: TextDecoration.underline))],
        ]),
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
      color: p.body,
      alignment: Alignment.center,
      padding: const EdgeInsets.all(20),
      child: Container(
        padding: const EdgeInsets.fromLTRB(22, 26, 22, 22),
        decoration: BoxDecoration(
          color: p.paper,
          borderRadius: BorderRadius.circular(18),
          border: Border.all(color: p.stroke, width: 1.4),
          boxShadow: [BoxShadow(color: p.keyShadow, offset: const Offset(0, 4))],
        ),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Container(
            width: 56,
            height: 56,
            alignment: Alignment.center,
            decoration: BoxDecoration(color: failed ? p.err : p.key2, borderRadius: BorderRadius.circular(13), border: Border.all(color: p.stroke, width: 1.4)),
            child: failed ? Icon(Icons.priority_high_rounded, color: p.isDark ? p.onInk : Colors.white, size: 28) : Text(monogram(session.server), style: dotStyle(24, color: p.ink)),
          ),
          const SizedBox(height: 18),
          Text(failed ? info.title : 'Ulanmoqda…', textAlign: TextAlign.center, style: const TextStyle(fontSize: 19, fontWeight: FontWeight.w700)),
          if (failed) ...[
            const SizedBox(height: 8),
            Text(info.text, textAlign: TextAlign.center, style: TextStyle(color: p.ink2, height: 1.45, fontSize: 14.5)),
          ] else ...[
            const SizedBox(height: 14),
            SizedBox(width: 160, child: ClipRRect(borderRadius: BorderRadius.circular(3), child: LinearProgressIndicator(minHeight: 5, backgroundColor: p.well, color: p.signal))),
          ],
          const SizedBox(height: 12),
          Text(session.server.address, style: TextStyle(fontFamily: kMono, fontSize: 13, color: p.ink3)),
          const SizedBox(height: 22),
          if (failed)
            Wrap(spacing: 8, runSpacing: 10, alignment: WrapAlignment.center, children: [
              Btn('Qayta urinish', kind: BtnKind.primary, icon: Icons.refresh_rounded, onTap: c.retryNow),
              Btn('Sozlamalar', onTap: onEdit),
              Btn('Yopish', kind: BtnKind.ghost, onTap: onClose),
            ])
          else
            Btn('Bekor qilish', onTap: onClose),
        ]),
      ),
    );
  }
}
