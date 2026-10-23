// SFTP file browser: browse, multi-select, copy / cut / paste, archives,
// search, properties, editor.

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:open_filex/open_filex.dart';

import '../app_state.dart';
import '../core/connection.dart';
import '../core/files.dart';
import '../core/format.dart';
import '../core/fsops.dart';
import '../theme.dart';
import 'editor_page.dart';
import 'file_kinds.dart';
import 'widgets.dart';

String? _validName(String v) {
  if (v.contains('/')) return '“/” belgisi ishlatilmaydi';
  if (v == '.' || v == '..') return 'Bu nom ishlatilmaydi';
  return null;
}

const _binaryKinds = {FileKind.apk, FileKind.exe, FileKind.package, FileKind.archive, FileKind.image, FileKind.video, FileKind.audio, FileKind.pdf, FileKind.doc, FileKind.font};

Item _item(FilesController f, Entry e) => Item(f.path(e), e.type == EntryType.dir ? 'dir' : e.type == EntryType.link ? 'link' : 'file');

/// Runs a long server operation with a spinner toast; shows errors.
Future<T?> runBusy<T>(BuildContext context, String label, Future<T> Function() fn, {String? ok}) async {
  final m = ScaffoldMessenger.maybeOf(context);
  final p = context.pal;
  m?.hideCurrentSnackBar();
  m?.showSnackBar(SnackBar(
    duration: const Duration(minutes: 30),
    content: Row(children: [
      SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: p.bg)),
      const SizedBox(width: 12),
      Text(label),
    ]),
  ));
  try {
    final r = await fn();
    m?.hideCurrentSnackBar();
    if (ok != null && context.mounted) toast(context, ok);
    return r;
  } catch (e) {
    m?.hideCurrentSnackBar();
    if (context.mounted) toast(context, classify(e).message, error: true);
    return null;
  }
}

class FilesPane extends StatelessWidget {
  const FilesPane({super.key, required this.session});
  final Session session;

  FilesController get files => session.files;
  AppState get app => session.app;

  /* ---------------- open / edit ---------------- */

  void _open(BuildContext context, Entry e) {
    if (files.selecting) return files.toggleSelect(e.name);
    if (e.isDir) {
      files.go(files.path(e)).catchError((err) {
        if (context.mounted) toast(context, classify(err).message, error: true);
        return false;
      });
    } else if (_binaryKinds.contains(kindOf(e))) {
      _actions(context, e);
    } else {
      _edit(context, files.path(e), size: e.size);
    }
  }

  static Future<void> openEditor(BuildContext context, Session session, String path, {int? size, int? line}) async {
    final files = session.files;
    try {
      final text = await files.readPath(path, size: size);
      if (!context.mounted) return;
      await Navigator.of(context).push(MaterialPageRoute(builder: (_) => EditorPage(files: files, path: path, text: text, line: line)));
      files.refresh();
    } catch (err) {
      if (!context.mounted) return;
      final c = classify(err);
      if (c.code == 'BINARY' || c.code == 'TOO_BIG') {
        final ok = await confirm(context,
            title: c.code == 'BINARY' ? 'Matnli fayl emas' : 'Fayl juda katta', message: '“${pBasename(path)}” ni tahrirlab bo‘lmaydi. Telefonga yuklab olinsinmi?', ok: 'Yuklab olish');
        if (ok && context.mounted) download(context, session, [path]);
      } else {
        toast(context, c.message, error: true);
      }
    }
  }

  Future<void> _edit(BuildContext context, String path, {int? size}) => openEditor(context, session, path, size: size);

  static Future<void> download(BuildContext context, Session session, List<String> paths) async {
    final dir = await session.app.downloadDir();
    session.app.transfers.download(session.conn, paths, dir);
    if (context.mounted) toast(context, 'Yuklab olinmoqda → ${dir.replaceFirst('/storage/emulated/0/', '')}');
  }

  /* ---------------- clipboard ---------------- */

  void _copy(BuildContext context, List<Entry> items, {required bool cut}) {
    if (items.isEmpty) return;
    app.setClip(FileClip(session.conn, cut, items.map((e) => _item(files, e)).toList()));
    files.clearSelection();
    final what = items.length == 1 ? '“${items.first.name}”' : '${items.length} ta element';
    toast(context, '$what ${cut ? 'kesib olindi' : 'nusxalandi'} — kerakli papkada “Qo‘yish”');
  }

