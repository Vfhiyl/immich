import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/utils/qr_login.dart';

void main() {
  group('QrLogin.parse', () {
    test('reads the server and the code of a QR code an administrator shows', () {
      final qrLogin = QrLogin.parse('immich://login?server=https%3A%2F%2Fphotos.example.com&code=abc123');

      expect(qrLogin?.server, 'https://photos.example.com');
      expect(qrLogin?.code, 'abc123');
    });

    test('takes a server on a port, over plain http too', () {
      expect(
        QrLogin.parse('immich://login?server=http%3A%2F%2F192.168.1.10%3A2283&code=c')?.server,
        'http://192.168.1.10:2283',
      );
    });

    test('rejects anything else', () {
      for (final value in [
        'https://photos.example.com',
        'immich://asset?id=1',
        'immich://login?code=abc',
        'immich://login?server=https%3A%2F%2Fphotos.example.com',
        'immich://login?server=ftp%3A%2F%2Fphotos.example.com&code=abc',
        'immich://login?server=photos.example.com&code=abc',
        'not a link',
      ]) {
        expect(QrLogin.parse(value), isNull, reason: value);
      }
    });
  });
}
