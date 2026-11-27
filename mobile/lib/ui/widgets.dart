// Shared building blocks: physical keys, buttons, fields, segmented control,
// chips, sheets, dialogs. The "device" look of the desktop app: a key has an
// ink outline and a hard shadow underneath, and sinks when pressed.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme.dart';

/* ---------------- keys ---------------- */

/// What a key is for, which decides its colour: [signal] the main action or
/// the chosen mode, [ink] where you are, [gray] helpers, [light] the rest.
enum KeyTone { light, signal, ink, gray, danger, flat }

(Color face, Color fg) keyColors(Pal p, KeyTone tone) => switch (tone) {
      KeyTone.light => (p.key, p.ink),
      KeyTone.signal => (p.signal, p.onSignal),
      KeyTone.ink => (p.ink, p.onInk),
      KeyTone.gray => (p.key2, p.ink),
      KeyTone.danger => (p.err, p.isDark ? p.onInk : Colors.white),
      KeyTone.flat => (Colors.transparent, p.ink2),
    };

class KeyCap extends StatefulWidget {
  const KeyCap({
    super.key,
    required this.child,
    this.onTap,
    this.onLongPress,
    this.tone = KeyTone.light,
    this.radius = 11,
    this.padding = const EdgeInsets.symmetric(horizontal: 14),
    this.width,
    this.height = 40,
    this.depth = 3,
    this.tip,
    this.badge,
  });

  final Widget child;
  final VoidCallback? onTap, onLongPress;
  final KeyTone tone;
  final double radius;
  final EdgeInsetsGeometry padding;
  final double? width, height;

  /// The hard shadow under the key (px); it sinks by this much when pressed.
  final double depth;
  final String? tip;

  /// A small mark on the top-right corner (e.g. "!" when Claude waits).
  final Widget? badge;

  @override
  State<KeyCap> createState() => _KeyCapState();
}

class _KeyCapState extends State<KeyCap> {
  bool _down = false;

  void _set(bool v) {
    if (_down != v && mounted) setState(() => _down = v);
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final (face, fg) = keyColors(p, widget.tone);
    final flat = widget.tone == KeyTone.flat;
    final enabled = widget.onTap != null || widget.onLongPress != null;
    final depth = flat ? 0.0 : widget.depth;
    final sink = _down ? depth : 0.0;
    Widget cap = AnimatedContainer(
      duration: const Duration(milliseconds: 60),
      width: widget.width,
      height: widget.height,
      padding: widget.padding,
      transform: Matrix4.translationValues(0, sink, 0),
      decoration: BoxDecoration(
        color: flat && _down ? p.hover : face,
        borderRadius: BorderRadius.circular(widget.radius),
        border: flat ? null : Border.all(color: p.stroke, width: 1.4),
        boxShadow: flat || depth - sink <= 0 ? null : [BoxShadow(color: p.keyShadow, offset: Offset(0, depth - sink))],
      ),
      // Content-sized unless the key is given a width (or stretched by its parent).
      child: Center(
        widthFactor: widget.width == null ? 1 : null,
        child: IconTheme.merge(
          data: IconThemeData(color: fg, size: 18),
          child: DefaultTextStyle.merge(
            style: TextStyle(color: fg, fontFamily: kSans, fontWeight: FontWeight.w600, fontSize: 14.5),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            child: widget.child,
          ),
        ),
      ),
    );
    if (widget.badge != null) {
      cap = Stack(clipBehavior: Clip.none, children: [cap, Positioned(top: -6, right: -6, child: widget.badge!)]);
    }
    Widget out = Semantics(
      button: true,
      enabled: enabled,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTapDown: enabled ? (_) => _set(true) : null,
        onTapUp: enabled ? (_) => _set(false) : null,
        onTapCancel: () => _set(false),
        onTap: widget.onTap == null
            ? null
            : () {
                HapticFeedback.selectionClick();
                widget.onTap!();
              },
        onLongPress: widget.onLongPress == null
            ? null
            : () {
                _set(false);
                HapticFeedback.mediumImpact();
                widget.onLongPress!();
              },
        child: Padding(
          padding: EdgeInsets.only(bottom: depth),
          child: Opacity(opacity: enabled ? 1 : 0.45, child: cap),
        ),
      ),
    );
    if (widget.tip != null) out = Tooltip(message: widget.tip!, child: out);
    return out;
  }
}

