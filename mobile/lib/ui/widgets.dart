// Shared building blocks: buttons, fields, segmented control, sheets, dialogs.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme.dart';

enum BtnKind { primary, outline, ghost, danger }

class Btn extends StatelessWidget {
  const Btn(this.label, {super.key, this.onTap, this.kind = BtnKind.outline, this.icon, this.expand = false, this.busy = false});
  final String label;
  final VoidCallback? onTap;
  final BtnKind kind;
  final IconData? icon;
  final bool expand;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final (bg, fg, border) = switch (kind) {
      BtnKind.primary => (p.accent, p.accentFg, p.accent),
      BtnKind.danger => (p.err, Colors.white, p.err),
      BtnKind.outline => (Colors.transparent, p.fg, p.line2),
      BtnKind.ghost => (Colors.transparent, p.fg2, Colors.transparent),
    };
    final child = Row(
      mainAxisSize: expand ? MainAxisSize.max : MainAxisSize.min,
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        if (busy)
          SizedBox(width: 15, height: 15, child: CircularProgressIndicator(strokeWidth: 1.8, color: fg))
        else if (icon != null)
          Icon(icon, size: 17, color: fg),
        if (busy || icon != null) const SizedBox(width: 8),
        Text(label, style: TextStyle(color: fg, fontWeight: FontWeight.w500, fontSize: 14.5)),
      ],
    );
    return Opacity(
      opacity: onTap == null ? 0.5 : 1,
      child: Material(
        color: bg,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(11), side: BorderSide(color: border)),
        child: InkWell(
          borderRadius: BorderRadius.circular(11),
          onTap: busy ? null : onTap,
          child: Padding(padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 13), child: child),
        ),
      ),
    );
  }
}

class IconBtn extends StatelessWidget {
  const IconBtn(this.icon, {super.key, this.onTap, this.tip, this.size = 21, this.color, this.width = 44});
  final IconData icon;
  final VoidCallback? onTap;
  final String? tip;
  final double size;
  final Color? color;
  final double width;

  @override
  Widget build(BuildContext context) {
    final b = InkResponse(
      onTap: onTap,
      radius: 22,
      child: SizedBox(width: width, height: 44, child: Icon(icon, size: size, color: color ?? context.pal.fg2)),
    );
    return tip == null ? b : Tooltip(message: tip!, child: b);
  }
}

class Dot extends StatelessWidget {
  const Dot(this.color, {super.key, this.size = 7, this.pulse = false});
  final Color color;
  final double size;
  final bool pulse;

  @override
  Widget build(BuildContext context) {
    final dot = Container(width: size, height: size, decoration: BoxDecoration(color: color, shape: BoxShape.circle));
    if (!pulse) return dot;
    return _Pulse(child: dot);
  }
}

class _Pulse extends StatefulWidget {
  const _Pulse({required this.child});
  final Widget child;
  @override
  State<_Pulse> createState() => _PulseState();
}

class _PulseState extends State<_Pulse> with SingleTickerProviderStateMixin {
  late final _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 900))..repeat(reverse: true);
  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => FadeTransition(opacity: Tween(begin: 1.0, end: 0.3).animate(_c), child: widget.child);
}

/// Segmented control (same look as the desktop mode switch).
class Seg<T> extends StatelessWidget {
  const Seg({super.key, required this.items, required this.value, required this.onChanged, this.expand = false});
  final List<(T, String, IconData?)> items;
  final T value;
  final ValueChanged<T> onChanged;
  final bool expand;

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final children = items.map((it) {
      final on = it.$1 == value;
      final w = GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () => onChanged(it.$1),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 150),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
          decoration: BoxDecoration(
            color: on ? p.segOn : Colors.transparent,
            borderRadius: BorderRadius.circular(8),
            boxShadow: on ? [BoxShadow(color: Colors.black.withValues(alpha: p.isDark ? 0.35 : 0.08), blurRadius: 2, offset: const Offset(0, 1))] : null,
            border: on ? Border.all(color: p.line) : null,
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              if (it.$3 != null) ...[Icon(it.$3, size: 16, color: on ? p.fg : p.fg2), const SizedBox(width: 7)],
              Text(it.$2, style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w500, color: on ? p.fg : p.fg2)),
            ],
          ),
        ),
      );
      return expand ? Expanded(child: w) : w;
    }).toList();
    return Container(
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(color: p.hover, borderRadius: BorderRadius.circular(11)),
      child: Row(mainAxisSize: expand ? MainAxisSize.max : MainAxisSize.min, children: children),
    );
  }
}

