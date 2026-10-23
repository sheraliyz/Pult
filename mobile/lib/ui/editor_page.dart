// Code editor for remote files: line numbers, syntax colours, search &
// replace, go-to-line, undo / redo, folding (re_editor).

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:re_editor/re_editor.dart';
import 'package:re_highlight/languages/bash.dart';
import 'package:re_highlight/languages/cpp.dart';
import 'package:re_highlight/languages/css.dart';
import 'package:re_highlight/languages/diff.dart';
import 'package:re_highlight/languages/dockerfile.dart';
import 'package:re_highlight/languages/go.dart';
import 'package:re_highlight/languages/ini.dart';
import 'package:re_highlight/languages/java.dart';
import 'package:re_highlight/languages/javascript.dart';
import 'package:re_highlight/languages/json.dart';
import 'package:re_highlight/languages/lua.dart';
import 'package:re_highlight/languages/markdown.dart';
import 'package:re_highlight/languages/nginx.dart';
import 'package:re_highlight/languages/php.dart';
import 'package:re_highlight/languages/powershell.dart';
import 'package:re_highlight/languages/properties.dart';
import 'package:re_highlight/languages/python.dart';
import 'package:re_highlight/languages/rust.dart';
import 'package:re_highlight/languages/sql.dart';
import 'package:re_highlight/languages/typescript.dart';
import 'package:re_highlight/languages/xml.dart';
import 'package:re_highlight/languages/yaml.dart';
import 'package:re_highlight/re_highlight.dart';

import '../core/connection.dart';
import '../core/files.dart';
import '../core/format.dart';
import '../theme.dart';
import 'widgets.dart';

/* ---------------- languages ---------------- */

final _langs = <(RegExp, String, Mode)>[
  (RegExp(r'\.(m?jsx?|cjs)$'), 'JavaScript', langJavascript),
  (RegExp(r'\.tsx?$'), 'TypeScript', langTypescript),
  (RegExp(r'\.(json|jsonc|lock)$'), 'JSON', langJson),
  (RegExp(r'\.(py|pyw)$'), 'Python', langPython),
  (RegExp(r'\.(s?css|less|sass)$'), 'CSS', langCss),
  (RegExp(r'\.(html?|xml|svg|plist|vue)$'), 'HTML/XML', langXml),
  (RegExp(r'\.(md|markdown)$'), 'Markdown', langMarkdown),
  (RegExp(r'\.sql$'), 'SQL', langSql),
  (RegExp(r'\.(ya?ml)$|^docker-compose'), 'YAML', langYaml),
  (RegExp(r'\.php$'), 'PHP', langPhp),
  (RegExp(r'\.(c|h|cc|cpp|hpp|cxx|ino)$'), 'C/C++', langCpp),
  (RegExp(r'\.(java|kt|kts)$'), 'Java', langJava),
  (RegExp(r'\.go$'), 'Go', langGo),
  (RegExp(r'\.rs$'), 'Rust', langRust),
  (RegExp(r'\.(sh|bash|zsh|ksh)$|^\.(bashrc|zshrc|profile|bash_profile|bash_aliases)$'), 'Shell', langBash),
  (RegExp(r'nginx.*\.conf$|^nginx\.conf$'), 'Nginx', langNginx),
  (RegExp(r'^dockerfile|\.dockerfile$'), 'Dockerfile', langDockerfile),
  (RegExp(r'\.(ini|cfg|conf|toml|service|timer|socket)$'), 'INI', langIni),
  (RegExp(r'\.(properties|env)$|^\.env'), 'Properties', langProperties),
  (RegExp(r'\.lua$'), 'Lua', langLua),
  (RegExp(r'\.(diff|patch)$'), 'Diff', langDiff),
  (RegExp(r'\.ps1$'), 'PowerShell', langPowershell),
];