/// A square key with an icon (top bars, toolbars).
class KeyIcon extends StatelessWidget {
  const KeyIcon(this.icon, {super.key, this.onTap, this.onLongPress, this.tip, this.tone = KeyTone.gray, this.size = 40, this.iconSize = 19, this.badge});
  final IconData icon;
  final VoidCallback? onTap, onLongPress;
  final String? tip;
  final KeyTone tone;
  final double size, iconSize;
  final Widget? badge;

  @override
  Widget build(BuildContext context) => KeyCap(
        onTap: onTap,
        onLongPress: onLongPress,
        tip: tip,
        tone: tone,
        width: size,
        height: size,
        radius: size >= 40 ? 11 : 9,
        padding: EdgeInsets.zero,
        badge: badge,
        child: Icon(icon, size: iconSize),
      );
}

/// The round "!" / dot on a key's corner.
class KeyBadge extends StatelessWidget {
  const KeyBadge({super.key, this.text = '!', this.color});
  final String text;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    return Container(
      width: 17,
      height: 17,
      alignment: Alignment.center,
      decoration: BoxDecoration(color: color ?? p.signal, shape: BoxShape.circle, border: Border.all(color: p.stroke, width: 1.4)),
      child: Text(text, style: TextStyle(color: p.onSignal, fontSize: 10.5, fontWeight: FontWeight.w800, height: 1)),
    );
  }
}

/* ---------------- buttons ---------------- */

enum BtnKind { primary, outline, ghost, danger }

class Btn extends StatelessWidget {
  const Btn(this.label, {super.key, this.onTap, this.kind = BtnKind.outline, this.icon, this.expand = false, this.busy = false, this.small = false});
  final String label;
  final VoidCallback? onTap;
  final BtnKind kind;
  final IconData? icon;
  final bool expand, busy, small;

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final tone = switch (kind) {
      BtnKind.primary => KeyTone.signal,
      BtnKind.danger => KeyTone.danger,
      BtnKind.outline => KeyTone.light,
      BtnKind.ghost => KeyTone.flat,
    };
    final fg = keyColors(p, tone).$2;
    final child = Row(
      mainAxisSize: expand ? MainAxisSize.max : MainAxisSize.min,
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        if (busy)
          SizedBox(width: 15, height: 15, child: CircularProgressIndicator(strokeWidth: 2, color: fg))
        else if (icon != null)
          Icon(icon, size: small ? 16 : 18),
        if (busy || icon != null) const SizedBox(width: 8),
        Flexible(child: Text(label, style: TextStyle(fontSize: small ? 13.5 : 14.5, fontWeight: FontWeight.w600))),
      ],
    );
    return KeyCap(
      tone: tone,
      onTap: busy ? null : onTap,
      height: small ? 36 : 44,
      depth: kind == BtnKind.ghost ? 0 : 3,
      padding: EdgeInsets.symmetric(horizontal: small ? 12 : 16),
      child: child,
    );
  }
}

/// A flat icon button (inside lists and sheets, where keys would be too heavy).
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
      child: SizedBox(
        width: width,
        height: 44,
        child: Opacity(opacity: onTap == null ? 0.4 : 1, child: Icon(icon, size: size, color: color ?? context.pal.ink2)),
      ),
    );
    return tip == null ? b : Tooltip(message: tip!, child: b);
  }
}

class Dot extends StatelessWidget {
  const Dot(this.color, {super.key, this.size = 8, this.pulse = false, this.ring = false});
  final Color color;
  final double size;
  final bool pulse;

  /// An ink outline, like the keys (the server's "open" dot).
  final bool ring;

