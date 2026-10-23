// Add / edit a server. Keys can be pasted, read from a file, or generated
// right here (then the public line is copied to the server's authorized_keys).

import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import '../core/keys.dart';
import '../core/store.dart';
import '../theme.dart';
import 'widgets.dart';

class FormResult {
  FormResult(this.server, this.connect);
  final Server server;
  final bool connect;
}

class ServerFormPage extends StatefulWidget {
  const ServerFormPage({super.key, required this.store, this.server});
  final Store store;
  final Server? server;

  @override
  State<ServerFormPage> createState() => _ServerFormPageState();
}

class _ServerFormPageState extends State<ServerFormPage> {
  late final Server s = widget.server?.copy() ?? Server(id: Store.newId(), name: '', host: '', username: '');
  late final host = TextEditingController(text: s.host);
  late final port = TextEditingController(text: '${s.port}');
  late final user = TextEditingController(text: s.username);
  late final name = TextEditingController(text: s.name);
  late final dir = TextEditingController(text: s.startDir);
  final password = TextEditingController();
  final passphrase = TextEditingController();
  late String auth = s.auth;
  late bool persist = s.persist;
  String? newKeyPem; // pasted / picked / generated in this form
  late String publicLine = s.publicKey;
  bool hidePw = true;
  String? error;
  bool saving = false;

  bool get editing => widget.server != null;

  @override
  void initState() {
    super.initState();
    if (editing && s.auth == 'key' && publicLine.isEmpty) {
      widget.store.privateKey(s.id).then((pem) {
        if (pem == null || !mounted) return;
        final line = publicLineOf(pem);
        if (line != null) setState(() => publicLine = line);
      });
    }
  }

