import 'dart:convert';

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

    test('reads the key of a server in self-signed mode', () {
      final pin = base64.encode(List.generate(32, (index) => index));
      final qrLogin = QrLogin.parse(
        'immich://login?server=https%3A%2F%2F203.0.113.7%3A2283&code=c&pin=${Uri.encodeQueryComponent(pin)}',
      );

      expect(qrLogin?.server, 'https://203.0.113.7:2283');
      expect(qrLogin?.pin, pin);
      expect(QrLogin.parse('immich://login?server=https%3A%2F%2Fphotos.example.com&code=c')?.pin, isNull);
    });

    test('reads the key in base64url, as the server writes it, or with a `+` that became a space', () {
      // 0xfb 0xff …: `+/` in base64, `-_` in base64url
      final digest = List.generate(32, (index) => index.isEven ? 0xfb : 0xff);
      final pin = base64.encode(digest);
      expect(pin, contains('+'));

      for (final written in [base64Url.encode(digest).replaceAll('=', ''), pin.replaceAll('+', ' ')]) {
        final qrLogin = QrLogin.parse(
          'immich://login?server=https%3A%2F%2F203.0.113.7%3A2283&code=c&pin=${Uri.encodeQueryComponent(written)}',
        );
        expect(qrLogin?.pin, pin, reason: written);
      }
    });

    test('rejects a key that is no SHA-256, or of a server without HTTPS', () {
      final pin = Uri.encodeQueryComponent(base64.encode(List.generate(32, (index) => index)));
      for (final value in [
        'immich://login?server=http%3A%2F%2F203.0.113.7%3A2283&code=c&pin=$pin',
        'immich://login?server=https%3A%2F%2F203.0.113.7%3A2283&code=c&pin=${base64.encode([1, 2, 3])}',
        'immich://login?server=https%3A%2F%2F203.0.113.7%3A2283&code=c&pin=not%20base64!',
      ]) {
        expect(QrLogin.parse(value), isNull, reason: value);
      }
    });

    test('shows the key as the server does: 16 groups of 4 hexadecimal digits', () {
      expect(QrLogin.formatPin(base64.encode(List.generate(32, (index) => index))), [
        '0001', '0203', '0405', '0607', '0809', '0A0B', '0C0D', '0E0F', //
        '1011', '1213', '1415', '1617', '1819', '1A1B', '1C1D', '1E1F',
      ]);
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
