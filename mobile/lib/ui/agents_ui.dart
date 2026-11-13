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

Color _tone(Pal p, double used) => used >= 0.9 ? p.err : used >= 0.75 ? p.warn : p.fg2;

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
    return Container(
      width: width,
      height: height,
      decoration: BoxDecoration(color: p.line2, borderRadius: BorderRadius.circular(height)),
      alignment: Alignment.centerLeft,
      child: FractionallySizedBox(
        widthFactor: used.clamp(0.04, 1.0),
        child: Container(decoration: BoxDecoration(color: _tone(p, used), borderRadius: BorderRadius.circular(height))),
      ),
    );
  }
}

/// "Claude  5 soat ▰▱ 41%  hafta ▰▱ 12%" chips; tap opens the details sheet.
class AgentBar extends StatelessWidget {
  const AgentBar({super.key, required this.session});
  final Session session;

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final a = session.agents;
    final chips = <Widget>[];

    // One window per line: "5 soat ▰▱ 41%" over "hafta ▰▱ 12%" keeps both
    // agents on a phone-wide strip.
    Widget win(String label, UsageWindow? w) => w == null
        ? const SizedBox.shrink()
        : Row(mainAxisSize: MainAxisSize.min, children: [
            SizedBox(width: 38, child: Text(label, style: TextStyle(color: p.fg3, fontSize: 11, height: 1.2))),
            _Meter(w.used, width: 18, height: 3),
            const SizedBox(width: 5),
            SizedBox(
              width: 30,
              child: Text('${(w.used * 100).round()}%',
                  textAlign: TextAlign.right,
                  style: TextStyle(color: w.used >= 0.75 ? _tone(p, w.used) : p.fg2, fontSize: 11, height: 1.2, fontWeight: FontWeight.w500, fontFeatures: const [FontFeature.tabularFigures()])),
            ),
          ]);
    List<Widget> windows(UsageWindow? five, UsageWindow? week) => [
          const SizedBox(width: 10),
          Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [win('5 soat', five), win('hafta', week)]),
        ];
    Widget chip(Agent kind, String name, List<Widget> body, {bool dim = false}) => InkWell(
          borderRadius: BorderRadius.circular(8),
          onTap: () => showAgentsSheet(context, session),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 6),
            child: Opacity(
              opacity: dim ? 0.6 : 1,
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                Icon(agentIcon(kind), size: 14, color: p.fg3),
                const SizedBox(width: 6),
                Text(name, style: TextStyle(color: p.fg2, fontSize: 12.5, fontWeight: FontWeight.w500)),
                ...body,
              ]),
            ),
          ),
        );
    Widget note(String t, {Color? color, bool underline = false}) => Padding(
          padding: const EdgeInsets.only(left: 10),
          child: Text(t,
              style: TextStyle(
                color: color ?? p.fg3,
                fontSize: 12,
                decoration: underline ? TextDecoration.underline : null,
                decorationColor: p.line2,
              )),
        );

    if (a.has(Agent.claude) || a.bridged) {
      final u = a.claudeUsage;
      if (!a.bridged) {
        chips.add(chip(Agent.claude, 'Claude', [note('limitni ulash', color: p.fg2, underline: true)]));
      } else if (u != null && (u.five != null || u.week != null)) {
        chips.add(chip(Agent.claude, 'Claude', windows(u.five?.now, u.week?.now), dim: nowMs() - u.t > _staleMs));
      } else {
        chips.add(chip(Agent.claude, 'Claude', [note('—')]));
      }
    }
    if (a.agyPath != null) {
      final w = agyWindows(a.agyUsage);
      if (a.agyUsage != null) {
        chips.add(chip(Agent.agy, 'agy', windows(w.five, w.week), dim: a.agyError != null));
      } else if (a.agyBusy) {
        chips.add(chip(Agent.agy, 'agy', [
          Padding(padding: const EdgeInsets.only(left: 10), child: SizedBox(width: 10, height: 10, child: CircularProgressIndicator(strokeWidth: 1.4, color: p.fg3))),
        ]));
      } else if (a.agyError != null) {
        chips.add(chip(Agent.agy, 'agy', [note(a.agyError!.code == 'AUTH' ? 'kirilmagan' : 'xato', color: p.warn)]));
      }
    }
    if (chips.isEmpty) return const SizedBox.shrink();
    return Container(
      height: 40,
      decoration: BoxDecoration(border: Border(bottom: BorderSide(color: p.line))),
      child: ListView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 8),
        children: [
          for (var i = 0; i < chips.length; i++) ...[
            if (i > 0) Center(child: Container(width: 1, height: 14, margin: const EdgeInsets.symmetric(horizontal: 6), color: p.line2)),
            chips[i],
          ],
        ],
      ),
    );
  }
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
              width: 28,
              height: 28,
              decoration: BoxDecoration(color: p.hover, borderRadius: BorderRadius.circular(8)),
              child: Icon(ic, size: 16, color: p.fg2),
            ),
            const SizedBox(width: 10),
            Expanded(child: Text(title, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600))),
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
              Expanded(child: Btn(agentLabel(k), icon: agentIcon(k), kind: BtnKind.primary, onTap: () => _launch(k))),
              const SizedBox(width: 8),
              Btn('Oxirgi suhbat', icon: Icons.history_rounded, onTap: () => _launch(k, resume: true)),
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
        const Text('AI agentlar', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
        const SizedBox(width: 8),
        Expanded(child: Text(s.server.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: p.fg3, fontSize: 13))),
      ]),
      const SizedBox(height: 14),
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
        Row(children: [
          Expanded(child: Text(label, style: TextStyle(color: p.fg2, fontSize: 14))),
          Text('${(w.used * 100).round()}%', style: TextStyle(fontWeight: FontWeight.w600, color: w.used >= 0.75 ? _tone(p, w.used) : p.fg, fontFeatures: const [FontFeature.tabularFigures()])),
          Text(' ishlatilgan', style: TextStyle(color: p.fg3, fontSize: 12)),
        ]),
        const SizedBox(height: 7),
        LayoutBuilder(builder: (ctx, c) => _Meter(w.used, width: c.maxWidth, height: 6)),
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
            Icon(Icons.terminal_rounded, size: 14, color: p.fg3),
            const SizedBox(width: 6),
            Expanded(child: Text(facts.join(' · '), style: TextStyle(color: p.fg2, fontSize: 12.5))),
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
