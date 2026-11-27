import 'package:flutter/material.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/utils/qr_login.dart';

/// Asks to trust the key of a server in self-signed mode, which the QR code gave: the user compares it with the one
/// the administrator sees. Pops true when it is the same.
class ServerKeyDialog extends StatelessWidget {
  final String pin;

  const ServerKeyDialog({super.key, required this.pin});

  @override
  Widget build(BuildContext context) {
    final groups = QrLogin.formatPin(pin);
    const keyStyle = TextStyle(fontFamily: 'monospace', fontFamilyFallback: ['Menlo', 'Courier'], fontSize: 16);

    return AlertDialog(
      title: Text(context.t.login_qr_key_title),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(context.t.login_qr_key_message),
          const SizedBox(height: 16),
          Center(
            child: Column(
              key: const Key('server-key'),
              children: [
                for (var row = 0; row < groups.length; row += 4)
                  Text(groups.skip(row).take(4).join('  '), style: keyStyle),
              ],
            ),
          ),
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(false), child: Text(context.t.cancel)),
        TextButton(onPressed: () => Navigator.of(context).pop(true), child: Text(context.t.login_qr_key_confirm)),
      ],
    );
  }
}