class Field extends StatelessWidget {
  const Field({
    super.key,
    required this.label,
    required this.controller,
    this.hint,
    this.help,
    this.obscure = false,
    this.mono = false,
    this.keyboard,
    this.maxLines = 1,
    this.suffix,
    this.autofocus = false,
    this.onSubmitted,
  });
  final String label;
  final TextEditingController controller;
  final String? hint, help;
  final bool obscure, mono, autofocus;
  final TextInputType? keyboard;
  final int maxLines;
  final Widget? suffix;
  final ValueChanged<String>? onSubmitted;

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: TextStyle(color: p.fg2, fontSize: 12.5, fontWeight: FontWeight.w500)),
        const SizedBox(height: 7),
        TextField(
          controller: controller,
          obscureText: obscure,
          autofocus: autofocus,
          keyboardType: keyboard,
          maxLines: obscure ? 1 : maxLines,
          autocorrect: false,
          enableSuggestions: false,
          onSubmitted: onSubmitted,
          style: TextStyle(fontFamily: mono ? kMono : kSans, fontSize: mono ? 13.5 : 15, color: p.fg),
          decoration: inputDecoration(context, hint: hint, suffix: suffix),
        ),
        if (help != null) ...[const SizedBox(height: 6), Text(help!, style: TextStyle(color: p.fg3, fontSize: 12))],
      ],
    );
  }
}

InputDecoration inputDecoration(BuildContext context, {String? hint, Widget? suffix, Widget? prefix}) {
  final p = context.pal;
  OutlineInputBorder b(Color c) => OutlineInputBorder(borderRadius: BorderRadius.circular(11), borderSide: BorderSide(color: c));
  return InputDecoration(
    hintText: hint,
    hintStyle: TextStyle(color: p.fg3, fontFamily: kSans, fontSize: 15),
    isDense: true,
    filled: true,
    fillColor: p.bg3,
    contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
    enabledBorder: b(p.line2),
    focusedBorder: b(p.fg3),
    border: b(p.line2),
    suffixIcon: suffix,
    prefixIcon: prefix,
  );
}

class SwitchRow extends StatelessWidget {
  const SwitchRow({super.key, required this.title, this.hint, required this.value, required this.onChanged});
  final String title;
  final String? hint;
  final bool value;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    return InkWell(
      onTap: () => onChanged(!value),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Row(children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title, style: const TextStyle(fontWeight: FontWeight.w500, fontSize: 15)),
              if (hint != null) Padding(padding: const EdgeInsets.only(top: 3), child: Text(hint!, style: TextStyle(color: p.fg3, fontSize: 12.5))),
            ]),
          ),
          const SizedBox(width: 12),
          Switch(value: value, onChanged: onChanged),
        ]),
      ),
    );
  }
}

/* ---------------- sheets & dialogs ---------------- */

class SheetAction {
  const SheetAction(this.label, this.icon, this.onTap, {this.danger = false});
  final String label;
  final IconData icon;
  final VoidCallback onTap;
  final bool danger;
}