  static Future<void> paste(BuildContext context, Session session, [String? dest]) async {
    final clip = session.app.fileClip;
    if (clip == null) return;
    if (clip.conn != session.conn) {
      toast(context, 'Boshqa serverdan nusxalangan — yuklab olib, keyin yuklang', error: true);
      return;
    }
    final files = session.files;
    final ops = files.ops;
    final done = await runBusy(context, clip.cut ? 'Ko‘chirilmoqda…' : 'Nusxalanmoqda…', () => ops.copy(clip.items, dest ?? files.cwd, move: clip.cut),
        ok: clip.cut ? 'Ko‘chirildi' : 'Nusxalandi');
    if (done != null && clip.cut) session.app.setClip(null);
    await files.refresh();
  }

  Future<void> _duplicate(BuildContext context, List<Entry> items) async {
    files.clearSelection();
    await runBusy(context, 'Nusxa yaratilmoqda…', () => files.ops.copy(items.map((e) => _item(files, e)).toList(), files.cwd));
    await files.refresh();
  }

  /* ---------------- archives ---------------- */

  Future<void> _compress(BuildContext context, List<Entry> items) async {
    final base = items.length == 1 ? items.first.name.replaceAll(archiveRe, '') : (pBasename(files.cwd) == '/' ? 'arxiv' : pBasename(files.cwd));
    final name = TextEditingController(text: base);
    var format = 'tar.gz';
    final r = await showDialog<(String, String)>(
      context: context,
      builder: (dc) => StatefulBuilder(builder: (dc, set) {
        final p = dc.pal;
        return AlertDialog(
          title: const Text('Arxivlash', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
          content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(items.length == 1 ? '“${items.first.name}” arxivga joylanadi.' : '${items.length} ta element bitta arxivga joylanadi.', style: TextStyle(color: p.fg2)),
            const SizedBox(height: 14),
            Field(label: 'Arxiv nomi', controller: name),
            const SizedBox(height: 14),
            Seg<String>(expand: true, items: const [('tar.gz', '.tar.gz', null), ('zip', '.zip', null)], value: format, onChanged: (v) => set(() => format = v)),
          ]),
          actionsPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          actions: [
            Btn('Bekor qilish', kind: BtnKind.ghost, onTap: () => Navigator.pop(dc)),
            Btn('Arxivlash', kind: BtnKind.primary, onTap: () => Navigator.pop(dc, (name.text.trim().isEmpty ? base : name.text.trim(), format))),
          ],
        );
      }),
    );
    if (r == null || !context.mounted) return;
    files.clearSelection();
    final out = await runBusy(context, 'Arxivlanmoqda…', () => files.ops.compress(files.cwd, items.map((e) => e.name).toList(), r.$1, r.$2));
    await files.refresh();
    if (out != null && context.mounted) toast(context, '“$out” tayyor');
  }

  Future<void> _extract(BuildContext context, Entry e, String mode) async {
    await runBusy(context, 'Arxiv ochilmoqda…', () => files.ops.extract(files.path(e), mode), ok: 'Arxiv ochildi');
    await files.refresh();
  }

  /* ---------------- other actions ---------------- */

  Future<void> _delete(BuildContext context, List<Entry> items) async {
    if (items.isEmpty) return;
    final what = items.length == 1 ? '“${items.first.name}”' : '${items.length} ta element';
    final ok = await confirm(context,
        title: 'O‘chirish',
        message: '$what butunlay o‘chirilsinmi?${items.any((e) => e.type == EntryType.dir) ? ' Papkalar ichidagi hamma narsa bilan o‘chadi.' : ''} Bu amalni qaytarib bo‘lmaydi.',
        ok: 'O‘chirish',
        danger: true);
    if (!ok || !context.mounted) return;
    files.clearSelection();
    await runBusy(context, 'O‘chirilmoqda…', () => files.delete(items), ok: '$what o‘chirildi');
    await files.refresh();
  }

  Future<void> _rename(BuildContext context, Entry e) async {
    final n = await askText(context, title: 'Nomini o‘zgartirish', value: e.name, selectStem: !e.isDir, validate: _validName);
    if (n == null || n == e.name || !context.mounted) return;
    await runBusy(context, 'Saqlanmoqda…', () => files.rename(e, n));
    await files.refresh();
  }

  void _cd(String path) {
    final sh = session.active;
    session.setTab(0);
    sh?.write('cd -- ${shq(path)}\r');
  }

  void _actions(BuildContext context, Entry e) {
    final kind = kindOf(e);
    final clip = app.fileClip;
    final canPaste = clip != null && clip.conn == session.conn;
    final archive = !e.isDir && isArchiveName(e.name);
    showActions(context, title: e.name, subtitle: '${kindLabel(kind)} · ${files.path(e)}', actions: [
      if (e.isDir) SheetAction('Ochish', Icons.folder_open_rounded, () => _open(context, e)),
      if (!e.isDir && !_binaryKinds.contains(kind)) SheetAction('Tahrirlash', Icons.edit_outlined, () => _edit(context, files.path(e), size: e.size)),
      if (e.isDir) SheetAction('Terminalda ochish', Icons.terminal_rounded, () => _cd(files.path(e))),
      if (archive) SheetAction('Shu yerga ochish', Icons.unarchive_outlined, () => _extract(context, e, 'here')),
      if (archive) SheetAction('“${e.name.replaceAll(archiveRe, '')}/” papkasiga ochish', Icons.unarchive_outlined, () => _extract(context, e, 'folder')),
      null,
      SheetAction('Nusxalash', Icons.copy_rounded, () => _copy(context, [e], cut: false)),
      SheetAction('Kesib olish', Icons.content_cut_rounded, () => _copy(context, [e], cut: true)),
      if (e.isDir && canPaste) SheetAction('Shu papkaga qo‘yish', Icons.content_paste_rounded, () => paste(context, session, files.path(e))),
      SheetAction('Dublikat', Icons.control_point_duplicate_rounded, () => _duplicate(context, [e])),
      SheetAction('Arxivlash', Icons.archive_outlined, () => _compress(context, [e])),
      SheetAction('Yuklab olish', Icons.download_rounded, () => download(context, session, [files.path(e)])),
      null,
      SheetAction('Nomini o‘zgartirish', Icons.drive_file_rename_outline_rounded, () => _rename(context, e)),
      SheetAction('Huquqlar', Icons.lock_outline_rounded, () => _chmod(context, e)),
      SheetAction('Xususiyatlar', Icons.info_outline_rounded, () => showProperties(context, session, e)),
      SheetAction('Yo‘lni nusxalash', Icons.link_rounded, () => copyText(context, files.path(e))),
      null,
      SheetAction('O‘chirish', Icons.delete_outline_rounded, () => _delete(context, [e]), danger: true),
    ]);
  }

  Future<void> _chmod(BuildContext context, Entry e) async {
    var mode = e.mode & 0x1FF;
    final r = await showDialog<int>(
      context: context,
      builder: (dc) => StatefulBuilder(builder: (dc, set) {
        final p = dc.pal;
        Widget cell(int bit) => Checkbox(value: mode & bit != 0, onChanged: (v) => set(() => mode = v == true ? mode | bit : mode & ~bit));
        TableRow row(String label, int shift) => TableRow(children: [
              Padding(padding: const EdgeInsets.symmetric(vertical: 12), child: Text(label, style: TextStyle(color: p.fg2))),
              for (final b in [4, 2, 1]) Center(child: cell(b << shift)),
            ]);
        Widget head(String t) => Center(child: Text(t, style: TextStyle(color: p.fg3, fontSize: 11.5)));
        return AlertDialog(
          title: const Text('Huquqlar', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
          content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(files.path(e), style: TextStyle(fontFamily: kMono, fontSize: 12, color: p.fg3)),
            const SizedBox(height: 12),
            Table(columnWidths: const {0: FlexColumnWidth(1.4)}, children: [
              TableRow(children: [const SizedBox(), head('O‘qish'), head('Yozish'), head('Bajarish')]),
              row('Egasi', 6),
              row('Guruh', 3),
              row('Boshqalar', 0),
            ]),
            const SizedBox(height: 8),
            Text('Sakkizlik: ${fmtOctal(mode)}   ${fmtMode(mode, dir: e.isDir)}', style: TextStyle(fontFamily: kMono, fontSize: 12.5, color: p.fg2)),
          ]),
          actionsPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          actions: [
            Btn('Bekor qilish', kind: BtnKind.ghost, onTap: () => Navigator.pop(dc)),
            Btn('Saqlash', kind: BtnKind.primary, onTap: () => Navigator.pop(dc, mode)),
          ],
        );
      }),
    );
    if (r == null || !context.mounted) return;
    await runBusy(context, 'Saqlanmoqda…', () => files.chmod(e, r));
    await files.refresh();
  }

  /* ---------------- toolbar actions (called by the session page) ---------------- */

  static Future<void> upload(BuildContext context, Session session) async {
    final picked = await FilePicker.pickFiles();
    final paths = picked.map((f) => f.path).whereType<String>().toList();
    if (paths.isEmpty) return;
    session.app.transfers.upload(session.conn, paths, session.files.cwd);
  }

  static Future<void> newFolder(BuildContext context, Session session) async {
    final f = session.files;
    final n = await askText(context, title: 'Yangi papka', label: f.cwd, hint: 'papka-nomi', ok: 'Yaratish', validate: _validName);
    if (n == null || !context.mounted) return;
    await runBusy(context, 'Yaratilmoqda…', () => f.mkdir(n));
    await f.refresh();
  }

  static Future<void> newFile(BuildContext context, Session session) async {
    final f = session.files;
    final n = await askText(context, title: 'Yangi fayl', label: f.cwd, hint: 'fayl.txt', ok: 'Yaratish', validate: _validName);
    if (n == null || !context.mounted) return;
    final ok = await runBusy(context, 'Yaratilmoqda…', () async {
      await f.touch(n);
      return true;
    });
    await f.refresh();
    if (ok == true && context.mounted) {
      await Navigator.of(context).push(MaterialPageRoute(builder: (_) => EditorPage(files: f, path: pJoin(f.cwd, n), text: '')));
      await f.refresh();
    }
  }

  static Future<void> openLocal(String path) => OpenFilex.open(path);

  static void openSearch(BuildContext context, Session session) {
    Navigator.of(context).push(MaterialPageRoute(builder: (_) => SearchPage(session: session)));
  }

  /* ---------------- view ---------------- */

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    return ListenableBuilder(
      listenable: Listenable.merge([files, app]),
      builder: (context, _) {
        final list = files.visible;
        final clip = app.fileClip;
        final showClip = clip != null && clip.conn == session.conn && !files.selecting;
        final Widget body;
        if (!files.loaded && files.error != null) {
          body = _EmptyState(
            icon: Icons.error_outline_rounded,
            title: 'Papkani ochib bo‘lmadi',
            text: files.error!,
            action: Btn('Qayta urinish', onTap: () => files.init(session.server.startDir).catchError((_) {})),
          );
        } else if (list.isEmpty && files.loaded) {
          body = const _EmptyState(icon: Icons.folder_open_rounded, title: 'Bo‘sh papka', text: 'Yuqoridagi yuklash tugmasi bilan fayl qo‘shing');
        } else {
          body = ListView.builder(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.only(bottom: 24),
            itemCount: list.length,
            itemBuilder: (context, i) {
              final e = list[i];
              return _Row(
                entry: e,
                selecting: files.selecting,
                selected: files.selected.contains(e.name),
                onTap: () => _open(context, e),
                onLongPress: () => files.toggleSelect(e.name),
                onMore: () => _actions(context, e),
              );
            },
          );
        }
        return Column(children: [
          if (files.selecting)
            _SelectionBar(files: files)
          else
            _PathBar(files: files, onGo: (path) => files.go(path).catchError((err) {
                  if (context.mounted) toast(context, classify(err).message, error: true);
                  return false;
                })),
          SizedBox(
            height: 2,
            child: files.loading ? LinearProgressIndicator(minHeight: 1.5, backgroundColor: p.line, color: p.fg2) : Divider(color: p.line, height: 1),
          ),
          if (showClip) _ClipBar(clip: clip, onPaste: () => paste(context, session), onCancel: () => app.setClip(null)),
          Expanded(child: RefreshIndicator(color: p.fg, backgroundColor: p.bg2, onRefresh: files.refresh, child: body)),
          if (files.selecting)
            _SelectionActions(
              onCopy: () => _copy(context, files.selectedEntries, cut: false),
              onCut: () => _copy(context, files.selectedEntries, cut: true),
              onArchive: () => _compress(context, files.selectedEntries),
              onDownload: () {
                final paths = files.selectedEntries.map(files.path).toList();
                files.clearSelection();
                download(context, session, paths);
              },
              onDelete: () => _delete(context, files.selectedEntries),
            ),
        ]);
      },
    );
  }
}

