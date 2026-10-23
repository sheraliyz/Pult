// The terminal: xterm view, copy pill, exit overlay, and the extra-keys row
// that the phone keyboard lacks (Esc, Tab, Ctrl, Alt, arrows…).

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:xterm/xterm.dart';

import '../app_state.dart';
import '../core/connection.dart';
import '../theme.dart';
import 'widgets.dart';

class TerminalPane extends StatefulWidget {
  const TerminalPane({super.key, required this.session, required this.fontSize});
  final Session session;
  final double fontSize;

  @override
  State<TerminalPane> createState() => _TerminalPaneState();
}

class _TerminalPaneState extends State<TerminalPane> {
  RemoteShell? _bound;
  final _focus = FocusNode();

  void _bind(RemoteShell? s) {
    if (identical(s, _bound)) return;
    _bound?.controller.removeListener(_rebuild);
    _bound?.onModifiersUsed = null;
    _bound = s;
    s?.controller.addListener(_rebuild);
    s?.onModifiersUsed = _rebuild;
  }

  void _rebuild() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    _bind(null);
    _focus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final shell = widget.session.active;
    _bind(shell);
    if (shell == null) return Center(child: SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: p.fg3)));
    final hasSelection = shell.controller.selection != null;
    return Stack(children: [
      Positioned.fill(
        child: TerminalView(
          shell.terminal,
          key: ObjectKey(shell),
          controller: shell.controller,
          focusNode: _focus,
          autofocus: true,
          theme: terminalTheme(p),
          textStyle: TerminalStyle(fontSize: widget.fontSize, height: 1.25, fontFamily: kMono),
          padding: const EdgeInsets.fromLTRB(10, 8, 6, 4),
          keyboardType: TextInputType.visiblePassword, // no autocorrect / suggestions
          keyboardAppearance: p.isDark ? Brightness.dark : Brightness.light,
          deleteDetection: true,
          // xterm 4.0 draws bar/underline cursors on the first row (ignores
          // the y offset); the block cursor is positioned correctly.
          cursorType: TerminalCursorType.block,
        ),
      ),
      if (hasSelection)
        Positioned(
          top: 10,
          right: 12,
          child: _Pill(icon: Icons.copy_rounded, label: 'Nusxalash', onTap: () {
            final text = shell.selectedText();
            shell.controller.clearSelection();
            if (text.isNotEmpty) copyText(context, text);
          }),
        ),
      if (shell.exited)
        Positioned(
          left: 0,
          right: 0,
          bottom: 20,
          child: Center(
            child: Container(
              padding: const EdgeInsets.fromLTRB(16, 8, 8, 8),
              decoration: BoxDecoration(color: p.bg2, borderRadius: BorderRadius.circular(14), border: Border.all(color: p.line2)),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                Text('Sessiya yakunlandi', style: TextStyle(color: p.fg2, fontWeight: FontWeight.w500)),
                const SizedBox(width: 12),
                Btn('Qayta ochish', kind: BtnKind.primary, icon: Icons.refresh_rounded, onTap: () => widget.session.conn.reopenShell(shell)),
              ]),
            ),
          ),
        ),
    ]);
  }
}

class _Pill extends StatelessWidget {
  const _Pill({required this.icon, required this.label, required this.onTap});
  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    return Material(
      color: p.fg,
      borderRadius: BorderRadius.circular(99),
      elevation: 4,
      child: InkWell(
        borderRadius: BorderRadius.circular(99),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            Icon(icon, size: 16, color: p.bg),
            const SizedBox(width: 7),
            Text(label, style: TextStyle(color: p.bg, fontWeight: FontWeight.w600, fontSize: 13.5)),
          ]),
        ),
      ),
    );
  }
}

/// Keys a phone keyboard doesn't have. Ctrl/Alt are sticky for one key.
class ExtraKeys extends StatefulWidget {
  const ExtraKeys({super.key, required this.shell});
  final RemoteShell shell;

