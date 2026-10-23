import 'dart:async';

import 'package:auto_route/auto_route.dart';
import 'package:flutter/material.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/utils/qr_login.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

/// Scans the QR code an administrator shows to sign the phone in, and goes back with what it holds
@RoutePage()
class QrScanPage extends StatefulWidget {
  const QrScanPage({super.key});

  @override
  State<QrScanPage> createState() => _QrScanPageState();
}

class _QrScanPageState extends State<QrScanPage> {
  final _controller = MobileScannerController(formats: const [BarcodeFormat.qrCode]);
  bool _isDone = false;
  String? _rejected;

  @override
  void dispose() {
    unawaited(_controller.dispose());
    super.dispose();
  }

  void _onDetect(BarcodeCapture capture) {
    if (_isDone) {
      return;
    }
    for (final barcode in capture.barcodes) {
      final value = barcode.rawValue;
      if (value == null) {
        continue;
      }
      final qrLogin = QrLogin.parse(value);
      if (qrLogin != null) {
        _isDone = true;
        unawaited(context.maybePop(qrLogin));
        return;
      }
      // another QR code: told once, while it is in front of the camera
      if (_rejected != value) {
        _rejected = value;
        ImmichToast.show(context: context, msg: context.t.login_qr_invalid, toastType: ToastType.error);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(context.t.login_scan_qr_code)),
      body: Stack(
        children: [
          MobileScanner(controller: _controller, onDetect: _onDetect),
          Align(
            alignment: Alignment.bottomCenter,
            child: SafeArea(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Text(
                  context.t.login_qr_scan_hint,
                  textAlign: TextAlign.center,
                  style: context.textTheme.bodyLarge?.copyWith(color: Colors.white),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