(String, Mode?) languageFor(String path, String text) {
  final name = pBasename(path).toLowerCase();
  for (final (re, label, mode) in _langs) {
    if (re.hasMatch(name)) return (label, mode);
  }
  if (path.contains('/nginx/')) return ('Nginx', langNginx);
  if (RegExp(r'^#!.*\b(ba|z|k)?sh\b').hasMatch(text)) return ('Shell', langBash);
  if (RegExp(r'^#!.*python').hasMatch(text)) return ('Python', langPython);
  return ('Matn', null);
}

Map<String, TextStyle> _syntax(Pal p) {
  final dark = p.isDark;
  TextStyle c(int d, int l, {bool italic = false, bool bold = false}) =>
      TextStyle(color: Color(dark ? d : l), fontStyle: italic ? FontStyle.italic : null, fontWeight: bold ? FontWeight.w700 : null);
  final keyword = c(0xFFC792EA, 0xFF7C3AED);
  final string = c(0xFFA5D6A7, 0xFF15803D);
  final number = c(0xFFF9B971, 0xFFC2410C);
  final comment = c(0xFF6A6A72, 0xFF9B9BA2, italic: true);
  final fn = c(0xFF82B1FF, 0xFF1D4ED8);
  final type = c(0xFFFFCB6B, 0xFFA16207);
  final prop = c(0xFF89DDFF, 0xFF0E7490);
  final tag = c(0xFFF07178, 0xFFBE123C);
  return {
    'root': TextStyle(color: p.fg, backgroundColor: p.bg),
    'keyword': keyword,
    'built_in': type,
    'type': type,
    'literal': number,
    'number': number,
    'string': string,
    'regexp': string,
    'subst': c(0xFFE4E4E7, 0xFF18181B),
    'comment': comment,
    'quote': comment,
    'doctag': keyword,
    'meta': comment,
    'title': fn,
    'section': tag.copyWith(fontWeight: FontWeight.w700),
    'name': tag,
    'tag': tag,
    'selector-tag': tag,
    'attr': prop,
    'attribute': prop,
    'property': prop,
    'variable': prop,
    'template-variable': prop,
    'params': c(0xFFE4E4E7, 0xFF18181B),
    'symbol': number,
    'bullet': keyword,
    'link': string.copyWith(decoration: TextDecoration.underline),
    'addition': string,
    'deletion': tag,
    'emphasis': const TextStyle(fontStyle: FontStyle.italic),
    'strong': const TextStyle(fontWeight: FontWeight.w700),
  };
}

/* ---------------- editor ---------------- */

class EditorPage extends StatefulWidget {
  const EditorPage({super.key, required this.files, required this.path, required this.text, this.line});
  final FilesController files;
  final String path;
  final String text;
  final int? line;

  @override
  State<EditorPage> createState() => _EditorPageState();
}

class _EditorPageState extends State<EditorPage> {
  late final bool crlf = widget.text.contains('\r\n');
  late final String original = crlf ? widget.text.replaceAll('\r\n', '\n') : widget.text;
  late String saved = original;
  late final controller = CodeLineEditingController.fromText(original);
  late final find = CodeFindController(controller);
  late final lang = languageFor(widget.path, original);
  bool saving = false;
  bool wrap = false;

  // Created once per light/dark: re_editor re-highlights the whole file
  // whenever it receives a different theme object.
  CodeHighlightTheme? _codeTheme;
  bool? _codeThemeDark;
  CodeHighlightTheme _themeFor(Pal p) {
    if (_codeTheme == null || _codeThemeDark != p.isDark) {
      final mode = lang.$2;
      _codeThemeDark = p.isDark;
      _codeTheme = CodeHighlightTheme(
        languages: mode == null ? const {} : {'code': CodeHighlightThemeMode(mode: mode)},
        theme: _syntax(p),
      );
    }
    return _codeTheme!;
  }

  bool get dirty => controller.text != saved;

