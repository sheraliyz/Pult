// "Server holati": CPU, RAM and ping over the last minutes, and the busiest
// processes (with a way to stop one). Same panel as the desktop app.

import 'dart:math';

import 'package:flutter/material.dart';

import '../app_state.dart';
import '../core/connection.dart';
import '../core/format.dart';
import '../theme.dart';
import 'widgets.dart';

Future<void> showStats(BuildContext context, Session session) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    builder: (ctx) => _StatsBody(session: session),
  );
}

class _Series {
  const _Series(this.label, this.unit, this.pick, {this.max});
  final String label, unit;
  final double? Function(StatSample) pick;
  final double? max; // fixed top (100 for percentages)
}

final _series = [
  _Series('CPU', '%', (s) => s.cpu == null ? null : s.cpu! * 100, max: 100),
  _Series('RAM', '%', (s) => s.mem == null ? null : s.mem! * 100, max: 100),
  _Series('Ping', 'ms', (s) => s.rtt?.toDouble()),
];

class _StatsBody extends StatefulWidget {
  const _StatsBody({required this.session});
  final Session session;

  @override
  State<_StatsBody> createState() => _StatsBodyState();
}

class _StatsBodyState extends State<_StatsBody> {
  Connection get conn => widget.session.conn;
  late Future<List<Proc>> _procs = _load();

  Future<List<Proc>> _load() => conn.isReady ? conn.processes() : Future.value(const <Proc>[]);

  Future<void> _kill(Proc pr) async {
    final force = await showDialog<bool>(
      context: context,
      builder: (dc) => AlertDialog(
        title: Text('${pr.command.split(' ').first.split('/').last} to‘xtatilsinmi?', style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
        content: Text('PID ${pr.pid} · ${pr.user}\n\n${pr.command}', style: TextStyle(color: dc.pal.ink2, fontFamily: kMono, fontSize: 12.5, height: 1.4)),
        actionsPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        actions: [
          Btn('Bekor', kind: BtnKind.ghost, small: true, onTap: () => Navigator.pop(dc)),
          Btn('Majburan', kind: BtnKind.outline, small: true, onTap: () => Navigator.pop(dc, true)),
          Btn('To‘xtatish', kind: BtnKind.danger, small: true, onTap: () => Navigator.pop(dc, false)),
        ],
      ),
    );
    if (force == null || !mounted) return;
    try {
      final r = await conn.kill(pr.pid, force: force);
      if (!mounted) return;
      if ((r.code ?? 1) != 0) {
        toast(context, r.stderr.trim().isNotEmpty ? r.stderr.trim() : 'To‘xtatib bo‘lmadi (ruxsat yo‘qmi?)', error: true);
      } else {
        toast(context, force ? 'Majburan to‘xtatildi' : 'To‘xtatish so‘raldi');
      }
    } catch (e) {
      if (mounted) toast(context, classify(e).message, error: true);
    }
    await Future<void>.delayed(const Duration(milliseconds: 600));
    if (mounted) setState(() => _procs = _load());
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.9),
        child: ListenableBuilder(
          listenable: conn,
          builder: (context, _) {
            final samples = conn.samples;
            final st = conn.stats;
            return ListView(shrinkWrap: true, padding: const EdgeInsets.fromLTRB(18, 0, 18, 18), children: [
              Row(children: [
                const Text('Server holati', style: TextStyle(fontSize: 19, fontWeight: FontWeight.w700)),
                const SizedBox(width: 8),
                Expanded(child: Text(widget.session.server.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: p.ink3, fontSize: 13.5))),
              ]),
              const SizedBox(height: 4),
              Text(
                [
                  if (st.memTotal != null) 'RAM ${fmtBytes(st.memUsed)} / ${fmtBytes(st.memTotal)}',
                  if (st.diskTotal != null) 'disk ${fmtBytes(st.diskUsed)} / ${fmtBytes(st.diskTotal)}',
                  if (st.uptime != null) 'ishlayapti ${_uptime(st.uptime!)}',
                ].join(' · '),
                style: TextStyle(color: p.ink2, fontSize: 13),
              ),
              for (final s in _series) _Chart(series: s, samples: samples),
              const SizedBox(height: 18),
              Divider(color: p.line),
              const SizedBox(height: 10),
              Row(children: [
                Expanded(child: Text('ENG KO‘P RESURS OLAYOTGAN JARAYONLAR', style: capsStyle(p.ink2, size: 11))),
                IconBtn(Icons.refresh_rounded, size: 19, tip: 'Yangilash', onTap: () => setState(() => _procs = _load())),
              ]),
              FutureBuilder<List<Proc>>(
                future: _procs,
                builder: (context, snap) {
                  if (snap.connectionState != ConnectionState.done) {
                    return Padding(padding: const EdgeInsets.all(18), child: Center(child: SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: p.signal))));
                  }
                  final list = snap.data ?? const <Proc>[];
                  if (snap.hasError || list.isEmpty) {
                    return Padding(
                      padding: const EdgeInsets.symmetric(vertical: 10),
                      child: Text(snap.hasError ? classify(snap.error!).message : 'Jarayonlar topilmadi (serverda ps buyrug‘i yo‘q bo‘lishi mumkin).', style: TextStyle(color: p.ink3)),
                    );
                  }
                  return Column(children: [for (final pr in list) _ProcRow(proc: pr, onTap: () => _kill(pr))]);
                },
              ),
            ]);
          },
        ),
      ),
    );
  }

  static String _uptime(double secs) {
    final s = secs.round();
    final d = s ~/ 86400, h = (s % 86400) ~/ 3600, m = (s % 3600) ~/ 60;
    if (d > 0) return '$d kun $h soat';
    if (h > 0) return '$h soat $m daq';
    return '$m daq';
  }
}