/* ---------------- pieces ---------------- */

class _PathBar extends StatefulWidget {
  const _PathBar({required this.files, required this.onGo});
  final FilesController files;
  final ValueChanged<String> onGo;

  @override
  State<_PathBar> createState() => _PathBarState();
}

class _PathBarState extends State<_PathBar> {
  final _scroll = ScrollController();

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final cwd = widget.files.cwd;
    // Long paths: keep the current folder (the end) in view.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) _scroll.jumpTo(_scroll.position.maxScrollExtent);
    });
    final parts = cwd.split('/').where((s) => s.isNotEmpty).toList();
    Widget crumb(String label, String target, bool current) => InkWell(
          borderRadius: BorderRadius.circular(7),
          onTap: () => widget.onGo(target),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 6),
            child: Text(label, style: TextStyle(color: current ? p.fg : p.fg2, fontWeight: current ? FontWeight.w600 : FontWeight.w400, fontSize: 14)),
          ),
        );
    final crumbs = <Widget>[crumb('/', '/', parts.isEmpty)];
    var acc = '';
    for (var i = 0; i < parts.length; i++) {
      acc += '/${parts[i]}';
      if (i > 0) crumbs.add(Text('/', style: TextStyle(color: p.fg3)));
      crumbs.add(crumb(parts[i], acc, i == parts.length - 1));
    }
    return SizedBox(
      height: 48,
      child: Row(children: [
        IconBtn(Icons.arrow_upward_rounded, tip: 'Yuqori papka', size: 20, onTap: cwd == '/' || cwd.isEmpty ? null : () => widget.onGo(pDirname(cwd))),
        Expanded(child: SingleChildScrollView(controller: _scroll, scrollDirection: Axis.horizontal, child: Row(children: crumbs))),
        const SizedBox(width: 8),
      ]),
    );
  }
}