  @override
  Widget build(BuildContext context) {
    final dot = Container(
      width: size,
      height: size,
      decoration: BoxDecoration(color: color, shape: BoxShape.circle, border: ring ? Border.all(color: context.pal.stroke, width: 1.2) : null),
    );
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

/// A row of keys, one chosen (signal colour) — the desktop mode switch.
class Seg<T> extends StatelessWidget {
  const Seg({super.key, required this.items, required this.value, required this.onChanged, this.expand = false, this.height = 42});
  final List<(T, String, IconData?)> items;
  final T value;
  final ValueChanged<T> onChanged;
  final bool expand;
  final double height;

  @override
  Widget build(BuildContext context) {
    final children = <Widget>[];
    for (var i = 0; i < items.length; i++) {
      final it = items[i];
      final on = it.$1 == value;
      final key = KeyCap(
        tone: on ? KeyTone.signal : KeyTone.light,
        height: height,
        padding: const EdgeInsets.symmetric(horizontal: 12),
        onTap: () => onChanged(it.$1),
        child: Row(mainAxisSize: MainAxisSize.min, mainAxisAlignment: MainAxisAlignment.center, children: [
          if (it.$3 != null) ...[Icon(it.$3, size: 17), const SizedBox(width: 7)],
          Flexible(child: Text(it.$2, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600))),
        ]),
      );
      if (i > 0) children.add(const SizedBox(width: 8));
      children.add(expand ? Expanded(child: key) : key);
    }
    return Row(mainAxisSize: expand ? MainAxisSize.max : MainAxisSize.min, children: children);
  }
}

/* ---------------- chips (the status row) ---------------- */

/// "PING 22 ms" — a small key with a caps label and dot-matrix numerals.
class StatChip extends StatelessWidget {
  const StatChip({super.key, required this.label, this.value, this.unit, this.icon, this.onTap, this.tone = KeyTone.light, this.valueColor, this.children});
  final String label;
  final String? value, unit;
  final IconData? icon;
  final VoidCallback? onTap;
  final KeyTone tone;
  final Color? valueColor;

  /// Instead of value/unit (e.g. two usage windows).
  final List<Widget>? children;

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final fg = keyColors(p, tone).$2;
    return KeyCap(
      tone: tone,
      onTap: onTap,
      height: 32,
      radius: 9,
      depth: 2,
      padding: const EdgeInsets.symmetric(horizontal: 8),
      child: Row(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.center, children: [
        if (icon != null) ...[Icon(icon, size: 13, color: fg), const SizedBox(width: 4)],
        Text(label.toUpperCase(), style: capsStyle(fg, size: 10).copyWith(letterSpacing: 0.4)),
        if (value != null) ...[
          const SizedBox(width: 5),
          Text(value!, style: readoutStyle(16, color: valueColor ?? fg)),
          if (unit != null) ...[const SizedBox(width: 2), Text(unit!, style: TextStyle(color: fg, fontSize: 10, fontWeight: FontWeight.w700))],
        ],
        ...?children,
      ]),
    );
  }
}

/* ---------------- fields ---------------- */

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
        Text(label, style: TextStyle(color: p.ink2, fontSize: 13, fontWeight: FontWeight.w600)),
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
          style: TextStyle(fontFamily: mono ? kMono : kSans, fontSize: mono ? 14 : 15.5, color: p.ink),
          decoration: inputDecoration(context, hint: hint, suffix: suffix),
        ),
        if (help != null) ...[const SizedBox(height: 6), Text(help!, style: TextStyle(color: p.ink3, fontSize: 12.5, height: 1.35))],
      ],
    );
  }
}