class _ProcRow extends StatelessWidget {
  const _ProcRow({required this.proc, required this.onTap});
  final Proc proc;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final exe = proc.command.split(' ').first.split('/').last;
    return InkWell(
      borderRadius: BorderRadius.circular(10),
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 2),
        child: Row(children: [
          SizedBox(
            width: 58,
            child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
              Text(proc.cpu >= 10 ? proc.cpu.round().toString() : proc.cpu.toStringAsFixed(1), style: dotStyle(18, color: proc.cpu >= 80 ? p.err : p.ink)),
              Text('%', style: TextStyle(color: p.ink3, fontSize: 11, fontWeight: FontWeight.w700)),
            ]),
          ),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(exe.isEmpty ? proc.command : exe, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14.5)),
              Text('${proc.user} · PID ${proc.pid} · RAM ${proc.mem.toStringAsFixed(1)}% (${fmtBytes(proc.rss)})',
                  maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: p.ink3, fontSize: 12, fontFamily: kMono)),
            ]),
          ),
          Icon(Icons.chevron_right_rounded, size: 18, color: p.ink4),
        ]),
      ),
    );
  }
}

/// One series: big current value, average / peak, and an area chart with the
/// last reading marked. Press and slide to read any point.
class _Chart extends StatefulWidget {
  const _Chart({required this.series, required this.samples});
  final _Series series;
  final List<StatSample> samples;

  @override
  State<_Chart> createState() => _ChartState();
}

