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

  testWidgets('a long image aligned to its top: shown from its top, and double tapping keeps the middle', (
    tester,
  ) async {
    final image = (await tester.runAsync(() => createTestImage(width: 100, height: 2000)))!;
    addTearDown(image.dispose);
    final controller = PhotoViewController();
    addTearDown(controller.dispose);
    final seen = <(Size, Rect)>[];
    final drags = <String>[];

    await tester.pumpWidget(
      MaterialApp(
        home: Center(
          child: SizedBox(
            width: 200,
            height: 400,
            child: PhotoViewGestureDetectorScope(
              axis: Axis.horizontal,
              child: PhotoView(
                index: 0,
                imageProvider: _TestImageProvider(image),
                controller: controller,
                filterQuality: FilterQuality.high,
                initialScale: PhotoViewComputedScale.covered,
                minScale: PhotoViewComputedScale.contained,
                basePosition: Alignment.topCenter,
                scaleStateCycle: (state) =>
                    state == PhotoViewScaleState.initial ? PhotoViewScaleState.covering : PhotoViewScaleState.initial,
                // as the viewer, which closes or shows details on vertical drags the image does not take
                onDragStart: (_, _, _, _) => drags.add('start'),
                onDragUpdate: (_, _, _) {},
                onDragEnd: (_, _, _) {},
                overlayBuilder: (context, display, visible) {
                  seen.add((display, visible));
                  return const SizedBox.expand();
                },
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump();

    // as wide as the viewport (twice as large), from the top
    expect(seen.last, (const Size(200, 4000), const Rect.fromLTWH(0, 0, 200, 400)));

    // dragged up by about 1000, as a finger moves (and on a little, as it flings)
    await tester.timedDrag(
      find.byType(PhotoView),
      const Offset(0, -1000),
      const Duration(milliseconds: 500),
      frequency: 1000,
    );
    await tester.pumpAndSettle();
    final (_, scrolled) = seen.last;
    expect(scrolled.top, greaterThan(900));
    // the image took the drag, not the viewer
    expect(drags, isEmpty);
    // the point of the image at the middle of the viewport
    final middle = scrolled.center.dy / 2;

    // twice as large again (covering a viewport it covers already): the middle still shows that point
    await tester.tapAt(const Offset(400, 300));
    await tester.pump(const Duration(milliseconds: 50));
    await tester.tapAt(const Offset(400, 300));
    await tester.pumpAndSettle();
    final (display, zoomed) = seen.last;
    expect(display, const Size(400, 8000));
    expect(zoomed.center.dy / 4, closeTo(middle, 1));

    // and back to the width of the viewport, at the same place
    await tester.tapAt(const Offset(400, 300));
    await tester.pump(const Duration(milliseconds: 50));
    await tester.tapAt(const Offset(400, 300));
    await tester.pumpAndSettle();
    final (back, unzoomed) = seen.last;
    expect(back, const Size(200, 4000));
    expect(unzoomed.center.dy / 2, closeTo(middle, 1));
  });

  testWidgets('at the top of a long image, a drag down goes to the viewer (to close it)', (tester) async {
    final image = (await tester.runAsync(() => createTestImage(width: 100, height: 2000)))!;
    addTearDown(image.dispose);
    final drags = <String>[];

    await tester.pumpWidget(
      MaterialApp(
        home: Center(
          child: SizedBox(
            width: 200,
            height: 400,
            child: PhotoViewGestureDetectorScope(
              axis: Axis.horizontal,
              child: PhotoView(
                index: 0,
                imageProvider: _TestImageProvider(image),
                filterQuality: FilterQuality.high,
                initialScale: PhotoViewComputedScale.covered,
                minScale: PhotoViewComputedScale.contained,
                basePosition: Alignment.topCenter,
                onDragStart: (_, _, _, _) => drags.add('start'),
                onDragUpdate: (_, _, _) {},
                onDragEnd: (_, _, _) {},
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump();

    await tester.timedDrag(
      find.byType(PhotoView),
      const Offset(0, 300),
      const Duration(milliseconds: 300),
      frequency: 1000,
    );
    await tester.pumpAndSettle();
    expect(drags, ['start']);

    // and a drag up scrolls the image
    drags.clear();
    await tester.timedDrag(
      find.byType(PhotoView),
      const Offset(0, -300),
      const Duration(milliseconds: 300),
      frequency: 1000,
    );
    await tester.pumpAndSettle();
    expect(drags, isEmpty);
  });
}