  Future<void> _pasteKey() async {
    final c = TextEditingController();
    final pem = await showDialog<String>(
      context: context,
      builder: (dc) => AlertDialog(
        title: const Text('Shaxsiy kalitni joylashtiring', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
        content: TextField(
          controller: c,
          maxLines: 8,
          autofocus: true,
          autocorrect: false,
          enableSuggestions: false,
          style: const TextStyle(fontFamily: kMono, fontSize: 11.5),
          decoration: inputDecoration(dc, hint: '-----BEGIN OPENSSH PRIVATE KEY-----'),
        ),
        actionsPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        actions: [
          Btn('Bekor qilish', kind: BtnKind.ghost, onTap: () => Navigator.pop(dc)),
          Btn('Qo‘shish', kind: BtnKind.primary, onTap: () => Navigator.pop(dc, c.text.trim())),
        ],
      ),
    );
    if (pem != null && pem.isNotEmpty) _useKey(pem);
  }

  Future<void> _pickKey() async {
    final path = (await FilePicker.pickFile())?.path;
    if (path == null) return;
    try {
      _useKey(await File(path).readAsString());
    } catch (_) {
      setState(() => error = 'Faylni o‘qib bo‘lmadi');
    }
  }

  void _useKey(String pem) {
    if (!pem.contains('PRIVATE KEY')) {
      setState(() => error = 'Bu shaxsiy kalit emas (PRIVATE KEY qatori yo‘q)');
      return;
    }
    setState(() {
      newKeyPem = pem;
      publicLine = publicLineOf(pem) ?? '';
      error = null;
    });
  }

  void _generate() {
    final k = generateEd25519();
    setState(() {
      newKeyPem = k.privatePem;
      publicLine = k.publicLine;
      error = null;
    });
  }

  Future<void> _submit(bool connect) async {
    final h = host.text.trim();
    var u = user.text.trim();
    var hostOnly = h;
    var portNum = int.tryParse(port.text.trim()) ?? 22;
    final at = RegExp(r'^([^@\s]+)@(.+)$').firstMatch(hostOnly);
    if (at != null) {
      if (u.isEmpty) u = at.group(1)!;
      hostOnly = at.group(2)!;
    }
    final hp = RegExp(r'^([^:]+):(\d+)$').firstMatch(hostOnly);
    if (hp != null) {
      hostOnly = hp.group(1)!;
      portNum = int.parse(hp.group(2)!);
    }
    String? problem;
    if (hostOnly.isEmpty) {
      problem = 'Server manzilini kiriting';
    } else if (u.isEmpty) {
      problem = 'Foydalanuvchi nomini kiriting';
    } else if (portNum < 1 || portNum > 65535) {
      problem = 'Port 1–65535 oralig‘ida bo‘lsin';
    } else if (auth == 'key' && newKeyPem == null && !s.hasKey) {
      problem = 'SSH kalit qo‘shing: joylashtiring, fayldan tanlang yoki yangisini yarating';
    }
    if (problem != null) return setState(() => error = problem);

    setState(() => saving = true);
    s
      ..host = hostOnly
      ..port = portNum
      ..username = u
      ..name = name.text.trim().isEmpty ? hostOnly : name.text.trim()
      ..auth = auth
      ..persist = persist
      ..startDir = dir.text.trim()
      ..publicKey = auth == 'key' ? publicLine : '';
    final saved = await widget.store.saveServer(
      s,
      password: auth == 'password' && password.text.isNotEmpty ? password.text : null,
      privateKey: auth == 'key' ? newKeyPem : null,
      passphrase: auth == 'key' && passphrase.text.isNotEmpty ? passphrase.text : null,
    );
    if (mounted) Navigator.pop(context, FormResult(saved, connect));
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    const gap = SizedBox(height: 18);
    return Scaffold(
      appBar: AppBar(
        backgroundColor: p.bg,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        scrolledUnderElevation: 0,
        title: Text(editing ? 'Serverni tahrirlash' : 'Yangi server', style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
        shape: Border(bottom: BorderSide(color: p.line)),
      ),
      body: SafeArea(
        child: Column(children: [
          Expanded(
            child: ListView(padding: const EdgeInsets.fromLTRB(20, 20, 20, 24), children: [
              Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Expanded(child: Field(label: 'Server', controller: host, hint: 'example.com yoki 10.0.0.4', keyboard: TextInputType.url, autofocus: !editing)),
                const SizedBox(width: 12),
                SizedBox(width: 86, child: Field(label: 'Port', controller: port, keyboard: TextInputType.number, mono: true)),
              ]),
              gap,
              Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Expanded(child: Field(label: 'Foydalanuvchi', controller: user, hint: 'root')),
                const SizedBox(width: 12),
                Expanded(child: Field(label: 'Nomi', controller: name, hint: 'prod-web')),
              ]),
              gap,
              Text('Kirish usuli', style: TextStyle(color: p.fg2, fontSize: 12.5, fontWeight: FontWeight.w500)),
              const SizedBox(height: 8),
              Seg<String>(
                expand: true,
                items: const [('password', 'Parol', Icons.lock_outline_rounded), ('key', 'SSH kalit', Icons.key_rounded)],
                value: auth,
                onChanged: (v) => setState(() => auth = v),
              ),
              const SizedBox(height: 16),
              if (auth == 'password')
                Field(
                  label: 'Parol',
                  controller: password,
                  obscure: hidePw,
                  hint: s.hasPassword ? '•••••••• saqlangan' : 'Bo‘sh qolsa, har safar so‘raladi',
                  suffix: IconButton(
                    icon: Icon(hidePw ? Icons.visibility_outlined : Icons.visibility_off_outlined, size: 19, color: p.fg3),
                    onPressed: () => setState(() => hidePw = !hidePw),
                  ),
                )
              else
                _keyPanel(p),
              const SizedBox(height: 22),
              Divider(color: p.line),
              const SizedBox(height: 10),
              SwitchRow(
                title: 'Sessiyani saqlash',
                hint: 'Aloqa uzilsa ham terminal va undagi jarayonlar o‘chmaydi (serverda tmux kerak). Kompyuterdagi Pult bilan bir xil sessiyalar.',
                value: persist,
                onChanged: (v) => setState(() => persist = v),
              ),
              const SizedBox(height: 12),
              Field(label: 'Boshlang‘ich papka', controller: dir, hint: '~ (uy papkasi)', mono: true),
              if (error != null)
                Padding(padding: const EdgeInsets.only(top: 16), child: Text(error!, style: TextStyle(color: p.err, fontSize: 13.5))),
            ]),
          ),
          Container(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
            decoration: BoxDecoration(border: Border(top: BorderSide(color: p.line))),
            child: Row(children: [
              Expanded(child: Btn('Saqlash', expand: true, onTap: saving ? null : () => _submit(false))),
              const SizedBox(width: 10),
              Expanded(child: Btn('Ulanish', expand: true, kind: BtnKind.primary, busy: saving, onTap: () => _submit(true))),
            ]),
          ),
        ]),
      ),
    );
  }

  Widget _keyPanel(Pal p) {
    final hasAny = newKeyPem != null || s.hasKey;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(color: p.bg3, borderRadius: BorderRadius.circular(12), border: Border.all(color: p.line)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Icon(hasAny ? Icons.check_circle_rounded : Icons.key_off_outlined, size: 18, color: hasAny ? p.ok : p.fg3),
            const SizedBox(width: 8),
            Text(newKeyPem != null ? 'Yangi kalit tayyor' : s.hasKey ? 'Kalit saqlangan' : 'Kalit yo‘q', style: const TextStyle(fontWeight: FontWeight.w500)),
          ]),
          if (publicLine.isNotEmpty) ...[
            const SizedBox(height: 12),
            Text('Ochiq kalit — serverdagi ~/.ssh/authorized_keys fayliga qo‘shing:', style: TextStyle(color: p.fg2, fontSize: 12.5)),
            const SizedBox(height: 8),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(color: p.bg, borderRadius: BorderRadius.circular(8), border: Border.all(color: p.line)),
              child: SelectableText(publicLine, style: TextStyle(fontFamily: kMono, fontSize: 11, color: p.fg)),
            ),
            const SizedBox(height: 8),
            Align(
              alignment: Alignment.centerLeft,
              child: Btn('Ochiq kalitni nusxalash', icon: Icons.copy_rounded, onTap: () => copyText(context, publicLine)),
            ),
          ],
        ]),
      ),
      const SizedBox(height: 12),
      Wrap(spacing: 8, runSpacing: 8, children: [
        Btn('Yangi kalit yaratish', icon: Icons.auto_awesome_outlined, onTap: _generate),
        Btn('Joylashtirish', icon: Icons.content_paste_rounded, onTap: _pasteKey),
        Btn('Fayldan', icon: Icons.folder_open_rounded, onTap: _pickKey),
      ]),
      const SizedBox(height: 16),
      Field(label: 'Kalit paroli', controller: passphrase, obscure: true, hint: 'Kalit shifrlanmagan bo‘lsa — bo‘sh'),
    ]);
  }
}