class _ChartState extends State<_Chart> {
  int? _probe; // index into the points under the finger

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final s = widget.series;
    final pts = <(int, double)>[
      for (final x in widget.samples)
        if (s.pick(x) case final v?) (x.at, v),
    ];
    String fmt(double v) => v.round().toString();
    final cur = pts.isEmpty ? null : pts.last.$2;
    final avg = pts.isEmpty ? null : pts.map((e) => e.$2).reduce((a, b) => a + b) / pts.length;
    final peak = pts.isEmpty ? null : pts.map((e) => e.$2).reduce(max);
    final probe = _probe != null && _probe! < pts.length ? pts[_probe!] : null;
    final span = pts.length < 2 ? 0 : ((pts.last.$1 - pts.first.$1) / 1000).round();
    return Padding(
      padding: const EdgeInsets.only(top: 16),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
          Text(s.label.toUpperCase(), style: capsStyle(p.ink, size: 11.5)),
          const SizedBox(width: 8),
          Text(probe != null ? fmt(probe.$2) : cur == null ? '–' : fmt(cur), style: dotStyle(24, color: p.ink)),
          const SizedBox(width: 3),
          Text(s.unit, style: TextStyle(color: p.ink, fontSize: 12, fontWeight: FontWeight.w700)),
          const Spacer(),
          Text(
            probe != null ? fmtAgoSecs((nowMs() - probe.$1) ~/ 1000) : avg == null ? '' : 'o‘rtacha ${fmt(avg)}${s.unit == '%' ? '%' : ' ${s.unit}'} · eng ko‘p ${fmt(peak!)}${s.unit == '%' ? '%' : ' ${s.unit}'}',
            style: TextStyle(color: p.ink2, fontSize: 12),
          ),
        ]),
        const SizedBox(height: 8),
        LayoutBuilder(builder: (context, c) {
          int? at(Offset o) => pts.length < 2 ? null : (((o.dx - 8) / (c.maxWidth - 16)) * (pts.length - 1)).round().clamp(0, pts.length - 1);
          return GestureDetector(
            onHorizontalDragStart: (d) => setState(() => _probe = at(d.localPosition)),
            onHorizontalDragUpdate: (d) => setState(() => _probe = at(d.localPosition)),
            onHorizontalDragEnd: (_) => setState(() => _probe = null),
            onTapDown: (d) => setState(() => _probe = at(d.localPosition)),
            onTapUp: (_) => setState(() => _probe = null),
            child: Container(
              height: 74,
              decoration: BoxDecoration(color: p.input, borderRadius: BorderRadius.circular(10), border: Border.all(color: p.stroke, width: 1.4)),
              clipBehavior: Clip.antiAlias,
              child: pts.length < 2
                  ? Center(child: Text('Ma’lumot yig‘ilmoqda…', style: TextStyle(color: p.ink3, fontSize: 12.5)))
                  : CustomPaint(painter: _AreaPainter(pts: pts, top: s.max, pal: p, probe: _probe), size: Size(c.maxWidth, 74)),
            ),
          );
        }),
        const SizedBox(height: 4),
        Row(children: [
          Text(span > 0 ? '${fmtAgoSecs(span)} oldin' : '', style: TextStyle(color: p.ink3, fontSize: 11.5)),
          const Spacer(),
          Text('hozir', style: TextStyle(color: p.ink3, fontSize: 11.5)),
        ]),
      ]),
    );
  }
}

/// "28 soniya", "3 daqiqa".
String fmtAgoSecs(int s) => s < 60 ? '$s soniya' : '${s ~/ 60} daqiqa';

class _AreaPainter extends CustomPainter {
  _AreaPainter({required this.pts, required this.top, required this.pal, this.probe});
  final List<(int, double)> pts;
  final double? top;
  final Pal pal;
  final int? probe;

  @override
  void paint(Canvas canvas, Size size) {
    final peak = pts.map((e) => e.$2).reduce(max);
    final hi = top ?? max(10.0, peak * 1.25);
    const pad = 8.0;
    final h = size.height - pad * 2;
    final w = size.width - pad * 2;
    Offset at(int i) => Offset(pad + w * i / (pts.length - 1), pad + h * (1 - (pts[i].$2 / hi).clamp(0.0, 1.0)));
    // Recessive grid: halves.
    final grid = Paint()
      ..color = pal.line
      ..strokeWidth = 1;
    canvas.drawLine(Offset(0, pad + h / 2), Offset(size.width, pad + h / 2), grid);
    final line = Path()..moveTo(at(0).dx, at(0).dy);
    for (var i = 1; i < pts.length; i++) {
      line.lineTo(at(i).dx, at(i).dy);
    }
    final area = Path.from(line)
      ..lineTo(at(pts.length - 1).dx, size.height)
      ..lineTo(at(0).dx, size.height)
      ..close();
    canvas.drawPath(area, Paint()..color = pal.ink.withValues(alpha: 0.08));
    canvas.drawPath(
        line,
        Paint()
          ..color = pal.ink
          ..style = PaintingStyle.stroke
          ..strokeWidth = 2
          ..strokeJoin = StrokeJoin.round);
    final mark = probe ?? pts.length - 1;
    final m = at(mark);
    if (probe != null) canvas.drawLine(Offset(m.dx, 0), Offset(m.dx, size.height), Paint()..color = pal.ink.withValues(alpha: 0.35));
    canvas.drawCircle(m, 6, Paint()..color = pal.stroke);
    canvas.drawCircle(m, 4.6, Paint()..color = pal.signal);
  }

  @override
  bool shouldRepaint(_AreaPainter old) => old.pts != pts || old.probe != probe || old.pts.length != pts.length || old.pal != pal;
}