  @override
  void initState() {
    super.initState();
    controller.addListener(_changed);
    final line = widget.line;
    if (line != null && line > 0) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _goto(line));
    }
  }

  // The editor notifies while it is itself being built (initState): defer the
  // rebuild to after the frame in that case.
  void _changed() {
    if (!mounted) return;
    if (SchedulerBinding.instance.schedulerPhase == SchedulerPhase.persistentCallbacks) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) setState(() {});
      });
    } else {
      setState(() {});
    }
  }

  @override
  void dispose() {
    controller.removeListener(_changed);
    find.dispose();
    controller.dispose();
    super.dispose();
  }

  void _goto(int line) {
    final i = (line - 1).clamp(0, controller.lineCount - 1);
    controller.selection = CodeLineSelection.collapsed(index: i, offset: 0);
    controller.makeCursorCenterIfInvisible();
  }

  Future<void> _askLine() async {
    final v = await askText(context,
        title: 'Qatorga o‘tish', label: '1 – ${controller.lineCount}', hint: 'qator raqami', ok: 'O‘tish', validate: (s) => int.tryParse(s) == null ? 'Raqam kiriting' : null);
    if (v != null) _goto(int.parse(v));
  }

  Future<void> _save() async {
    setState(() => saving = true);
    final value = controller.text;
    try {
      await widget.files.writeText(widget.path, crlf ? value.replaceAll('\n', '\r\n') : value);
      saved = value;
      if (mounted) toast(context, 'Saqlandi');
    } catch (e) {
      if (mounted) toast(context, 'Saqlab bo‘lmadi: ${classify(e).message}', error: true);
    } finally {
      if (mounted) setState(() => saving = false);
    }
  }

  void _more() {
    showActions(context, title: pBasename(widget.path), subtitle: '${lang.$1} · ${crlf ? 'CRLF' : 'LF'} · ${controller.lineCount} qator', actions: [
      SheetAction('Qidirish', Icons.search_rounded, find.findMode),
      SheetAction('Qidirish va almashtirish', Icons.find_replace_rounded, find.replaceMode),
      SheetAction('Qatorga o‘tish', Icons.format_list_numbered_rounded, _askLine),
      SheetAction(wrap ? 'Qatorlarni o‘ramaslik' : 'Qatorlarni o‘rash', Icons.wrap_text_rounded, () => setState(() => wrap = !wrap)),
      SheetAction('Hammasini belgilash', Icons.select_all_rounded, controller.selectAll),
      SheetAction('Yo‘lni nusxalash', Icons.copy_rounded, () => copyText(context, widget.path)),
    ]);
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final mono = TextStyle(fontFamily: kMono, fontSize: 12, color: p.fg3);
    return PopScope(
      canPop: !dirty,
      onPopInvokedWithResult: (didPop, _) async {
        if (didPop) return;
        final ok = await confirm(context,
            title: 'Saqlanmagan o‘zgarishlar', message: '“${pBasename(widget.path)}” dagi o‘zgarishlar yo‘qoladi. Baribir yopilsinmi?', ok: 'Yopish', danger: true);
        if (ok && context.mounted) {
          saved = controller.text;
          Navigator.pop(context);
        }
      },
      child: Scaffold(
        appBar: AppBar(
          backgroundColor: p.bg,
          surfaceTintColor: Colors.transparent,
          scrolledUnderElevation: 0,
          titleSpacing: 0,
          leadingWidth: 48,
          // Explicit, so the unsaved-changes guard (PopScope) always runs.
          leading: IconBtn(Icons.arrow_back_rounded, tip: 'Orqaga', size: 22, color: p.fg, onTap: () => Navigator.maybePop(context)),
          shape: Border(bottom: BorderSide(color: p.line)),
          title: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Flexible(child: Text(pBasename(widget.path), maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600))),
              if (dirty) ...[const SizedBox(width: 7), Dot(p.fg, size: 6)],
            ]),
            Text(lang.$1, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 11.5, color: p.fg3, fontFamily: kMono)),
          ]),
          actions: [
            IconBtn(Icons.undo_rounded, tip: 'Bekor qilish', size: 20, width: 38, onTap: controller.canUndo ? controller.undo : null, color: controller.canUndo ? p.fg2 : p.line2),
            IconBtn(Icons.redo_rounded, tip: 'Qaytarish', size: 20, width: 38, onTap: controller.canRedo ? controller.redo : null, color: controller.canRedo ? p.fg2 : p.line2),
            IconBtn(Icons.search_rounded, tip: 'Qidirish', size: 21, width: 38, onTap: find.findMode),
            IconBtn(Icons.more_vert_rounded, tip: 'Yana', size: 21, width: 36, onTap: _more),
            Padding(padding: const EdgeInsets.only(left: 4, right: 10), child: _SaveBtn(dirty: dirty, busy: saving, onTap: _save)),
          ],
        ),
        body: SafeArea(
          child: CodeEditor(
            controller: controller,
            findController: find,
            wordWrap: wrap,
            padding: const EdgeInsets.fromLTRB(8, 10, 12, 80),
            style: CodeEditorStyle(
              fontSize: 13,
              fontFamily: kMono,
              fontHeight: 1.5,
              textColor: p.fg,
              backgroundColor: p.bg,
              selectionColor: p.isDark ? const Color(0x40FFFFFF) : const Color(0x292563EB),
              highlightColor: p.isDark ? const Color(0x33FACC15) : const Color(0x38EAB308),
              cursorColor: p.fg,
              cursorLineColor: p.hover,
              chunkIndicatorColor: p.fg3,
              codeTheme: _themeFor(p),
            ),
            indicatorBuilder: (context, editing, chunk, notifier) => Row(children: [
              DefaultCodeLineNumber(controller: editing, notifier: notifier, textStyle: mono, focusedTextStyle: mono.copyWith(color: p.fg)),
              DefaultCodeChunkIndicator(width: 18, controller: chunk, notifier: notifier, painter: DefaultCodeChunkIndicatorPainter(color: p.fg3)),
            ]),
            leadingDivider: Container(width: 1, color: p.line),
            findBuilder: (context, f, readOnly) => _FindPanel(controller: f),
            toolbarController: const _SelectionMenu(),
          ),
        ),
      ),
    );
  }
}