class _SelectionBar extends StatelessWidget {
  const _SelectionBar({required this.files});
  final FilesController files;

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final all = files.selected.length >= files.visible.length;
    return SizedBox(
      height: 48,
      child: Row(children: [
        IconBtn(Icons.close_rounded, tip: 'Bekor qilish', size: 21, color: p.fg, onTap: files.clearSelection),
        Expanded(child: Text('${files.selected.length} ta tanlandi', style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600))),
        TextButton(onPressed: all ? files.clearSelection : files.selectAll, child: Text(all ? 'Hech qaysi' : 'Hammasi', style: TextStyle(color: p.fg))),
        const SizedBox(width: 6),
      ]),
    );
  }
}

class _SelectionActions extends StatelessWidget {
  const _SelectionActions({required this.onCopy, required this.onCut, required this.onArchive, required this.onDownload, required this.onDelete});
  final VoidCallback onCopy, onCut, onArchive, onDownload, onDelete;

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    Widget action(IconData icon, String label, VoidCallback onTap, {bool danger = false}) => Expanded(
          child: InkWell(
            onTap: onTap,
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                Icon(icon, size: 21, color: danger ? p.err : p.fg),
                const SizedBox(height: 4),
                Text(label, style: TextStyle(fontSize: 11.5, color: danger ? p.err : p.fg2)),
              ]),
            ),
          ),
        );
    return Container(
      decoration: BoxDecoration(color: p.bg2, border: Border(top: BorderSide(color: p.line))),
      child: Row(children: [
        action(Icons.copy_rounded, 'Nusxalash', onCopy),
        action(Icons.content_cut_rounded, 'Kesish', onCut),
        action(Icons.archive_outlined, 'Arxivlash', onArchive),
        action(Icons.download_rounded, 'Yuklab olish', onDownload),
        action(Icons.delete_outline_rounded, 'O‘chirish', onDelete, danger: true),
      ]),
    );
  }
}

