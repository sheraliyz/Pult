// Dialogs the connection opens: host key trust, passwords, 2FA prompts.
// Also the Uzbek explanations of connection errors.

import 'package:dartssh2/dartssh2.dart';
import 'package:flutter/material.dart';

import '../core/connection.dart';
import '../theme.dart';
import 'widgets.dart';

class DialogPrompter implements Prompter {
  DialogPrompter(this.navKey);
  final GlobalKey<NavigatorState> navKey;

  BuildContext? get _ctx => navKey.currentContext;

  @override
  Future<bool> hostKey({required String server, required String host, required String type, required String fingerprint, String? previous}) async {
    final ctx = _ctx;
    if (ctx == null) return false;
    final changed = previous != null;
    final r = await showDialog<bool>(
      context: ctx,
      barrierDismissible: false,
      builder: (c) {
        final p = c.pal;
        Widget fp(String label, String value, {bool danger = false, bool faded = false}) => Opacity(
              opacity: faded ? 0.55 : 1,
              child: Container(
                width: double.infinity,
                margin: const EdgeInsets.only(top: 12),
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: p.bg3,
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: danger ? p.err.withValues(alpha: 0.5) : p.line),
                ),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(label, style: TextStyle(color: p.fg3, fontSize: 11.5, fontWeight: FontWeight.w500)),
                  const SizedBox(height: 4),
                  SelectableText(value, style: TextStyle(fontFamily: kMono, fontSize: 12, color: p.fg)),
                ]),
              ),
            );
        return AlertDialog(
          icon: Icon(changed ? Icons.warning_amber_rounded : Icons.shield_outlined, color: changed ? p.err : p.fg2),
          title: Text(changed ? 'Server kaliti o‘zgargan!' : 'Serverni tasdiqlang', style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
          content: SingleChildScrollView(
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(
                changed
                    ? '$host serverining kaliti avvalgisidan farq qiladi. Agar serverni qayta o‘rnatmagan bo‘lsangiz, bu hujum belgisi bo‘lishi mumkin — ulanmang.'
                    : '$host ga birinchi marta ulanmoqdasiz. Kalit barmoq izi server administratori bergan bilan bir xil ekanini tekshiring.',
                style: TextStyle(color: p.fg2, height: 1.45),
              ),
              if (changed) fp('Avvalgi', previous, faded: true),
              fp(changed ? 'Yangi · $type' : type, fingerprint, danger: changed),
            ]),
          ),
          actionsPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          actions: [
            Btn(changed ? 'Ulanmaslik' : 'Bekor qilish', kind: BtnKind.ghost, onTap: () => Navigator.pop(c, false)),
            Btn(changed ? 'Baribir ishonaman' : 'Ishonaman', kind: changed ? BtnKind.danger : BtnKind.primary, onTap: () => Navigator.pop(c, true)),
          ],
        );
      },
    );
    return r == true;
  }

  @override
  Future<SecretAnswer?> secret({required String server, required String label, required bool passphrase, required bool retry}) async {
    final ctx = _ctx;
    if (ctx == null) return null;
    final c = TextEditingController();
    var save = true;
    var hidden = true;
    return showDialog<SecretAnswer>(
      context: ctx,
      builder: (dc) => StatefulBuilder(builder: (dc, set) {
        final p = dc.pal;
        void submit() {
          if (c.text.isEmpty) return;
          Navigator.pop(dc, SecretAnswer(c.text, save));
        }

        return AlertDialog(
          icon: Icon(passphrase ? Icons.key_rounded : Icons.lock_outline_rounded, color: p.fg2),
          title: Text(passphrase ? 'Kalit qulflangan' : server, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
          content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            if (retry)
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: Row(children: [
                  Icon(Icons.error_outline_rounded, size: 16, color: p.err),
                  const SizedBox(width: 6),
                  Text(passphrase ? 'Kalit paroli noto‘g‘ri' : 'Parol noto‘g‘ri, qaytadan kiriting', style: TextStyle(color: p.err, fontSize: 13)),
                ]),
              ),
            Text(label, style: TextStyle(color: p.fg2, fontSize: 12.5, fontWeight: FontWeight.w500)),
            const SizedBox(height: 7),
            TextField(
              controller: c,
              autofocus: true,
              obscureText: hidden,
              autocorrect: false,
              enableSuggestions: false,
              onSubmitted: (_) => submit(),
              decoration: inputDecoration(dc,
                  suffix: IconButton(
                    icon: Icon(hidden ? Icons.visibility_outlined : Icons.visibility_off_outlined, size: 19, color: p.fg3),
                    onPressed: () => set(() => hidden = !hidden),
                  )),
            ),
            const SizedBox(height: 8),
            InkWell(
              onTap: () => set(() => save = !save),
              child: Row(children: [
                Checkbox(value: save, onChanged: (v) => set(() => save = v ?? false)),
                Text(passphrase ? 'Kalit parolini saqlash' : 'Parolni saqlash', style: TextStyle(color: p.fg2)),
              ]),
            ),
          ]),
          actionsPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          actions: [
            Btn('Bekor qilish', kind: BtnKind.ghost, onTap: () => Navigator.pop(dc)),
            Btn('Ulanish', kind: BtnKind.primary, onTap: submit),
          ],
        );
      }),
    );
  }

  @override
  Future<List<String>?> interactive({required String server, required String name, required String instruction, required List<SSHUserInfoPrompt> prompts}) async {
    final ctx = _ctx;
    if (ctx == null) return null;
    final cs = prompts.map((_) => TextEditingController()).toList();
    return showDialog<List<String>>(
      context: ctx,
      builder: (dc) => AlertDialog(
        icon: Icon(Icons.shield_outlined, color: dc.pal.fg2),
        title: Text(server, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
        content: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            if ('$name $instruction'.trim().isNotEmpty)
              Padding(padding: const EdgeInsets.only(bottom: 12), child: Text([name, instruction].where((s) => s.isNotEmpty).join(' — '), style: TextStyle(color: dc.pal.fg2))),
            for (var i = 0; i < prompts.length; i++) ...[
              Field(label: prompts[i].promptText.trim().replaceAll(RegExp(r':$'), ''), controller: cs[i], obscure: !prompts[i].echo, autofocus: i == 0),
              const SizedBox(height: 12),
            ],
          ]),
        ),
        actionsPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        actions: [
          Btn('Bekor qilish', kind: BtnKind.ghost, onTap: () => Navigator.pop(dc)),
          Btn('Yuborish', kind: BtnKind.primary, onTap: () => Navigator.pop(dc, cs.map((c) => c.text).toList())),
        ],
      ),
    );
  }
}