InputDecoration inputDecoration(BuildContext context, {String? hint, Widget? suffix, Widget? prefix}) {
  final p = context.pal;
  OutlineInputBorder b(Color c, [double w = 1.4]) => OutlineInputBorder(borderRadius: BorderRadius.circular(11), borderSide: BorderSide(color: c, width: w));
  return InputDecoration(
    hintText: hint,
    hintStyle: TextStyle(color: p.ink4, fontFamily: kSans, fontSize: 15),
    isDense: true,
    filled: true,
    fillColor: p.input,
    contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
    enabledBorder: b(p.line2),
    focusedBorder: b(p.ink, 1.8),
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
        padding: const EdgeInsets.symmetric(vertical: 7),
        child: Row(children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15)),
              if (hint != null) Padding(padding: const EdgeInsets.only(top: 3), child: Text(hint!, style: TextStyle(color: p.ink3, fontSize: 12.5, height: 1.35))),
            ]),
          ),
          const SizedBox(width: 12),
          Switch(value: value, onChanged: onChanged),
        ]),
      ),
    );
  }
}

/// A group title in sheets and settings: "TERMINAL".
class GroupTitle extends StatelessWidget {
  const GroupTitle(this.text, {super.key, this.top = 18});
  final String text;
  final double top;

  @override
  Widget build(BuildContext context) =>
      Padding(padding: EdgeInsets.only(top: top, bottom: 10), child: Text(text.toUpperCase(), style: capsStyle(context.pal.ink3, size: 11.5)));
}

/* ---------------- sheets & dialogs ---------------- */

class SheetAction {
  const SheetAction(this.label, this.icon, this.onTap, {this.danger = false, this.hint});
  final String label;
  final IconData icon;
  final VoidCallback onTap;
  final bool danger;
  final String? hint;
}

Future<void> showActions(BuildContext context, {String? title, String? subtitle, required List<SheetAction?> actions}) {
  final p = context.pal;
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    builder: (ctx) => SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(ctx).height * 0.85),
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(10, 0, 10, 10),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            if (title != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(14, 0, 14, 10),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(title, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700), maxLines: 1, overflow: TextOverflow.ellipsis),
                  if (subtitle != null) ...[
                    const SizedBox(height: 2),
                    Text(subtitle, style: TextStyle(color: p.ink3, fontSize: 12.5, fontFamily: kMono), maxLines: 1, overflow: TextOverflow.ellipsis),
                  ],
                ]),
              ),
            for (final a in actions)
              if (a == null)
                Padding(padding: const EdgeInsets.symmetric(vertical: 4, horizontal: 14), child: Divider(color: p.line))
              else
                InkWell(
                  borderRadius: BorderRadius.circular(12),
                  onTap: () {
                    Navigator.pop(ctx);
                    a.onTap();
                  },
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
                    child: Row(children: [
                      Icon(a.icon, size: 21, color: a.danger ? p.err : p.ink2),
                      const SizedBox(width: 16),
                      Expanded(child: Text(a.label, style: TextStyle(fontSize: 15.5, fontWeight: FontWeight.w500, color: a.danger ? p.err : p.ink))),
                      if (a.hint != null) Text(a.hint!, style: TextStyle(color: p.ink4, fontSize: 12.5, fontFamily: kMono)),
                    ]),
                  ),
                ),
          ]),
        ),
      ),
    ),
  );
}

Future<bool> confirm(BuildContext context, {required String title, required String message, String ok = 'Tasdiqlash', bool danger = false}) async {
  final p = context.pal;
  final r = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text(title, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
      content: Text(message, style: TextStyle(color: p.ink2, height: 1.45, fontSize: 15)),
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
        title: Text(title, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
        content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          if (label != null) ...[Text(label, style: TextStyle(color: ctx.pal.ink3, fontSize: 12.5, fontFamily: kMono)), const SizedBox(height: 10)],
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
      // The toast is ink-coloured: dark in the light theme, light at night.
      Icon(error ? Icons.error_outline_rounded : Icons.check_rounded, size: 18, color: error ? (p.isDark ? const Color(0xFFB42318) : const Color(0xFFFF8A7A)) : p.signal),
      const SizedBox(width: 10),
      Expanded(child: Text(message)),
    ]),
  ));
}

Future<void> copyText(BuildContext context, String text, [String message = 'Nusxalandi']) async {
  await Clipboard.setData(ClipboardData(text: text));
  if (context.mounted) toast(context, message);
}