class _ClipBar extends StatelessWidget {
  const _ClipBar({required this.clip, required this.onPaste, required this.onCancel});
  final FileClip clip;
  final VoidCallback onPaste, onCancel;

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final what = clip.items.length == 1 ? '“${clip.items.first.name}”' : '${clip.items.length} ta element';
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 8, 12, 2),
      padding: const EdgeInsets.fromLTRB(12, 4, 4, 4),
      decoration: BoxDecoration(color: p.bg2, borderRadius: BorderRadius.circular(12), border: Border.all(color: p.line2)),
      child: Row(children: [
        Icon(clip.cut ? Icons.content_cut_rounded : Icons.copy_rounded, size: 16, color: p.fg3),
        const SizedBox(width: 10),
        Expanded(child: Text(what, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: p.fg2, fontSize: 13))),
        TextButton.icon(
          onPressed: onPaste,
          icon: Icon(Icons.content_paste_rounded, size: 17, color: p.accentFg),
          label: Text('Qo‘yish', style: TextStyle(color: p.accentFg, fontWeight: FontWeight.w600)),
          style: TextButton.styleFrom(backgroundColor: p.accent, padding: const EdgeInsets.symmetric(horizontal: 12), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(9))),
        ),
        IconBtn(Icons.close_rounded, size: 18, onTap: onCancel),
      ]),
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({required this.entry, required this.selecting, required this.selected, required this.onTap, required this.onLongPress, required this.onMore});
  final Entry entry;
  final bool selecting, selected;
  final VoidCallback onTap, onLongPress, onMore;

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final e = entry;
    final kind = kindOf(e);
    final color = kindColor(kind, dark: p.isDark);
    final meta = e.isDir ? 'Papka · ${fmtDate(e.mtime)}' : '${fmtBytes(e.size)} · ${fmtDate(e.mtime)}';
    return Material(
      color: selected ? p.active : Colors.transparent,
      child: InkWell(
        onTap: onTap,
        onLongPress: onLongPress,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 9, 4, 9),
          child: Row(children: [
            Container(
              width: 38,
              height: 38,
              decoration: BoxDecoration(color: color.withValues(alpha: p.isDark ? 0.14 : 0.11), borderRadius: BorderRadius.circular(10)),
              child: Icon(kindIcon(kind), size: 20, color: color),
            ),
            const SizedBox(width: 13),
            Expanded(
              child: Opacity(
                opacity: e.hidden ? 0.6 : 1,
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [
                    Flexible(
                      child: Text(e.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 15, fontWeight: e.isDir ? FontWeight.w600 : FontWeight.w400)),
                    ),
                    if (e.type == EntryType.link) ...[const SizedBox(width: 6), Icon(Icons.link_rounded, size: 14, color: p.fg3)],
                  ]),
                  const SizedBox(height: 2),
                  Text(meta, style: TextStyle(color: p.fg3, fontSize: 12)),
                ]),
              ),
            ),
            if (selecting)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 12),
                child: Icon(selected ? Icons.check_circle_rounded : Icons.radio_button_unchecked_rounded, size: 22, color: selected ? p.fg : p.line2),
              )
            else ...[
              if (e.isDir) Padding(padding: const EdgeInsets.only(right: 2), child: Icon(Icons.chevron_right_rounded, size: 20, color: p.fg3)),
              IconBtn(Icons.more_vert_rounded, size: 19, color: p.fg3, onTap: onMore),
            ],
          ]),
        ),
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState({required this.icon, required this.title, required this.text, this.action});
  final IconData icon;
  final String title, text;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    return ListView(physics: const AlwaysScrollableScrollPhysics(), children: [
      const SizedBox(height: 90),
      Center(
        child: Container(
          width: 50,
          height: 50,
          decoration: BoxDecoration(color: p.hover, borderRadius: BorderRadius.circular(14)),
          child: Icon(icon, color: p.fg3),
        ),
      ),
      const SizedBox(height: 14),
      Center(child: Text(title, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15))),
      const SizedBox(height: 4),
      Padding(padding: const EdgeInsets.symmetric(horizontal: 32), child: Text(text, textAlign: TextAlign.center, style: TextStyle(color: p.fg3))),
      if (action != null) ...[const SizedBox(height: 16), Center(child: action)],
    ]);
  }
}

