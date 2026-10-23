import 'package:hooks_riverpod/hooks_riverpod.dart';

/// What the QR code that an administrator shows to sign a phone in holds: `immich://login?server=…&code=…`, the server
/// (its external domain) and a one-time code that the app exchanges for a session
class QrLogin {
  final String server;
  final String code;

  const QrLogin({required this.server, required this.code});

  /// The sign-in of a scanned QR code or an opened link, or null for anything else
  static QrLogin? parse(String value) {
    final uri = Uri.tryParse(value.trim());
    if (uri == null || uri.scheme != 'immich' || uri.host != 'login') {
      return null;
    }
    final server = uri.queryParameters['server'];
    final code = uri.queryParameters['code'];
    final serverUri = server == null ? null : Uri.tryParse(server);
    if (serverUri == null ||
        !(serverUri.scheme == 'https' || serverUri.scheme == 'http') ||
        serverUri.host.isEmpty ||
        code == null ||
        code.isEmpty) {
      return null;
    }
    return QrLogin(server: server!, code: code);
  }
}

/// A QR code to sign in with that was opened with the camera of the phone, for the login screen to use
final pendingQrLoginProvider = StateProvider<QrLogin?>((_) => null);
