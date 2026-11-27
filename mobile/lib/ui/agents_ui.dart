// AI coding agents on the server (Claude Code, agy): the usage strip under the
// top bar and a sheet with details and "start an agent" buttons.

import 'package:flutter/material.dart';

import '../app_state.dart';
import '../core/agents.dart';
import '../core/format.dart';
import '../theme.dart';
import 'widgets.dart';

const _staleMs = 45 * 60 * 1000;

IconData agentIcon(Agent a) => a == Agent.claude ? Icons.flare_rounded : Icons.navigation_outlined;
String agentLabel(Agent a) => a == Agent.claude ? 'Claude Code' : 'agy (Antigravity)';

Color _tone(Pal p, double used) => used >= 0.9 ? p.err : used >= 0.75 ? p.warn : p.ink2;

/// The most used bucket of each window across agy's model groups.
({UsageWindow? five, UsageWindow? week}) agyWindows(List<AgyGroup>? groups) {
  UsageWindow? five, week;
  for (final g in groups ?? const <AgyGroup>[]) {
    for (final b in g.buckets) {
      final u = b.usage.now;
      if (b.window == '5h' && (five == null || u.used > five.used)) five = u;
      if (b.window == 'week' && (week == null || u.used > week.used)) week = u;
    }
  }
  return (five: five, week: week);
}

class _Meter extends StatelessWidget {
  const _Meter(this.used, {this.width = 22, this.height = 4});
  final double used;
  final double width, height;

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final tone = used >= 0.9 ? p.err : used >= 0.75 ? p.warn : p.signal;
    return Container(
      width: width,
      height: height,
      decoration: BoxDecoration(color: p.well, borderRadius: BorderRadius.circular(height), border: Border.all(color: p.stroke, width: 1.2)),
      alignment: Alignment.centerLeft,
      child: FractionallySizedBox(
        widthFactor: used.clamp(0.0, 1.0),
        child: Container(decoration: BoxDecoration(color: tone, borderRadius: BorderRadius.circular(height))),
      ),
    );
  }
}

/// The AI chips of the status row: "✳ CLAUDE 5 soat 41% hafta 12%" in the
/// signal colour (red when a window is nearly used up); tap opens the sheet.
List<Widget> agentChips(BuildContext context, Session session) {
  final p = context.pal;
  final a = session.agents;
  final chips = <Widget>[];
  void open() => showAgentsSheet(context, session);

  List<Widget> windows(UsageWindow? five, UsageWindow? week, Color fg) {
    Widget win(String label, UsageWindow w) => Row(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.center, children: [
          const SizedBox(width: 8),
          Text(label, style: TextStyle(color: fg, fontSize: 11, fontWeight: FontWeight.w600)),
          const SizedBox(width: 4),
          Text('${(w.used * 100).round()}', style: readoutStyle(16, color: fg)),
          Text('%', style: TextStyle(color: fg, fontSize: 10.5, fontWeight: FontWeight.w700)),
        ]);
    return [if (five != null) win('5 soat', five), if (week != null) win('hafta', week)];
  }

  KeyTone toneFor(UsageWindow? five, UsageWindow? week) {
    final worst = [five?.used ?? 0, week?.used ?? 0].reduce((x, y) => x > y ? x : y);
    return worst >= 0.9 ? KeyTone.danger : KeyTone.signal;
  }

  if (a.has(Agent.claude) || a.bridged) {
    final u = a.claudeUsage;
    if (!a.bridged) {
      chips.add(StatChip(label: 'Claude', icon: agentIcon(Agent.claude), onTap: open, children: [
        const SizedBox(width: 7),
        Text('limitni ulash', style: TextStyle(color: p.ink, fontSize: 11.5, fontWeight: FontWeight.w600, decoration: TextDecoration.underline, decorationThickness: 1.5)),
      ]));
    } else if (u != null && (u.five != null || u.week != null)) {
      final five = u.five?.now, week = u.week?.now;
      final tone = toneFor(five, week);
      final fg = keyColors(p, tone).$2;
      final stale = nowMs() - u.t > _staleMs;
      chips.add(Opacity(
        opacity: stale ? 0.7 : 1,
        child: StatChip(label: 'Claude', icon: agentIcon(Agent.claude), tone: tone, onTap: open, children: windows(five, week, fg)),
      ));
    } else {
      chips.add(StatChip(label: 'Claude', icon: agentIcon(Agent.claude), value: '–', onTap: open));
    }
  }
  if (a.agyPath != null) {
    final w = agyWindows(a.agyUsage);
    if (a.agyUsage != null) {
      final tone = toneFor(w.five, w.week);
      chips.add(StatChip(label: 'agy', icon: agentIcon(Agent.agy), tone: tone, onTap: open, children: windows(w.five, w.week, keyColors(p, tone).$2)));
    } else if (a.agyBusy) {
      chips.add(StatChip(label: 'agy', icon: agentIcon(Agent.agy), onTap: open, children: [
        const SizedBox(width: 8),
        SizedBox(width: 11, height: 11, child: CircularProgressIndicator(strokeWidth: 1.6, color: p.ink)),
      ]));
    } else if (a.agyError != null) {
      chips.add(StatChip(label: 'agy', icon: agentIcon(Agent.agy), onTap: open, children: [
        const SizedBox(width: 7),
        Text(a.agyError!.code == 'AUTH' ? 'kirilmagan' : 'xato', style: TextStyle(color: p.err, fontSize: 11.5, fontWeight: FontWeight.w700)),
      ]));
    }
  }
  return chips;
}