/* ---------------- properties ---------------- */

Future<void> showProperties(BuildContext context, Session session, Entry? e) async {
  final files = session.files;
  final path = e == null ? files.cwd : files.path(e);
  final isDir = e == null || e.isDir;
  final kind = e == null ? FileKind.folder : kindOf(e);
  final infoF = files.ops.info(path).then<FileInfo?>((v) => v, onError: (_) => null);
  ({int? bytes, int files, int dirs})? size;
  var counting = false;
  await showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    builder: (ctx) => StatefulBuilder(builder: (ctx, set) {
      final p = ctx.pal;
      Widget row(String k, String? v, {bool mono = false, Widget? trailing}) => Padding(
            padding: const EdgeInsets.symmetric(vertical: 9),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              SizedBox(width: 118, child: Text(k, style: TextStyle(color: p.fg3))),
              Expanded(child: trailing ?? SelectableText(v ?? '—', style: TextStyle(fontFamily: mono ? kMono : kSans, fontSize: mono ? 12.5 : 14))),
            ]),
          );
      return SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
          child: FutureBuilder<FileInfo?>(
            future: infoF,
            builder: (ctx, snap) {
              final i = snap.data;
              final mode = e?.mode ?? i?.mode;
              final sizeText = !isDir
                  ? fmtBytes(e.size)
                  : size == null
                      ? null
                      : '${size!.bytes != null ? '${fmtBytes(size!.bytes)} · ' : ''}${size!.files} fayl, ${size!.dirs} papka';
              return Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  Icon(kindIcon(kind), color: kindColor(kind, dark: p.isDark)),
                  const SizedBox(width: 10),
                  Expanded(child: Text(e?.name ?? (pBasename(path)), maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600))),
                ]),
                const SizedBox(height: 8),
                row('Turi', kindLabel(kind)),
                row('Joylashuvi', path, mono: true),
                row('Hajmi', sizeText,
                    trailing: sizeText != null
                        ? null
                        : counting
                            ? Row(children: [SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 1.8, color: p.fg3)), const SizedBox(width: 8), Text('hisoblanmoqda…', style: TextStyle(color: p.fg3))])
                            : Align(
                                alignment: Alignment.centerLeft,
                                child: InkWell(
                                  onTap: () async {
                                    set(() => counting = true);
                                    final s = await files.ops.dirSize(path).then<({int? bytes, int files, int dirs})?>((v) => v, onError: (_) => null);
                                    set(() {
                                      counting = false;
                                      size = s ?? (bytes: null, files: 0, dirs: 0);
                                    });
                                  },
                                  child: Text('Hajmini hisoblash', style: TextStyle(color: p.fg, decoration: TextDecoration.underline)),
                                ),
                              )),
                row('O‘zgartirilgan', fmtDate(e?.mtime ?? i?.mtime)),
                row('Huquqlar', mode == null ? null : '${fmtMode(mode, dir: isDir)}  (${fmtOctal(mode)})', mono: true),
                row('Egasi', e?.owner ?? i?.owner),
                if (i?.mime != null) row('MIME', i!.mime, mono: true),
                if (i?.real != null && i!.real != path) row('Havola manzili', i.real, mono: true),
                const SizedBox(height: 8),
                Btn('Yo‘lni nusxalash', icon: Icons.copy_rounded, onTap: () => copyText(ctx, path)),
              ]);
            },
          ),
        ),
      );
    }),
  );
}