({String title, String text}) describeError(ConnError? e) {
  switch (e?.code) {
    case 'AUTH':
      return (title: 'Kirish rad etildi', text: 'Foydalanuvchi nomi, parol yoki kalit noto‘g‘ri. Serverda parol bilan kirish o‘chirilgan bo‘lishi ham mumkin — unda SSH kalit ishlating.');
    case 'CANCELLED':
      return (title: 'Bekor qilindi', text: 'Ulanish to‘xtatildi.');
    case 'HOSTKEY':
      return (title: 'Server kaliti tasdiqlanmadi', text: 'Xavfsizlik uchun ulanish to‘xtatildi.');
    case 'NOT_FOUND':
      return (title: 'Server topilmadi', text: 'Manzil noto‘g‘ri yoki internet yo‘q.');
    case 'REFUSED':
      return (title: 'Ulanish rad etildi', text: 'Port yopiq yoki SSH xizmati ishlamayapti.');
    case 'TIMEOUT':
      return (title: 'Javob kelmadi', text: 'Server javob bermadi. Manzil, port va internetni tekshiring.');
    case 'UNREACHABLE':
      return (title: 'Tarmoq mavjud emas', text: 'Serverga yo‘l topilmadi. Internetni tekshiring.');
    case 'KEY':
      return (title: 'Kalit bilan muammo', text: e!.message);
    case 'RESET':
      return (title: 'Aloqa uzildi', text: 'Server ulanishni yopdi.');
    default:
      return (title: 'Ulanib bo‘lmadi', text: e?.message ?? 'Noma’lum xato.');
  }
}