/* ---------------- details sheet ---------------- */

Future<void> showAgentsSheet(BuildContext context, Session session) {
  if (session.agents.agyPath != null && nowMs() - session.agents.agyAt > 60000) {
    session.agents.refreshAgy();
  }
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    builder: (ctx) => ListenableBuilder(
      listenable: session.agents,
      builder: (ctx, _) => SafeArea(
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(ctx).height * 0.85),
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
            child: _AgentsSheetBody(session: session),
          ),
        ),
      ),
    ),
  );
}

class _AgentsSheetBody extends StatefulWidget {
  const _AgentsSheetBody({required this.session});
  final Session session;

  @override
  State<_AgentsSheetBody> createState() => _AgentsSheetBodyState();
}

class _AgentsSheetBodyState extends State<_AgentsSheetBody> {
  bool _busy = false;
  Session get s => widget.session;
  Agents get a => s.agents;

  Future<void> _run(Future<void> Function() fn, String ok) async {
    setState(() => _busy = true);
    try {
      await fn();
      if (mounted) toast(context, ok);
    } catch (e) {
      if (mounted) toast(context, '$e', error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _launch(Agent kind, {bool resume = false}) {
    Navigator.pop(context);
    s.launchAgent(kind, resume: resume);
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final sections = <Widget>[];

    Widget head(IconData ic, String title, [List<Widget> trailing = const []]) => Padding(
          padding: const EdgeInsets.only(bottom: 4),
          child: Row(children: [
            Container(
              width: 32,
              height: 32,
              decoration: BoxDecoration(color: p.key2, borderRadius: BorderRadius.circular(9), border: Border.all(color: p.stroke, width: 1.4)),
              child: Icon(ic, size: 17, color: p.ink),
            ),
            const SizedBox(width: 11),
            Expanded(child: Text(title, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700))),
            ...trailing,
          ]),
        );

    // Start an agent: a new terminal, where the current one is.
    final kinds = [for (final k in Agent.values) if (a.has(k)) k];
    if (kinds.isNotEmpty) {
      sections.add(Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        for (final k in kinds)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Row(children: [
              Expanded(child: Btn(agentLabel(k), icon: agentIcon(k), kind: BtnKind.primary, expand: true, onTap: () => _launch(k))),
              const SizedBox(width: 8),
              Btn('Davom ettirish', icon: Icons.history_rounded, onTap: () => _launch(k, resume: true)),
            ]),
          ),
      ]));
    }