/// Compact save button: filled when there is something to save.
class _SaveBtn extends StatelessWidget {
  const _SaveBtn({required this.dirty, required this.busy, required this.onTap});
  final bool dirty, busy;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final fg = dirty ? p.accentFg : p.fg3;
    return Tooltip(
      message: 'Saqlash (o‘zgarishlar bo‘lsa)',
      child: Material(
        color: dirty ? p.accent : Colors.transparent,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10), side: BorderSide(color: dirty ? p.accent : p.line2)),
        child: InkWell(
          borderRadius: BorderRadius.circular(10),
          onTap: dirty && !busy ? onTap : null,
          child: SizedBox(
            width: 38,
            height: 34,
            child: Center(
              child: busy
                  ? SizedBox(width: 15, height: 15, child: CircularProgressIndicator(strokeWidth: 1.8, color: fg))
                  : Icon(Icons.check_rounded, size: 20, color: fg),
            ),
          ),
        ),
      ),
    );
  }
}

/* ---------------- search panel (Uzbek) ---------------- */

class _FindPanel extends StatelessWidget implements PreferredSizeWidget {
  const _FindPanel({required this.controller});
  final CodeFindController controller;

  @override
  Size get preferredSize => Size(double.infinity, controller.value == null ? 0 : (controller.value!.replaceMode ? 104 : 56));

