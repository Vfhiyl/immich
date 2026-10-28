import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/widgets/photo_view/photo_view.dart';

class _TestImageProvider extends ImageProvider<_TestImageProvider> {
  final ui.Image image;

  const _TestImageProvider(this.image);

  @override
  Future<_TestImageProvider> obtainKey(ImageConfiguration configuration) => SynchronousFuture(this);

  @override
  ImageStreamCompleter loadImage(_TestImageProvider key, ImageDecoderCallback decode) =>
      OneFrameImageStreamCompleter(SynchronousFuture(ImageInfo(image: image.clone())));
}

void main() {
  testWidgets('the overlay is told the size the image is shown at and the part on the screen', (tester) async {
    final image = (await tester.runAsync(() => createTestImage(width: 100, height: 400)))!;
    addTearDown(image.dispose);
    final controller = PhotoViewController();
    addTearDown(controller.dispose);
    final seen = <(Size, Rect)>[];

    await tester.pumpWidget(
      MaterialApp(
        home: Center(
          child: SizedBox(
            width: 200,
            height: 400,
            child: PhotoView(
              index: 0,
              imageProvider: _TestImageProvider(image),
              controller: controller,
              filterQuality: FilterQuality.high,
              initialScale: PhotoViewComputedScale.contained,
              overlayBuilder: (context, display, visible) {
                seen.add((display, visible));
                return const SizedBox.expand(key: Key('overlay'));
              },
            ),
          ),
        ),
      ),
    );
    await tester.pump();

    // fit in the viewport: the whole image, which is narrower
    expect(seen.last, (const Size(100, 400), const Rect.fromLTWH(0, 0, 100, 400)));
    expect(tester.getSize(find.byKey(const Key('overlay'))), const Size(100, 400));

    // twice as large, moved down by 100: the screen shows from 100 to 500 of its 800
    controller.updateMultiple(scale: 2, position: const Offset(0, 100));
    // (the controller streams the change)
    await tester.pump();
    await tester.pump();
    expect(seen.last, (const Size(200, 800), const Rect.fromLTWH(0, 100, 200, 400)));
    expect(tester.getSize(find.byKey(const Key('overlay'))), const Size(200, 800));
  });
}
