// App settings. Every change applies immediately (same options as the
// desktop app where they make sense on a phone).

import 'package:flutter/material.dart';

import '../app_state.dart';
import '../core/update.dart';
import '../theme.dart';
import 'snippets.dart';
import 'update_sheet.dart';
import 'widgets.dart';

Future<void> showSettings(BuildContext context, AppState app) {
  final store = app.store;
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    builder: (ctx) => ListenableBuilder(
      listenable: store,
      builder: (ctx, _) {
        final p = ctx.pal;
        final s = store.settings;
        void update(void Function() f) {
          f();
          store.saveSettings();
        }

        Widget row(String label, Widget control) => Padding(
              padding: const EdgeInsets.symmetric(vertical: 6),
              child: Row(children: [Expanded(child: Text(label, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600))), control]),
            );

        Widget swatch(Color color, bool on, VoidCallback onTap, String tip) => Padding(
              padding: const EdgeInsets.only(left: 8),
              child: Tooltip(
                message: tip,
                child: GestureDetector(
                  onTap: onTap,
                  child: Container(
                    width: 34,
                    height: 34,
                    decoration: BoxDecoration(
                      color: color,
                      shape: BoxShape.circle,
                      border: Border.all(color: p.stroke, width: on ? 3 : 1.4),
                      boxShadow: on ? null : [BoxShadow(color: p.keyShadow, offset: const Offset(0, 2))],
                    ),
                    child: on ? Icon(Icons.check_rounded, size: 17, color: p.onSignal) : null,
                  ),
                ),
              ),
            );

        const signalNames = {'orange': 'To‘q sariq', 'yellow': 'Sariq', 'blue': 'Ko‘k', 'green': 'Yashil'};
        const bodyNames = {'gray': 'Kulrang', 'mint': 'Yalpiz', 'sky': 'Osmon', 'sand': 'Qum'};

        return SafeArea(
          child: ConstrainedBox(
            constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(ctx).height * 0.9),
            child: ListView(shrinkWrap: true, padding: const EdgeInsets.fromLTRB(20, 0, 20, 18), children: [
              const Text('Sozlamalar', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
              const GroupTitle('Ko‘rinish', top: 14),
              Seg<String>(
                expand: true,
                items: const [('system', 'Tizim', null), ('dark', 'Qorong‘i', null), ('light', 'Yorug‘', null)],
                value: s.theme,
                onChanged: (v) => update(() => s.theme = v),
              ),
              const SizedBox(height: 10),
              row('Signal rangi', Row(mainAxisSize: MainAxisSize.min, children: [
                for (final e in signalSwatches.entries) swatch(e.value, s.signal == e.key, () => update(() => s.signal = e.key), signalNames[e.key]!),
              ])),
              row('Korpus rangi', Row(mainAxisSize: MainAxisSize.min, children: [
                for (final e in bodySwatches.entries) swatch(e.value.$1, s.body == e.key, () => update(() => s.body = e.key), bodyNames[e.key]!),
              ])),
              if (p.isDark) Text('Korpus rangi yorug‘ mavzuda ko‘rinadi.', style: TextStyle(color: p.ink3, fontSize: 12.5)),
              const GroupTitle('Terminal'),
              row(
                'Shrift o‘lchami',
                Row(mainAxisSize: MainAxisSize.min, children: [
                  KeyIcon(Icons.remove_rounded, tone: KeyTone.light, size: 38, onTap: () => update(() => s.fontSize = (s.fontSize - 0.5).clamp(8, 22))),
                  SizedBox(width: 66, child: Text(s.fontSize.toStringAsFixed(s.fontSize % 1 == 0 ? 0 : 1), textAlign: TextAlign.center, style: dotStyle(20, color: p.ink))),
                  KeyIcon(Icons.add_rounded, tone: KeyTone.light, size: 38, onTap: () => update(() => s.fontSize = (s.fontSize + 0.5).clamp(8, 22))),
                ]),
              ),
              SwitchRow(
                title: 'Qo‘shimcha tugmalar',
                hint: 'Klaviatura ustida Esc, Tab, Ctrl, Alt va strelkalar qatori.',
                value: s.extraKeys,
                onChanged: (v) => update(() => s.extraKeys = v),
              ),
              SwitchRow(
                title: 'Terminal tarixini tiklash',
                hint: 'Qayta ochilgan terminalda avvalgi chiqish ham ko‘rinadi (tmux tarixidan).',
                value: s.restoreHistory,
                onChanged: (v) => update(() => s.restoreHistory = v),
              ),
              row('Tez buyruqlar (${s.snippets.length})', Btn('Tahrirlash', small: true, icon: Icons.bolt_rounded, onTap: () => editSnippets(ctx, store))),
              const GroupTitle('Ulanish'),
              SwitchRow(
                title: 'Oxirgi serverlarga ulanish',
                hint: 'Pult ochilganda, avval ochiq bo‘lgan serverlarga o‘zi ulanadi.',
                value: s.restoreSessions,
                onChanged: (v) => update(() => s.restoreSessions = v),
              ),
              const GroupTitle('Fayllar'),
              Seg<String>(
                expand: true,
                items: const [('smooth', 'Ping past', null), ('fast', 'Maksimal tezlik', null)],
                value: s.transferPace,
                onChanged: (v) => update(() => s.transferPace = v),
              ),
              const SizedBox(height: 8),
              Text(
                'Ping past: fayl uzatilayotganda terminal va ping sekinlashmaydi, uzatish biroz sekinroq bo‘lishi mumkin. Maksimal tezlik: fayl eng tez uzatiladi, lekin ping va terminal kechikadi.',
                style: TextStyle(color: p.ink3, fontSize: 12.5, height: 1.4),
              ),
              const GroupTitle('AI agentlar'),
              SwitchRow(
                title: 'Limitlarni ko‘rsatish',
                hint: 'Claude Code va agy obuna limitlari (5 soatlik, haftalik) holat qatorida turadi.',
                value: s.agentUsage,
                onChanged: (v) => update(() => s.agentUsage = v),
              ),
              const GroupTitle('Yangilanish'),
              SwitchRow(
                title: 'Yangilanishlarni tekshirish',
                hint: 'GitHub’da Pult’ning yangi versiyasi chiqsa, serverlar ro‘yxatida taklif qilinadi.',
                value: s.checkUpdates,
                onChanged: (v) => update(() => s.checkUpdates = v),
              ),
              const SizedBox(height: 6),
              Align(alignment: Alignment.centerLeft, child: _CheckNow(app: app)),
              Padding(
                padding: const EdgeInsets.only(top: 22),
                child: Row(children: [
                  Text('PULT', style: capsStyle(p.ink3, size: 10.5)),
                  const SizedBox(width: 6),
                  Text(kAppVersion, style: dotStyle(15, color: p.ink3)),
                  Text('   SSH · SFTP · tmux', style: TextStyle(color: p.ink4, fontSize: 12.5)),
                ]),
              ),
            ]),
          ),
        );
      },
    ),
  );
}

class _CheckNow extends StatefulWidget {
  const _CheckNow({required this.app});
  final AppState app;

  @override
  State<_CheckNow> createState() => _CheckNowState();
}

class _CheckNowState extends State<_CheckNow> {
  bool busy = false;

  Future<void> _check() async {
    setState(() => busy = true);
    try {
      final r = await widget.app.checkUpdate(manual: true);
      if (!mounted) return;
      if (r == null) {
        toast(context, 'Sizda eng so‘nggi versiya ($kAppVersion)');
      } else {
        await showUpdateSheet(context, widget.app, r);
      }
    } catch (e) {
      if (mounted) toast(context, 'Tekshirib bo‘lmadi: ${'$e'.replaceFirst('HttpException: ', '')}', error: true);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Btn('Hozir tekshirish', icon: Icons.refresh_rounded, small: true, busy: busy, onTap: _check);
}
