// Upload / download progress: a compact strip and a sheet with the list.

import 'package:flutter/material.dart';

import '../core/format.dart';
import '../core/transfers.dart';
import '../theme.dart';
import 'files_pane.dart';
import 'widgets.dart';

class TransfersChip extends StatelessWidget {
  const TransfersChip({super.key, required this.transfers});
  final Transfers transfers;

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    return ListenableBuilder(
      listenable: transfers,
      builder: (context, _) {
        if (transfers.jobs.isEmpty) return const SizedBox.shrink();
        final active = transfers.jobs.where((j) => j.active).toList();
        final failed = transfers.jobs.any((j) => j.state == JobState.error);
        final waiting = active.any((j) => j.state == JobState.waiting);
        final total = active.fold<int>(0, (a, j) => a + j.totalBytes);
        final done = active.fold<int>(0, (a, j) => a + j.doneBytes);
        final (icon, color, label) = active.isNotEmpty
            ? (waiting ? Icons.sync_rounded : Icons.swap_vert_rounded, waiting ? p.warn : p.fg2, '${active.length} · ${total == 0 ? 0 : (done * 100 ~/ total)}%')
            : failed
                ? (Icons.error_outline_rounded, p.err, 'Xato')
                : (Icons.check_rounded, p.ok, 'Tayyor');
        return InkWell(
          borderRadius: BorderRadius.circular(9),
          onTap: () => showTransfers(context, transfers),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
            decoration: BoxDecoration(color: p.hover, borderRadius: BorderRadius.circular(9)),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              Icon(icon, size: 15, color: color),
              const SizedBox(width: 6),
              Text(label, style: TextStyle(color: p.fg2, fontSize: 12.5, fontFeatures: const [FontFeature.tabularFigures()])),
            ]),
          ),
        );
      },
    );
  }
}

Future<void> showTransfers(BuildContext context, Transfers transfers) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    builder: (ctx) => ListenableBuilder(
      listenable: transfers,
      builder: (ctx, _) {
        final p = ctx.pal;
        final jobs = transfers.jobs.reversed.toList();
        return SafeArea(
          child: ConstrainedBox(
            constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(ctx).height * 0.6),
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 0, 12, 8),
                child: Row(children: [
                  const Text('Uzatishlar', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
                  const Spacer(),
                  TextButton(onPressed: transfers.clearFinished, child: Text('Tozalash', style: TextStyle(color: p.fg2))),
                ]),
              ),
              Flexible(
                child: ListView(shrinkWrap: true, padding: const EdgeInsets.fromLTRB(8, 0, 8, 12), children: [
                  for (final j in jobs) _JobRow(job: j, transfers: transfers),
                  if (jobs.isEmpty) Padding(padding: const EdgeInsets.all(24), child: Center(child: Text('Hozircha hech narsa yo‘q', style: TextStyle(color: p.fg3)))),
                ]),
              ),
            ]),
          ),
        );
      },
    ),
  );
}

class _JobRow extends StatelessWidget {
  const _JobRow({required this.job, required this.transfers});
  final Job job;
  final Transfers transfers;

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final j = job;
    final meta = switch (j.state) {
      JobState.waiting => 'Aloqa kutilmoqda — davom ettiriladi',
      JobState.queued => 'Navbatda',
      JobState.error => j.error ?? 'Xato',
      JobState.cancelled => 'Bekor qilindi',
      JobState.done => '${fmtBytes(j.totalBytes)}${j.files.length > 1 ? ' · ${j.files.length} fayl' : ''}',
      JobState.running => [
          '${fmtBytes(j.doneBytes)} / ${fmtBytes(j.totalBytes)}',
          if (j.speed > 0) fmtSpeed(j.speed),
          if (j.files.length > 1) '${j.doneFiles}/${j.files.length}',
        ].join(' · '),
    };
    final metaColor = switch (j.state) {
      JobState.waiting => p.warn,
      JobState.error => p.err,
      _ => p.fg3,
    };
    Widget? action;
    if (j.active) {
      action = IconBtn(Icons.close_rounded, tip: 'Bekor qilish', size: 19, onTap: () => transfers.cancel(j));
    } else if (j.state == JobState.done && !j.upload && j.target != null) {
      action = IconBtn(Icons.open_in_new_rounded, tip: 'Ochish', size: 19, onTap: () => FilesPane.openLocal(j.target!));
    }
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
      child: Row(children: [
        Container(
          width: 36,
          height: 36,
          decoration: BoxDecoration(color: p.hover, borderRadius: BorderRadius.circular(9)),
          child: Icon(j.upload ? Icons.upload_rounded : Icons.download_rounded, size: 19, color: j.state == JobState.done ? p.ok : p.fg2),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(j.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w500)),
            if (j.active) ...[
              const SizedBox(height: 6),
              ClipRRect(
                borderRadius: BorderRadius.circular(2),
                child: LinearProgressIndicator(
                  value: j.progress,
                  minHeight: 3,
                  backgroundColor: p.line2,
                  color: j.state == JobState.waiting ? p.warn : p.fg,
                ),
              ),
            ],
            const SizedBox(height: 5),
            Text(meta, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(color: metaColor, fontSize: 12)),
          ]),
        ),
        ?action,
      ]),
    );
  }
}
