// App settings. Every change applies immediately.

import 'package:flutter/material.dart';

import '../core/store.dart';
import '../theme.dart';
import 'widgets.dart';

Future<void> showSettings(BuildContext context, Store store) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    builder: (ctx) => ListenableBuilder(
      listenable: store,
      builder: (ctx, _) {
        final p = ctx.pal;
        final s = store.settings;
        Widget title(String t) => Padding(
              padding: const EdgeInsets.only(top: 18, bottom: 10),
              child: Text(t.toUpperCase(), style: TextStyle(color: p.fg3, fontSize: 11, fontWeight: FontWeight.w600, letterSpacing: 0.8)),
            );
        void update(void Function() f) {
          f();
          store.saveSettings();
        }

        return SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
              const Text('Sozlamalar', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
              title('Ko‘rinish'),
              Seg<String>(
                expand: true,
                items: const [('system', 'Tizim', null), ('dark', 'Qorong‘i', null), ('light', 'Yorug‘', null)],
                value: s.theme,
                onChanged: (v) => update(() => s.theme = v),
              ),
              title('Terminal'),
              Row(children: [
                const Expanded(child: Text('Shrift o‘lchami', style: TextStyle(fontSize: 15))),
                Container(
                  decoration: BoxDecoration(color: p.hover, borderRadius: BorderRadius.circular(11)),
                  child: Row(children: [
                    IconBtn(Icons.remove_rounded, size: 18, onTap: () => update(() => s.fontSize = (s.fontSize - 0.5).clamp(8, 22))),
                    SizedBox(width: 36, child: Text(s.fontSize.toStringAsFixed(s.fontSize % 1 == 0 ? 0 : 1), textAlign: TextAlign.center, style: const TextStyle(fontFamily: kMono))),
                    IconBtn(Icons.add_rounded, size: 18, onTap: () => update(() => s.fontSize = (s.fontSize + 0.5).clamp(8, 22))),
                  ]),
                ),
              ]),
              const SizedBox(height: 8),
              SwitchRow(
                title: 'Qo‘shimcha tugmalar',
                hint: 'Klaviatura ustida Esc, Tab, Ctrl, Alt va strelkalar qatori.',
                value: s.extraKeys,
                onChanged: (v) => update(() => s.extraKeys = v),
              ),
              title('AI agentlar'),
              SwitchRow(
                title: 'Limitlarni ko‘rsatish',
                hint: 'Claude Code va agy obuna limitlari (5 soatlik, haftalik) yuqori panel ostida turadi.',
                value: s.agentUsage,
                onChanged: (v) => update(() => s.agentUsage = v),
              ),
              Padding(
                padding: const EdgeInsets.only(top: 22),
                child: Row(children: [
                  Icon(Icons.terminal_rounded, size: 16, color: p.fg3),
                  const SizedBox(width: 8),
                  Text('Pult 1.0.0', style: TextStyle(color: p.fg2, fontSize: 12.5)),
                  Text('  ·  SSH · SFTP · tmux', style: TextStyle(color: p.fg3, fontSize: 12.5)),
                ]),
              ),
            ]),
          ),
        );
      },
    ),
  );
}