    if (a.has(Agent.claude) || a.bridged) sections.add(_claude(p, head));
    if (a.agyPath != null) sections.add(_agy(p, head));
    if (sections.isEmpty) {
      sections.add(Padding(
        padding: const EdgeInsets.symmetric(vertical: 12),
        child: Text(a.detected ? 'Bu serverda Claude Code ham, agy ham topilmadi.' : 'Tekshirilmoqda…', style: TextStyle(color: p.fg2)),
      ));
    }

    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
      Row(children: [
        const Text('AI agentlar', style: TextStyle(fontSize: 19, fontWeight: FontWeight.w700)),
        const SizedBox(width: 8),
        Expanded(child: Text(s.server.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: p.ink3, fontSize: 13.5))),
      ]),
      const SizedBox(height: 16),
      for (var i = 0; i < sections.length; i++) ...[
        if (i > 0) Padding(padding: const EdgeInsets.symmetric(vertical: 12), child: Divider(height: 1, color: p.line)),
        sections[i],
      ],
    ]);
  }

  Widget _bar(Pal p, String label, UsageWindow? w, {String? extra}) {
    if (w == null) return const SizedBox.shrink();
    final r = w.resetAt;
    final when = r != null ? '${fmtWhen(r)} da tiklanadi · ${fmtUntil(r)}' : w.wasReset ? 'tiklandi' : null;
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
          Expanded(child: Text(label, style: TextStyle(color: p.ink2, fontSize: 14.5, fontWeight: FontWeight.w500))),
          Text('${(w.used * 100).round()}', style: dotStyle(22, color: w.used >= 0.75 ? _tone(p, w.used) : p.ink)),
          Text('% ishlatilgan', style: TextStyle(color: p.ink3, fontSize: 12.5)),
        ]),
        const SizedBox(height: 7),
        LayoutBuilder(builder: (ctx, c) => _Meter(w.used, width: c.maxWidth, height: 9)),
        if (when != null || extra != null) ...[
          const SizedBox(height: 6),
          Text([when, extra].whereType<String>().join(' · '), style: TextStyle(color: p.fg3, fontSize: 12)),
        ],
      ]),
    );
  }

  Widget _claude(Pal p, Widget Function(IconData, String, [List<Widget>]) head) {
    if (!a.bridged) {
      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        head(agentIcon(Agent.claude), 'Claude Code'),
        const SizedBox(height: 6),
        Text(
          'Obunangiz limitlari (5 soatlik va haftalik) shu yerda doim ko‘rinib turishi uchun Pult serverdagi Claude Code’ga kichik status line skriptini ulaydi. '
          'O‘zingizning status line’ingiz bo‘lsa, u ham ishlashda davom etadi.',
          style: TextStyle(color: p.fg2, height: 1.45),
        ),
        const SizedBox(height: 6),
        Text('~/.claude/settings.json o‘zgaradi (avvalgi nusxasi saqlanadi). Istalgan vaqtda uzib qo‘yish mumkin.', style: TextStyle(color: p.fg3, fontSize: 12.5)),
        const SizedBox(height: 12),
        Align(
          alignment: Alignment.centerLeft,
          child: Btn('Ulash', kind: BtnKind.primary, busy: _busy, onTap: () => _run(a.installClaude, 'Ulandi — keyingi javobdan so‘ng limitlar chiqadi')),
        ),
      ]);
    }
    final u = a.claudeUsage;
    final now = nowMs();
    final snap = s.active?.session == null ? null : a.claudeSessions[s.active!.session];
    // What Claude does in each terminal (from its hooks).
    final states = <Widget>[
      for (var i = 0; i < s.conn.shells.length; i++)
        if (s.claudeIn(s.conn.shells[i]) case final c?)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Row(children: [
              Container(
                width: 26,
                height: 26,
                alignment: Alignment.center,
                decoration: BoxDecoration(color: c.state == ClaudeState.wait ? p.signal : p.key, borderRadius: BorderRadius.circular(7), border: Border.all(color: p.stroke, width: 1.4)),
                child: Text('${i + 1}', style: dotStyle(15, color: p.ink)),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  c.state == ClaudeState.wait ? waitText(c.ev) : c.state == ClaudeState.done ? 'tugadi · ${fmtAgo(c.ev.t)}' : 'ishlayapti…',
                  style: TextStyle(color: c.state == ClaudeState.wait ? p.ink : p.ink2, fontWeight: c.state == ClaudeState.wait ? FontWeight.w600 : FontWeight.w400),
                ),
              ),
            ]),
          ),
    ];
    final facts = [
      if (snap?.model != null) snap!.model!,
      if (snap?.ctx != null) 'kontekst ${snap!.ctx!.round()}%',
      if (snap?.cost != null) '\$${snap!.cost!.toStringAsFixed(2)}',
    ];
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      head(agentIcon(Agent.claude), 'Claude Code', [
        if (u != null) Text(fmtAgo(u.t), style: TextStyle(color: now - u.t > _staleMs ? p.warn : p.fg3, fontSize: 12)),
        const SizedBox(width: 4),
        Btn('Uzish', kind: BtnKind.ghost, busy: _busy, onTap: () => _run(a.removeClaude, 'Avvalgi sozlamalar qaytarildi')),
      ]),
      if (u == null)
        Padding(
          padding: const EdgeInsets.only(top: 6),
          child: Text(
            a.claudeSeen
                ? 'Bu hisobda obuna limitlari yo‘q — ular faqat Pro/Max obunada bo‘ladi.'
                : 'Hali ma’lumot yo‘q: Claude Code’da bitta xabar yuboring — limitlar birinchi javobdan keyin chiqadi.',
            style: TextStyle(color: p.fg3, height: 1.45),
          ),
        )
      else ...[
        _bar(p, '5 soatlik limit', u.five?.now),
        _bar(p, 'Haftalik limit', u.week?.now),
        _bar(p, 'Sarf limiti', u.spend?.now),
      ],
      if (facts.isNotEmpty)
        Padding(
          padding: const EdgeInsets.only(top: 12),
          child: Row(children: [
            Icon(Icons.terminal_rounded, size: 15, color: p.ink3),
            const SizedBox(width: 6),
            Expanded(child: Text(facts.join(' · '), style: TextStyle(color: p.ink2, fontSize: 13))),
          ]),
        ),
      ...states,
      if (!a.hooks)
        Container(
          margin: const EdgeInsets.only(top: 14),
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(color: p.well, borderRadius: BorderRadius.circular(12), border: Border.all(color: p.line2, width: 1.4)),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Yangi: har bir terminalda Claude nima qilayotgani — ishlayapti, ruxsat so‘rayapti yoki tugadi — ko‘rinadi.', style: TextStyle(color: p.ink2, height: 1.45)),
            const SizedBox(height: 10),
            Btn('Yoqish', kind: BtnKind.primary, small: true, busy: _busy, onTap: () => _run(a.installClaude, 'Yoqildi — Claude’ning keyingi xabaridan boshlab holati ko‘rinadi')),
          ]),
        ),
    ]);
  }

  Widget _agy(Pal p, Widget Function(IconData, String, [List<Widget>]) head) {
    final groups = a.agyUsage ?? const <AgyGroup>[];
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      head(agentIcon(Agent.agy), 'Antigravity CLI (agy)', [
        if (a.agyAt > 0) Text(fmtAgo(a.agyAt), style: TextStyle(color: p.fg3, fontSize: 12)),
        if (a.agyBusy)
          Padding(padding: const EdgeInsets.all(12), child: SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 1.6, color: p.fg3)))
        else
          IconBtn(Icons.refresh_rounded, tip: 'Yangilash', size: 19, onTap: a.refreshAgy),
      ]),
      if (a.agyError != null)
        Padding(
          padding: const EdgeInsets.only(top: 6),
          child: Text(a.agyError!.message, style: TextStyle(color: a.agyError!.code == 'AUTH' ? p.warn : p.err, height: 1.4)),
        ),
      for (final g in groups) ...[
        Padding(
          padding: const EdgeInsets.only(top: 12),
          child: Text(g.name.toUpperCase(), style: TextStyle(color: p.fg3, fontSize: 11, fontWeight: FontWeight.w600, letterSpacing: 0.6)),
        ),
        for (final b in g.buckets) _bar(p, b.window == '5h' ? '5 soatlik' : b.window == 'week' ? 'Haftalik' : b.window == 'day' ? 'Kunlik' : b.window, b.usage.now),
      ],
      if (groups.isEmpty && a.agyError == null)
        Padding(padding: const EdgeInsets.only(top: 6), child: Text(a.agyBusy ? 'Limitlar olinmoqda…' : 'Hali ma’lumot yo‘q.', style: TextStyle(color: p.fg3))),
    ]);
  }
}
