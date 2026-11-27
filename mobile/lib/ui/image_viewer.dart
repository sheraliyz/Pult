// Pictures from the server, shown in the app: pinch to zoom, swipe for the
// next one in the folder (like the desktop viewer's ← →).

import 'dart:typed_data';

import 'package:flutter/material.dart';

import '../core/connection.dart';
import '../core/files.dart';
import '../core/format.dart';
import '../theme.dart';
import 'widgets.dart';

/// Extensions the phone can draw itself.
const viewableImages = {'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'heif', 'avif'};

bool isViewableImage(String name) {
  final dot = name.lastIndexOf('.');
  return dot > 0 && viewableImages.contains(name.substring(dot + 1).toLowerCase());
}

class ImageViewerPage extends StatefulWidget {
  const ImageViewerPage({super.key, required this.files, required this.entries, required this.start, this.onDownload});
  final FilesController files;
  final List<Entry> entries; // the folder's pictures
  final int start;
  final void Function(String path)? onDownload;

  @override
  State<ImageViewerPage> createState() => _ImageViewerPageState();
}

class _ImageViewerPageState extends State<ImageViewerPage> {
  late final _pages = PageController(initialPage: widget.start);
  late int _index = widget.start;
  final _cache = <String, Future<Uint8List>>{};

  Future<Uint8List> _load(Entry e) => _cache[e.name] ??= widget.files.readBytes(widget.files.path(e));

  @override
  void dispose() {
    _pages.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final e = widget.entries[_index];
    return Scaffold(
      backgroundColor: p.screen,
      body: SafeArea(
        child: Column(children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
            child: Row(children: [
              KeyIcon(Icons.arrow_back_rounded, tone: KeyTone.light, tip: 'Orqaga', onTap: () => Navigator.pop(context)),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(e.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: Color(0xFFF4F4F1), fontSize: 16, fontWeight: FontWeight.w700)),
                  Text('${_index + 1} / ${widget.entries.length} · ${fmtBytes(e.size)}', style: const TextStyle(color: Color(0xFFA3A5A8), fontSize: 12.5)),
                ]),
              ),
              if (widget.onDownload != null) KeyIcon(Icons.download_rounded, tip: 'Yuklab olish', onTap: () => widget.onDownload!(widget.files.path(e))),
            ]),
          ),
          Expanded(
            child: PageView.builder(
              controller: _pages,
              itemCount: widget.entries.length,
              onPageChanged: (i) => setState(() => _index = i),
              itemBuilder: (context, i) {
                final entry = widget.entries[i];
                return FutureBuilder<Uint8List>(
                  future: _load(entry),
                  builder: (context, snap) {
                    if (snap.hasError) return _Problem(text: classify(snap.error!).message);
                    final bytes = snap.data;
                    if (bytes == null) return Center(child: SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.2, color: p.signal)));
                    return InteractiveViewer(
                      maxScale: 8,
                      child: Center(
                        child: Image.memory(
                          bytes,
                          fit: BoxFit.contain,
                          gaplessPlayback: true,
                          errorBuilder: (_, _, _) => const _Problem(text: 'Bu rasmni telefon ko‘rsata olmadi (format qo‘llanmaydi).'),
                        ),
                      ),
                    );
                  },
                );
              },
            ),
          ),
        ]),
      ),
    );
  }
}

class _Problem extends StatelessWidget {
  const _Problem({required this.text});
  final String text;

  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(28),
          child: Text(text, textAlign: TextAlign.center, style: const TextStyle(color: Color(0xFFC9CAC5), fontSize: 15, height: 1.45)),
        ),
      );
}