  @override
  Widget build(BuildContext context) {
    final v = controller.value;
    if (v == null) return const SizedBox.shrink();
    final p = context.pal;
    final r = v.result;
    final count = r == null ? (controller.findInputController.text.isEmpty ? '' : '0') : '${r.index + 1}/${r.matches.length}';
    Widget field(TextEditingController c, FocusNode f, String hint, {Widget? suffix}) => SizedBox(
          height: 38,
          child: TextField(
            controller: c,
            focusNode: f,
            autocorrect: false,
            enableSuggestions: false,
            style: TextStyle(fontFamily: kMono, fontSize: 13, color: p.fg),
            decoration: inputDecoration(context, hint: hint, suffix: suffix).copyWith(contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9)),
          ),
        );
    Widget toggle(String label, bool on, VoidCallback onTap) => InkWell(
          borderRadius: BorderRadius.circular(6),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
            child: Text(label, style: TextStyle(fontFamily: kMono, fontSize: 12.5, fontWeight: FontWeight.w600, color: on ? p.fg : p.fg3)),
          ),
        );
    return Container(
      padding: const EdgeInsets.fromLTRB(10, 8, 4, 8),
      decoration: BoxDecoration(color: p.bg2, border: Border(bottom: BorderSide(color: p.line))),
      child: Column(children: [
        Row(children: [
          Expanded(
            child: field(controller.findInputController, controller.findInputFocusNode, 'Qidirish',
                suffix: Row(mainAxisSize: MainAxisSize.min, children: [
                  toggle('Aa', v.option.caseSensitive, controller.toggleCaseSensitive),
                  toggle('.*', v.option.regex, controller.toggleRegex),
                  const SizedBox(width: 4),
                ])),
          ),
          SizedBox(width: 44, child: Text(count, textAlign: TextAlign.center, style: TextStyle(color: p.fg3, fontSize: 12))),
          IconBtn(Icons.keyboard_arrow_up_rounded, size: 22, onTap: r == null ? null : controller.previousMatch),
          IconBtn(Icons.keyboard_arrow_down_rounded, size: 22, onTap: r == null ? null : controller.nextMatch),
          IconBtn(v.replaceMode ? Icons.unfold_less_rounded : Icons.find_replace_rounded, size: 20, tip: 'Almashtirish', onTap: controller.toggleMode),
          IconBtn(Icons.close_rounded, size: 20, onTap: controller.close),
        ]),
        if (v.replaceMode) ...[
          const SizedBox(height: 8),
          Row(children: [
            Expanded(child: field(controller.replaceInputController, controller.replaceInputFocusNode, 'Almashtirish')),
            const SizedBox(width: 6),
            TextButton(onPressed: r == null ? null : controller.replaceMatch, child: Text('Bittasini', style: TextStyle(color: p.fg))),
            TextButton(onPressed: r == null ? null : controller.replaceAllMatches, child: Text('Hammasini', style: TextStyle(color: p.fg))),
          ]),
        ],
      ]),
    );
  }
}

/* ---------------- selection menu ---------------- */

class _SelectionMenu implements SelectionToolbarController {
  const _SelectionMenu();

  @override
  void hide(BuildContext context) {}

  @override
  void show({
    required BuildContext context,
    required CodeLineEditingController controller,
    required TextSelectionToolbarAnchors anchors,
    Rect? renderRect,
    required LayerLink layerLink,
    required ValueNotifier<bool> visibility,
  }) {
    PopupMenuItem<void> item(String label, VoidCallback onTap) => PopupMenuItem<void>(height: 40, onTap: onTap, child: Text(label));
    showMenu<void>(
      context: context,
      position: RelativeRect.fromSize(anchors.primaryAnchor & const Size(160, double.infinity), MediaQuery.sizeOf(context)),
      items: [
        if (!controller.selection.isCollapsed) item('Kesish', controller.cut),
        if (!controller.selection.isCollapsed) item('Nusxalash', controller.copy),
        item('Qo‘yish', controller.paste),
        item('Hammasini belgilash', controller.selectAll),
      ],
    );
  }
}