  @override
  State<ExtraKeys> createState() => _ExtraKeysState();
}

class _ExtraKeysState extends State<ExtraKeys> {
  RemoteShell get s => widget.shell;

  void _key(TerminalKey k) {
    final ctrl = s.ctrl, alt = s.alt;
    s.ctrl = s.alt = false; // cleared first: keyInput already applies them
    s.terminal.keyInput(k, ctrl: ctrl, alt: alt);
    setState(() {});
    HapticFeedback.selectionClick();
  }

  void _text(String t) {
    s.write(t);
    setState(() {});
    HapticFeedback.selectionClick();
  }

  Future<void> _paste() async {
    final d = await Clipboard.getData(Clipboard.kTextPlain);
    final t = d?.text;
    // Line breaks are pasted as Enter (\r), like desktop terminals do.
    if (t != null && t.isNotEmpty) s.terminal.paste(t.replaceAll(RegExp(r'\r?\n'), '\r'));
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    Widget key(String label, VoidCallback onTap, {bool on = false, IconData? icon, double w = 46}) => Padding(
          padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 5),
          child: Material(
            color: on ? p.accent : p.bg3,
            borderRadius: BorderRadius.circular(8),
            child: InkWell(
              borderRadius: BorderRadius.circular(8),
              onTap: onTap,
              child: Container(
                constraints: BoxConstraints(minWidth: w),
                height: 36,
                padding: const EdgeInsets.symmetric(horizontal: 8),
                alignment: Alignment.center,
                decoration: BoxDecoration(borderRadius: BorderRadius.circular(8), border: Border.all(color: on ? p.accent : p.line)),
                child: icon != null
                    ? Icon(icon, size: 18, color: on ? p.accentFg : p.fg)
                    : Text(label, style: TextStyle(fontFamily: kMono, fontSize: 13, fontWeight: FontWeight.w500, color: on ? p.accentFg : p.fg)),
              ),
            ),
          ),
        );
    return Container(
      decoration: BoxDecoration(color: p.bg, border: Border(top: BorderSide(color: p.line))),
      child: Row(children: [
        Expanded(
          child: SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 6),
            child: Row(children: [
              key('Esc', () => _key(TerminalKey.escape)),
              key('Tab', () => _key(TerminalKey.tab)),
              key('Ctrl', () => setState(() => s.ctrl = !s.ctrl), on: s.ctrl),
              key('Alt', () => setState(() => s.alt = !s.alt), on: s.alt),
              key('', () => _key(TerminalKey.arrowLeft), icon: Icons.keyboard_arrow_left_rounded, w: 40),
              key('', () => _key(TerminalKey.arrowDown), icon: Icons.keyboard_arrow_down_rounded, w: 40),
              key('', () => _key(TerminalKey.arrowUp), icon: Icons.keyboard_arrow_up_rounded, w: 40),
              key('', () => _key(TerminalKey.arrowRight), icon: Icons.keyboard_arrow_right_rounded, w: 40),
              key('-', () => _text('-'), w: 36),
              key('/', () => _text('/'), w: 36),
              key('|', () => _text('|'), w: 36),
              key('~', () => _text('~'), w: 36),
              key('Home', () => _key(TerminalKey.home)),
              key('End', () => _key(TerminalKey.end)),
              key('PgUp', () => _key(TerminalKey.pageUp)),
              key('PgDn', () => _key(TerminalKey.pageDown)),
            ]),
          ),
        ),
        Container(width: 1, height: 26, color: p.line),
        IconBtn(Icons.content_paste_rounded, tip: 'Qo‘yish', size: 19, onTap: _paste),
        IconBtn(Icons.keyboard_hide_outlined, tip: 'Klaviaturani yopish', size: 20, onTap: () => FocusManager.instance.primaryFocus?.unfocus()),
      ]),
    );
  }
}
