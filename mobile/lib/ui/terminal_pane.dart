// The terminal: xterm view, copy pill, exit overlay, and the extra-keys row
// that the phone keyboard lacks (Esc, Tab, Ctrl, Alt, arrows…).

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:xterm/xterm.dart';

import '../app_state.dart';
import '../core/connection.dart';
import '../theme.dart';
import 'snippets.dart';
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
    if (shell == null) return Center(child: SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: p.signal)));
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
          padding: const EdgeInsets.fromLTRB(8, 7, 4, 4),
          keyboardType: TextInputType.visiblePassword, // no autocorrect / suggestions
          keyboardAppearance: Brightness.dark,
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
          child: Btn('Nusxalash', icon: Icons.copy_rounded, kind: BtnKind.primary, small: true, onTap: () {
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
              padding: const EdgeInsets.fromLTRB(16, 10, 10, 8),
              decoration: BoxDecoration(color: p.paper, borderRadius: BorderRadius.circular(14), border: Border.all(color: p.stroke, width: 1.4)),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                Text('Sessiya yakunlandi', style: TextStyle(color: p.ink, fontWeight: FontWeight.w600)),
                const SizedBox(width: 12),
                Btn('Qayta ochish', kind: BtnKind.primary, icon: Icons.refresh_rounded, small: true, onTap: () => widget.session.conn.reopenShell(shell)),
              ]),
            ),
          ),
        ),
    ]);
  }
}

/// Keys a phone keyboard doesn't have. Ctrl/Alt are sticky for one key.
/// With Claude Code / agy in front: a "new line" key and "send a file".
class ExtraKeys extends StatefulWidget {
  const ExtraKeys({super.key, required this.shell, this.session});
  final RemoteShell shell;
  final Session? session;

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

  // Photos, screenshots, logs… go to ~/.pult/uploads on the server and the
  // agent gets their paths (Claude Code and agy read images by path).
  Future<void> _sendFiles() async {
    final session = widget.session;
    if (session == null) return;
    final picked = await FilePicker.pickFiles();
    final paths = picked.map((f) => f.path).whereType<String>().toList();
    if (paths.isEmpty) return;
    try {
      await session.sendFiles(s, paths);
      if (mounted) toast(context, paths.length == 1 ? 'Serverga yuklanmoqda…' : '${paths.length} ta fayl yuklanmoqda…');
    } catch (e) {
      if (mounted) toast(context, '$e', error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final session = widget.session;
    final agent = session?.agentIn(s) != null;
    Widget key(String label, VoidCallback onTap, {bool on = false, IconData? icon, double w = 46, KeyTone tone = KeyTone.light}) => Padding(
          padding: const EdgeInsets.only(right: 6),
          child: KeyCap(
            tone: on ? KeyTone.signal : tone,
            onTap: onTap,
            height: 38,
            radius: 9,
            depth: 2.5,
            padding: const EdgeInsets.symmetric(horizontal: 8),
            child: ConstrainedBox(
              constraints: BoxConstraints(minWidth: w - 16),
              child: Center(
                widthFactor: 1,
                child: icon != null ? Icon(icon, size: 19) : Text(label, style: const TextStyle(fontFamily: kMono, fontSize: 13.5, fontWeight: FontWeight.w700)),
              ),
            ),
          ),
        );
    return Container(
      padding: const EdgeInsets.only(top: 6, bottom: 4),
      decoration: BoxDecoration(color: p.rail, border: Border(top: BorderSide(color: p.stroke, width: 1.4))),
      child: Row(children: [
        Expanded(
          child: SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.only(left: 8, right: 2),
            child: Row(children: [
              if (agent) ...[
                // LF: a line break inside the agent's prompt (Enter sends).
                key('', () {
                  s.newline();
                  HapticFeedback.selectionClick();
                }, icon: Icons.subdirectory_arrow_left_rounded, w: 42, tone: KeyTone.gray),
                key('', _sendFiles, icon: Icons.attach_file_rounded, w: 42, tone: KeyTone.gray),
              ],
              key('Esc', () => _key(TerminalKey.escape)),
              key('Tab', () => _key(TerminalKey.tab)),
              key('Ctrl', () => setState(() => s.ctrl = !s.ctrl), on: s.ctrl),
              key('Alt', () => setState(() => s.alt = !s.alt), on: s.alt),
              key('', () => _key(TerminalKey.arrowLeft), icon: Icons.keyboard_arrow_left_rounded, w: 42),
              key('', () => _key(TerminalKey.arrowDown), icon: Icons.keyboard_arrow_down_rounded, w: 42),
              key('', () => _key(TerminalKey.arrowUp), icon: Icons.keyboard_arrow_up_rounded, w: 42),
              key('', () => _key(TerminalKey.arrowRight), icon: Icons.keyboard_arrow_right_rounded, w: 42),
              key('-', () => _text('-'), w: 38),
              key('/', () => _text('/'), w: 38),
              key('|', () => _text('|'), w: 38),
              key('~', () => _text('~'), w: 38),
              key('Home', () => _key(TerminalKey.home)),
              key('End', () => _key(TerminalKey.end)),
              key('PgUp', () => _key(TerminalKey.pageUp)),
              key('PgDn', () => _key(TerminalKey.pageDown)),
              if (session != null) key('', () => showSnippets(context, session), icon: Icons.bolt_rounded, w: 42, tone: KeyTone.gray),
            ]),
          ),
        ),
        Container(width: 1.4, height: 30, color: p.line2),
        const SizedBox(width: 6),
        KeyIcon(Icons.content_paste_rounded, tip: 'Qo‘yish', size: 38, iconSize: 18, onTap: _paste),
        const SizedBox(width: 6),
        KeyIcon(Icons.keyboard_hide_outlined, tip: 'Klaviaturani yopish', size: 38, iconSize: 19, onTap: () => FocusManager.instance.primaryFocus?.unfocus()),
        const SizedBox(width: 8),
      ]),
    );
  }
}
