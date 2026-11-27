// Upload / download progress: a compact strip and a sheet with the list.

import 'package:flutter/material.dart';

import '../core/format.dart';
import '../core/transfers.dart';
import '../theme.dart';
import 'files_pane.dart';
import 'widgets.dart';

/// The transfers key of the status row: "⇅ 2 · 45%", "✓ Tayyor", "! Xato".
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
        void open() => showTransfers(context, transfers);
        if (active.isNotEmpty) {
          return StatChip(
            label: '${active.length}',
            icon: waiting ? Icons.sync_rounded : Icons.swap_vert_rounded,
            value: '${total == 0 ? 0 : (done * 100 ~/ total)}',
            unit: '%',
            valueColor: waiting ? p.warn : null,
            onTap: open,
          );
        }
        return StatChip(
          label: failed ? 'Xato' : 'Tayyor',
          icon: failed ? Icons.error_outline_rounded : Icons.check_rounded,
          tone: KeyTone.gray,
          onTap: open,
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
                  const Text('Uzatishlar', style: TextStyle(fontSize: 19, fontWeight: FontWeight.w700)),
                  const Spacer(),
                  Btn('Tozalash', small: true, onTap: transfers.clearFinished),
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
          width: 38,
          height: 38,
          decoration: BoxDecoration(
            color: j.active ? p.signal : p.key2,
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: p.stroke, width: 1.4),
          ),
          child: Icon(j.state == JobState.done ? Icons.check_rounded : j.upload ? Icons.upload_rounded : Icons.download_rounded, size: 19, color: p.ink),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(j.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15)),
            if (j.active) ...[
              const SizedBox(height: 6),
              ClipRRect(
                borderRadius: BorderRadius.circular(2),
                child: LinearProgressIndicator(
                  value: j.progress,
                  minHeight: 5,
                  backgroundColor: p.well,
                  color: j.state == JobState.waiting ? p.warn : p.signal,
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
