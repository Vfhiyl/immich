import 'dart:convert';

import 'package:hooks_riverpod/hooks_riverpod.dart';

/// What the QR code that an administrator shows to sign a phone in holds: `immich://login?server=…&code=…`, the server
/// (its external domain) and a one-time code that the app exchanges for a session; in self-signed mode also `pin`, the
/// SHA-256 of the server's public key (base64url), which the app trusts instead of certificate authorities (as
/// [pin]: base64)
class QrLogin {
  final String server;
  final String code;
  final String? pin;

  const QrLogin({required this.server, required this.code, this.pin});

  /// The sign-in of a scanned QR code or an opened link, or null for anything else
  static QrLogin? parse(String value) {
    final uri = Uri.tryParse(value.trim());
    if (uri == null || uri.scheme != 'immich' || uri.host != 'login') {
      return null;
    }
    final server = uri.queryParameters['server'];
    final code = uri.queryParameters['code'];
    final pin = uri.queryParameters['pin'];
    final serverUri = server == null ? null : Uri.tryParse(server);
    if (serverUri == null ||
        !(serverUri.scheme == 'https' || serverUri.scheme == 'http') ||
        serverUri.host.isEmpty ||
        code == null ||
        code.isEmpty) {
      return null;
    }
    // a key is of an HTTPS server, and a SHA-256
    final digest = pin == null ? null : _digest(pin);
    if (pin != null && (serverUri.scheme != 'https' || digest?.length != 32)) {
      return null;
    }
    return QrLogin(server: server!, code: code, pin: digest == null ? null : base64.encode(digest));
  }

  /// The SHA-256 of a pin in base64url (as the server writes it) or base64 (whose `+` a link may have turned into a
  /// space)
  static List<int>? _digest(String pin) {
    try {
      return base64.decode(base64.normalize(pin.replaceAll(' ', '+')));
    } on FormatException {
      return null;
    }
  }

  /// The key as people compare it, as the server shows it: 16 groups of 4 hexadecimal digits
  static List<String> formatPin(String pin) {
    final hex = base64.decode(pin).map((byte) => byte.toRadixString(16).padLeft(2, '0')).join().toUpperCase();
    return [for (var index = 0; index < hex.length; index += 4) hex.substring(index, index + 4)];
  }
}

/// A QR code to sign in with that was opened with the camera of the phone, for the login screen to use
final pendingQrLoginProvider = StateProvider<QrLogin?>((_) => null);