Future<void> showActions(BuildContext context, {String? title, String? subtitle, required List<SheetAction?> actions}) {
  final p = context.pal;
  return showModalBottomSheet<void>(
    context: context,
    builder: (ctx) => SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(8, 0, 8, 10),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          if (title != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 10),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(title, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600), maxLines: 1, overflow: TextOverflow.ellipsis),
                if (subtitle != null) Text(subtitle, style: TextStyle(color: p.fg3, fontSize: 12.5, fontFamily: kMono), maxLines: 1, overflow: TextOverflow.ellipsis),
              ]),
            ),
          for (final a in actions)
            if (a == null)
              Padding(padding: const EdgeInsets.symmetric(vertical: 4, horizontal: 16), child: Divider(color: p.line))
            else
              InkWell(
                borderRadius: BorderRadius.circular(12),
                onTap: () {
                  Navigator.pop(ctx);
                  a.onTap();
                },
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
                  child: Row(children: [
                    Icon(a.icon, size: 20, color: a.danger ? p.err : p.fg2),
                    const SizedBox(width: 16),
                    Text(a.label, style: TextStyle(fontSize: 15, color: a.danger ? p.err : p.fg)),
                  ]),
                ),
              ),
        ]),
      ),
    ),
  );
}

Future<bool> confirm(BuildContext context, {required String title, required String message, String ok = 'Tasdiqlash', bool danger = false}) async {
  final p = context.pal;
  final r = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text(title, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
      content: Text(message, style: TextStyle(color: p.fg2, height: 1.45)),
      actionsPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
      actions: [
        Btn('Bekor qilish', kind: BtnKind.ghost, onTap: () => Navigator.pop(ctx, false)),
        Btn(ok, kind: danger ? BtnKind.danger : BtnKind.primary, onTap: () => Navigator.pop(ctx, true)),
      ],
    ),
  );
  return r == true;
}

Future<String?> askText(BuildContext context, {required String title, String? label, String value = '', String? hint, String ok = 'Saqlash', bool selectStem = false, String? Function(String)? validate}) {
  final c = TextEditingController(text: value);
  final dot = value.lastIndexOf('.');
  c.selection = TextSelection(baseOffset: 0, extentOffset: selectStem && dot > 0 ? dot : value.length);
  String? err;
  return showDialog<String>(
    context: context,
    builder: (ctx) => StatefulBuilder(builder: (ctx, set) {
      void submit() {
        final v = c.text.trim();
        final problem = v.isEmpty ? 'Bo‘sh bo‘lmasin' : validate?.call(v);
        if (problem != null) return set(() => err = problem);
        Navigator.pop(ctx, v);
      }

      return AlertDialog(
        title: Text(title, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
        content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          if (label != null) ...[Text(label, style: TextStyle(color: ctx.pal.fg3, fontSize: 12.5, fontFamily: kMono)), const SizedBox(height: 10)],
          TextField(
            controller: c,
            autofocus: true,
            autocorrect: false,
            enableSuggestions: false,
            onSubmitted: (_) => submit(),
            decoration: inputDecoration(ctx, hint: hint),
          ),
          if (err != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(err!, style: TextStyle(color: ctx.pal.err, fontSize: 12.5))),
        ]),
        actionsPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        actions: [
          Btn('Bekor qilish', kind: BtnKind.ghost, onTap: () => Navigator.pop(ctx)),
          Btn(ok, kind: BtnKind.primary, onTap: submit),
        ],
      );
    }),
  );
}

void toast(BuildContext context, String message, {bool error = false}) {
  final p = context.pal;
  final m = ScaffoldMessenger.maybeOf(context);
  if (m == null) return;
  m.hideCurrentSnackBar();
  m.showSnackBar(SnackBar(
    duration: Duration(milliseconds: error ? 3500 : 1800),
    content: Row(children: [
      Icon(error ? Icons.error_outline_rounded : Icons.check_rounded, size: 18, color: error ? p.err : p.ok),
      const SizedBox(width: 10),
      Expanded(child: Text(message)),
    ]),
  ));
}

Future<void> copyText(BuildContext context, String text, [String message = 'Nusxalandi']) async {
  await Clipboard.setData(ClipboardData(text: text));
  if (context.mounted) toast(context, message);
}
