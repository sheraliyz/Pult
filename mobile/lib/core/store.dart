// Local data: servers, settings, trusted host keys. Passwords, private keys
// and passphrases go to the Android Keystore (flutter_secure_storage), never
// into the JSON files.

import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class Server {
  Server({
    required this.id,
    required this.name,
    required this.host,
    this.port = 22,
    required this.username,
    this.auth = 'password',
    this.persist = true,
    this.startDir = '',
    this.publicKey = '',
    this.hasPassword = false,
    this.hasKey = false,
    int? createdAt,
    this.lastUsed = 0,
  }) : createdAt = createdAt ?? DateTime.now().millisecondsSinceEpoch;

  final String id;
  String name;
  String host;
  int port;
  String username;
  String auth; // 'password' | 'key'
  bool persist;
  String startDir;
  String publicKey; // shown for keys generated on the phone
  bool hasPassword;
  bool hasKey;
  final int createdAt;
  int lastUsed;

  String get address => '$username@$host${port != 22 ? ':$port' : ''}';

  Map<String, dynamic> toJson() => {
        'id': id,
        'name': name,
        'host': host,
        'port': port,
        'username': username,
        'auth': auth,
        'persist': persist,
        'startDir': startDir,
        'publicKey': publicKey,
        'hasPassword': hasPassword,
        'hasKey': hasKey,
        'createdAt': createdAt,
        'lastUsed': lastUsed,
      };

  factory Server.fromJson(Map<String, dynamic> j) => Server(
        id: j['id'] as String,
        name: j['name'] as String? ?? '',
        host: j['host'] as String? ?? '',
        port: j['port'] as int? ?? 22,
        username: j['username'] as String? ?? '',
        auth: j['auth'] as String? ?? 'password',
        persist: j['persist'] as bool? ?? true,
        startDir: j['startDir'] as String? ?? '',
        publicKey: j['publicKey'] as String? ?? '',
        hasPassword: j['hasPassword'] as bool? ?? false,
        hasKey: j['hasKey'] as bool? ?? false,
        createdAt: j['createdAt'] as int?,
        lastUsed: j['lastUsed'] as int? ?? 0,
      );

  Server copy() => Server.fromJson(toJson());
}

class Settings {
  Settings({this.theme = 'system', this.fontSize = 12.5, this.extraKeys = true, this.agentUsage = true});
  String theme; // system | dark | light
  double fontSize;
  bool extraKeys;
  bool agentUsage; // Claude Code / agy limits under the top bar

  Map<String, dynamic> toJson() => {'theme': theme, 'fontSize': fontSize, 'extraKeys': extraKeys, 'agentUsage': agentUsage};
  factory Settings.fromJson(Map<String, dynamic> j) => Settings(
        theme: j['theme'] as String? ?? 'system',
        fontSize: (j['fontSize'] as num?)?.toDouble() ?? 12.5,
        extraKeys: j['extraKeys'] as bool? ?? true,
        agentUsage: j['agentUsage'] as bool? ?? true,
      );
}

/// Where secrets live. The app uses the Android Keystore; tests use memory.
abstract class SecretBox {
  Future<String?> read(String key);
  Future<void> write(String key, String? value);
}

class KeystoreSecrets implements SecretBox {
  final _s = const FlutterSecureStorage();
  @override
  Future<String?> read(String key) => _s.read(key: key);
  @override
  Future<void> write(String key, String? value) =>
      value == null || value.isEmpty ? _s.delete(key: key) : _s.write(key: key, value: value);
}

class MemorySecrets implements SecretBox {
  final _m = <String, String>{};
  @override
  Future<String?> read(String key) async => _m[key];
  @override
  Future<void> write(String key, String? value) async =>
      value == null || value.isEmpty ? _m.remove(key) : _m[key] = value;
}

class Store extends ChangeNotifier {
  Store(this.dir, this.secrets);

  final Directory dir;
  final SecretBox secrets;

  List<Server> servers = [];
  Settings settings = Settings();
  Map<String, dynamic> hostKeys = {};

  File _f(String name) => File('${dir.path}/$name');

  Future<void> load() async {
    await dir.create(recursive: true);
    servers = (_read('servers.json', []) as List).map((e) => Server.fromJson(e as Map<String, dynamic>)).toList();
    settings = Settings.fromJson(_read('settings.json', <String, dynamic>{}) as Map<String, dynamic>);
    hostKeys = _read('known_hosts.json', <String, dynamic>{}) as Map<String, dynamic>;
  }

  Object _read(String name, Object fallback) {
    try {
      return jsonDecode(_f(name).readAsStringSync()) as Object;
    } catch (_) {
      return fallback;
    }
  }

  Future<void> _write(String name, Object data) async {
    final f = _f(name);
    final tmp = File('${f.path}.tmp');
    await tmp.writeAsString(const JsonEncoder.withIndent('  ').convert(data), flush: true);
    await tmp.rename(f.path);
  }

  Future<void> _saveServers() async {
    await _write('servers.json', servers.map((s) => s.toJson()).toList());
    notifyListeners();
  }

  static String newId() {
    final r = Random.secure();
    return List.generate(12, (_) => r.nextInt(36).toRadixString(36)).join();
  }

  Server? server(String id) => servers.where((s) => s.id == id).firstOrNull;

  /// Saves [s]. Secrets: null = keep, '' = clear, text = replace.
  Future<Server> saveServer(Server s, {String? password, String? privateKey, String? passphrase}) async {
    if (password != null) {
      await secrets.write('pw:${s.id}', password);
      s.hasPassword = password.isNotEmpty;
    }
    if (privateKey != null) {
      await secrets.write('key:${s.id}', privateKey);
      s.hasKey = privateKey.isNotEmpty;
    }
    if (passphrase != null) await secrets.write('pp:${s.id}', passphrase);
    final i = servers.indexWhere((x) => x.id == s.id);
    if (i >= 0) {
      servers[i] = s;
    } else {
      servers.add(s);
    }
    await _saveServers();
    return s;
  }

  Future<void> deleteServer(String id) async {
    servers.removeWhere((s) => s.id == id);
    for (final k in ['pw', 'key', 'pp']) {
      await secrets.write('$k:$id', null);
    }
    await _saveServers();
  }

  Future<void> touch(String id) async {
    final s = server(id);
    if (s == null) return;
    s.lastUsed = DateTime.now().millisecondsSinceEpoch;
    await _saveServers();
  }

  Future<String?> password(String id) => secrets.read('pw:$id');
  Future<String?> privateKey(String id) => secrets.read('key:$id');
  Future<String?> passphrase(String id) => secrets.read('pp:$id');

  Future<void> rememberPassword(String id, String value) async {
    await secrets.write('pw:$id', value);
    server(id)?.hasPassword = true;
    await _saveServers();
  }

  Future<void> rememberPassphrase(String id, String value) => secrets.write('pp:$id', value);

  Future<void> saveSettings() async {
    await _write('settings.json', settings.toJson());
    notifyListeners();
  }

  Map<String, dynamic>? hostKey(String hostport) => hostKeys[hostport] as Map<String, dynamic>?;

  Future<void> trustHostKey(String hostport, String type, String fingerprint) async {
    hostKeys[hostport] = {'type': type, 'fingerprint': fingerprint, 'addedAt': DateTime.now().millisecondsSinceEpoch};
    await _write('known_hosts.json', hostKeys);
  }
}
