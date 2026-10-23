// Generate an Ed25519 key pair on the phone, in OpenSSH format.

import 'dart:convert';
import 'dart:typed_data';

import 'package:dartssh2/dartssh2.dart';
import 'package:pinenacl/ed25519.dart' as ed;

class GeneratedKey {
  GeneratedKey(this.privatePem, this.publicLine);
  final String privatePem;

  /// One line for the server's ~/.ssh/authorized_keys.
  final String publicLine;
}

// SSH wire format: uint32 length + bytes, for each field.
Uint8List _sshString(List<int> bytes) {
  final b = BytesBuilder();
  b.add((ByteData(4)..setUint32(0, bytes.length)).buffer.asUint8List());
  b.add(bytes);
  return b.toBytes();
}

GeneratedKey generateEd25519({String comment = 'pult@telefon'}) {
  final signing = ed.SigningKey.generate();
  final pub = Uint8List.fromList(signing.verifyKey.asTypedList);
  final pair = OpenSSHEd25519KeyPair(pub, Uint8List.fromList(signing.asTypedList), comment);
  final blob = (BytesBuilder()
        ..add(_sshString(utf8.encode('ssh-ed25519')))
        ..add(_sshString(pub)))
      .toBytes();
  return GeneratedKey(pair.toPem(), 'ssh-ed25519 ${base64.encode(blob)} $comment');
}

/// The public line of an existing private key (to show / copy it again).
String? publicLineOf(String pem, {String? passphrase}) {
  try {
    final pairs = SSHKeyPair.fromPem(pem, passphrase);
    if (pairs.isEmpty) return null;
    final k = pairs.first;
    return '${k.type} ${base64.encode(k.toPublicKey().encode())}';
  } catch (_) {
    return null;
  }
}