/* ---------------- search ---------------- */

class SearchPage extends StatefulWidget {
  const SearchPage({super.key, required this.session});
  final Session session;

  @override
  State<SearchPage> createState() => _SearchPageState();
}

class _SearchPageState extends State<SearchPage> {
  final input = TextEditingController();
  String mode = 'name';
  List<SearchHit>? results;
  String? error;
  bool busy = false;
  int seq = 0;

  FilesController get files => widget.session.files;

  Future<void> _run() async {
    final q = input.text.trim();
    if (q.isEmpty) return;
    final my = ++seq;
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final r = await files.ops.search(files.cwd, q, mode);
      if (my == seq && mounted) setState(() => results = r);
    } catch (e) {
      if (my == seq && mounted) setState(() => error = classify(e).message);
    } finally {
      if (my == seq && mounted) setState(() => busy = false);
    }
  }

  Future<void> _open(SearchHit h) async {
    final nav = Navigator.of(context);
    if (h.type == 'dir') {
      nav.pop();
      await files.go(h.path).catchError((_) => false);
      return;
    }
    if (h.line != null) {
      await FilesPane.openEditor(context, widget.session, h.path, line: h.line);
      return;
    }
    nav.pop();
    await files.go(pDirname(h.path)).catchError((_) => false);
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final list = results;
    return Scaffold(
      appBar: AppBar(
        backgroundColor: p.bg,
        surfaceTintColor: Colors.transparent,
        scrolledUnderElevation: 0,
        titleSpacing: 0,
        shape: Border(bottom: BorderSide(color: p.line)),
        title: TextField(
          controller: input,
          autofocus: true,
          autocorrect: false,
          enableSuggestions: false,
          textInputAction: TextInputAction.search,
          onSubmitted: (_) => _run(),
          style: const TextStyle(fontSize: 16),
          decoration: InputDecoration(border: InputBorder.none, hintText: 'Qidirish: ${pBasename(files.cwd)}', hintStyle: TextStyle(color: p.fg3)),
        ),
        actions: [IconBtn(Icons.search_rounded, color: p.fg, onTap: _run)],
      ),
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
          child: Seg<String>(
            expand: true,
            items: const [('name', 'Fayl nomi', Icons.insert_drive_file_outlined), ('content', 'Fayl ichida', Icons.text_snippet_outlined)],
            value: mode,
            onChanged: (v) {
              setState(() => mode = v);
              _run();
            },
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 8),
          child: Row(children: [
            if (busy) ...[SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 1.8, color: p.fg3)), const SizedBox(width: 8)],
            Expanded(
              child: Text(
                error ?? (busy ? 'Qidirilmoqda…' : list == null ? '${files.cwd} va ichidagi papkalarda' : list.isEmpty ? 'Hech narsa topilmadi' : '${list.length}${list.length >= 300 ? '+' : ''} ta natija'),
                style: TextStyle(color: error != null ? p.err : p.fg3, fontSize: 12.5),
              ),
            ),
          ]),
        ),
        Expanded(
          child: ListView.builder(
            itemCount: list?.length ?? 0,
            itemBuilder: (context, i) {
              final h = list![i];
              final rel = h.path.startsWith('${files.cwd}/') ? h.path.substring(files.cwd.length + 1) : h.path;
              final kind = kindOf(Entry(name: pBasename(h.path), type: h.type == 'dir' ? EntryType.dir : EntryType.file));
              final color = kindColor(kind, dark: p.isDark);
              return InkWell(
                onTap: () => _open(h),
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(16, 9, 16, 9),
                  child: Row(children: [
                    Container(
                      width: 34,
                      height: 34,
                      decoration: BoxDecoration(color: color.withValues(alpha: p.isDark ? 0.14 : 0.11), borderRadius: BorderRadius.circular(9)),
                      child: Icon(kindIcon(kind), size: 18, color: color),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text.rich(
                          TextSpan(text: rel, children: [if (h.line != null) TextSpan(text: ':${h.line}', style: TextStyle(color: p.fg3))]),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontSize: 14.5),
                        ),
                        if (h.text != null)
                          Text(h.text!, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontFamily: kMono, fontSize: 12, color: p.fg3))
                        else if (h.size != null && h.type != 'dir')
                          Text(fmtBytes(h.size), style: TextStyle(color: p.fg3, fontSize: 12)),
                      ]),
                    ),
                  ]),
                ),
              );
            },
          ),
        ),
      ]),
    );
  }
}
