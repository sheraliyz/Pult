// Quick commands: saved command lines typed into the terminal with one tap
// (same list format as the desktop app's "Buyruqlar").

import 'package:flutter/material.dart';

import '../app_state.dart';
import '../core/store.dart';
import '../theme.dart';
import 'widgets.dart';

Future<void> showSnippets(BuildContext context, Session session) {
  final store = session.app.store;
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    builder: (ctx) => ListenableBuilder(
      listenable: store,
      builder: (ctx, _) {
        final p = ctx.pal;
        final list = store.settings.snippets;
        return SafeArea(
          child: ConstrainedBox(
            constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(ctx).height * 0.8),
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 0, 14, 6),
                child: Row(children: [
                  const Expanded(child: Text('Tez buyruqlar', style: TextStyle(fontSize: 19, fontWeight: FontWeight.w700))),
                  Btn('Tahrirlash', icon: Icons.edit_outlined, small: true, onTap: () {
                    Navigator.pop(ctx);
                    editSnippets(context, store);
                  }),
                ]),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 0, 20, 10),
                child: Text('Bosilgan buyruq hozirgi terminalga yoziladi.', style: TextStyle(color: p.ink3, fontSize: 13)),
              ),
              Flexible(
                child: list.isEmpty
                    ? Padding(padding: const EdgeInsets.all(24), child: Text('Hali buyruq yo‘q — “Tahrirlash” bilan qo‘shing.', textAlign: TextAlign.center, style: TextStyle(color: p.ink3)))
                    : ListView.separated(
                        shrinkWrap: true,
                        padding: const EdgeInsets.fromLTRB(16, 4, 16, 16),
                        itemCount: list.length,
                        separatorBuilder: (_, _) => const SizedBox(height: 8),
                        itemBuilder: (ctx, i) {
                          final sn = list[i];
                          return KeyCap(
                            height: null,
                            radius: 12,
                            padding: const EdgeInsets.fromLTRB(10, 10, 12, 10),
                            onTap: () {
                              Navigator.pop(ctx);
                              session.runSnippet(sn);
                            },
                            child: Row(children: [
                              Container(
                                width: 30,
                                height: 30,
                                alignment: Alignment.center,
                                decoration: BoxDecoration(color: p.key2, borderRadius: BorderRadius.circular(8), border: Border.all(color: p.stroke, width: 1.4)),
                                child: Text('${i + 1}', style: dotStyle(17, color: p.ink)),
                              ),
                              const SizedBox(width: 12),
                              Expanded(
                                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                  if (sn.name.trim().isNotEmpty) Text(sn.name.trim(), style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
                                  Text(sn.cmd, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(fontFamily: kMono, fontSize: 13.5, color: p.ink2, fontWeight: FontWeight.w400)),
                                ]),
                              ),
                              const SizedBox(width: 8),
                              Icon(sn.run ? Icons.keyboard_return_rounded : Icons.edit_note_rounded, size: 18, color: p.ink3),
                            ]),
                          );
                        },
                      ),
              ),
            ]),
          ),
        );
      },
    ),
  );
}

/// Add, change, reorder and delete quick commands.
Future<void> editSnippets(BuildContext context, Store store) {
  return Navigator.of(context).push(MaterialPageRoute(builder: (_) => _SnippetEditor(store: store)));
}

class _Row {
  _Row(Snippet s)
      : name = TextEditingController(text: s.name),
        cmd = TextEditingController(text: s.cmd),
        run = s.run;
  final TextEditingController name, cmd;
  bool run;
}

class _SnippetEditor extends StatefulWidget {
  const _SnippetEditor({required this.store});
  final Store store;

  @override
  State<_SnippetEditor> createState() => _SnippetEditorState();
}

class _SnippetEditorState extends State<_SnippetEditor> {
  late final rows = [for (final s in widget.store.settings.snippets) _Row(s)];

  void _save() {
    widget.store.settings.snippets = [
      for (final r in rows)
        if (r.cmd.text.trim().isNotEmpty) Snippet(name: r.name.text.trim(), cmd: r.cmd.text.trim(), run: r.run),
    ];
    widget.store.saveSettings();
    Navigator.pop(context);
  }

  void _move(int i, int d) {
    final j = i + d;
    if (j < 0 || j >= rows.length) return;
    setState(() {
      final t = rows[i];
      rows[i] = rows[j];
      rows[j] = t;
    });
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    return Scaffold(
      appBar: AppBar(
        leading: Padding(padding: const EdgeInsets.only(left: 10), child: Center(child: KeyIcon(Icons.close_rounded, tone: KeyTone.light, onTap: () => Navigator.pop(context)))),
        leadingWidth: 60,
        title: const Text('Tez buyruqlar'),
        actions: [Padding(padding: const EdgeInsets.only(right: 10), child: Center(child: Btn('Saqlash', kind: BtnKind.primary, small: true, onTap: _save)))],
      ),
      body: ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 32), children: [
        Text('Har biriga nom bering (ixtiyoriy). “Enter” belgilansa, buyruq darhol bajariladi.', style: TextStyle(color: p.ink3, fontSize: 13, height: 1.4)),
        const SizedBox(height: 14),
        for (var i = 0; i < rows.length; i++)
          Container(
            margin: const EdgeInsets.only(bottom: 12),
            padding: const EdgeInsets.fromLTRB(12, 12, 6, 6),
            decoration: BoxDecoration(color: p.paper, borderRadius: BorderRadius.circular(14), border: Border.all(color: p.stroke, width: 1.4), boxShadow: [BoxShadow(color: p.keyShadow, offset: const Offset(0, 3))]),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Row(children: [
                Text('${i + 1}', style: dotStyle(20, color: p.ink)),
                const SizedBox(width: 10),
                Expanded(child: TextField(controller: rows[i].name, autocorrect: false, decoration: inputDecoration(context, hint: 'Nomi (ixtiyoriy)'))),
                const SizedBox(width: 4),
                IconBtn(Icons.arrow_upward_rounded, size: 19, tip: 'Yuqoriga', onTap: i == 0 ? null : () => _move(i, -1)),
                IconBtn(Icons.arrow_downward_rounded, size: 19, tip: 'Pastga', onTap: i == rows.length - 1 ? null : () => _move(i, 1)),
              ]),
              const SizedBox(height: 8),
              Padding(
                padding: const EdgeInsets.only(right: 6),
                child: TextField(
                  controller: rows[i].cmd,
                  autocorrect: false,
                  enableSuggestions: false,
                  style: const TextStyle(fontFamily: kMono, fontSize: 14),
                  decoration: inputDecoration(context, hint: 'masalan, docker ps'),
                ),
              ),
              Row(children: [
                Checkbox(value: rows[i].run, onChanged: (v) => setState(() => rows[i].run = v ?? true)),
                Text('Enter', style: TextStyle(color: p.ink2, fontWeight: FontWeight.w600)),
                const Spacer(),
                IconBtn(Icons.delete_outline_rounded, size: 20, color: p.err, tip: 'O‘chirish', onTap: () => setState(() => rows.removeAt(i))),
              ]),
            ]),
          ),
        Align(
          alignment: Alignment.centerLeft,
          child: Btn('Buyruq qo‘shish', icon: Icons.add_rounded, onTap: () => setState(() => rows.add(_Row(Snippet(cmd: ''))))),
        ),
      ]),
    );
  }
}
