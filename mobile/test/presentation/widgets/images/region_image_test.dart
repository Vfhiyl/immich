import 'dart:async';
import 'dart:ffi' show Uint8, Uint8Pointer;
import 'dart:ui' as ui;

import 'package:ffi/ffi.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/platform/region_image_api.g.dart';
import 'package:immich_mobile/presentation/widgets/images/image_provider.dart';
import 'package:immich_mobile/presentation/widgets/images/region_image.dart';

import '../../../unit/presentation/presentation_context.dart';

class _Decode {
  final int requestId;
  final int x;
  final int y;
  final int width;
  final int height;
  final int sample;
  final reply = Completer<Map<String, int>?>();

  _Decode(this.requestId, this.x, this.y, this.width, this.height, this.sample);

  /// Replies with pixels, as the platform does (malloc'd, freed by the image)
  void succeed() {
    final width = (this.width + sample - 1) ~/ sample;
    final height = (this.height + sample - 1) ~/ sample;
    final pixels = malloc.allocate<Uint8>(width * height * 4);
    // opaque red
    final bytes = pixels.asTypedList(width * height * 4);
    for (var i = 0; i < bytes.length; i += 4) {
      bytes
        ..[i] = 255
        ..[i + 1] = 0
        ..[i + 2] = 0
        ..[i + 3] = 255;
    }
    reply.complete({'pointer': pixels.address, 'width': width, 'height': height, 'rowBytes': width * 4});
  }
}

class _FakeRegionImageApi extends RegionImageApi {
  final opens = <Completer<Map<String, int>?>>[];
  final decodes = <_Decode>[];
  final cancelled = <int>[];
  final closed = <int>[];

  @override
  Future<Map<String, int>?> open({String? localAssetId, String? url, required int requestId}) {
    final reply = Completer<Map<String, int>?>();
    opens.add(reply);
    return reply.future;
  }

  @override
  Future<Map<String, int>?> decode(
    int imageId, {
    required int requestId,
    required int x,
    required int y,
    required int width,
    required int height,
    required int sample,
  }) {
    final decode = _Decode(requestId, x, y, width, height, sample);
    decodes.add(decode);
    return decode.reply.future;
  }

  @override
  Future<void> cancel(int requestId) async => cancelled.add(requestId);

  @override
  Future<void> close(int imageId) async => closed.add(imageId);
}

// A long screenshot of 1080 x 20000, its base 221 x 4096 (on a screen of 1080 x 2400)
const _width = 1080;
const _height = 20000;
const _basePixels = 221.0 * 4096;

void main() {
  group('regionBaseSize', () {
    const screen = Size(1080, 2400);

    test('is at most twice the pixels of the screen', () {
      expect(regionBaseSize(4000, 3000, screen), const Size(2629, 1972));
    });

    test('is at most 4096 pixels on its long side', () {
      expect(regionBaseSize(_width, _height, screen), const Size(221, 4096));
    });

    test('is the image when that is smaller', () {
      expect(regionBaseSize(1000, 800, screen), const Size(1000, 800));
    });
  });

  group('getRegionSource', () {
    late PresentationContext context;

    setUp(() async => context = await PresentationContext.create());
    tearDown(() async => context.dispose());

    const screen = Size(400, 800);
    LocalAsset local(String name, int width, int height, {AssetPlaybackStyle style = AssetPlaybackStyle.image}) =>
        LocalAsset(
          id: 'local',
          name: name,
          type: AssetType.image,
          createdAt: DateTime(2026),
          updatedAt: DateTime(2026),
          width: width,
          height: height,
          playbackStyle: style,
          isEdited: false,
        );
    RemoteAsset remote(String name, int width, int height) => RemoteAsset(
      id: 'remote',
      name: name,
      ownerId: 'owner',
      checksum: 'checksum',
      type: AssetType.image,
      createdAt: DateTime(2026),
      updatedAt: DateTime(2026),
      width: width,
      height: height,
      isEdited: false,
    );

    test('shows a large local photo from its original', () {
      final region = getRegionSource(local('photo.HEIC', 4032, 3024), size: screen, android: true)!;
      expect(region.localAssetId, 'local');
      expect(region.basePixels, lessThan(4032 * 3024));
    });

    test('decodes whole what the decoders do not read, animated images, and small images', () {
      expect(getRegionSource(local('photo.webp', 4032, 3024), size: screen, android: true), isNull);
      expect(
        getRegionSource(
          local('a.png', 4032, 3024, style: AssetPlaybackStyle.imageAnimated),
          size: screen,
          android: true,
        ),
        isNull,
      );
      expect(getRegionSource(local('small.jpg', 800, 600), size: screen, android: true), isNull);
    });

    test('is not used on iOS yet', () {
      expect(getRegionSource(local('photo.jpg', 4032, 3024), size: screen, android: false), isNull);
    });

    test('shows the preview of a long remote image, whose preview is larger than the base', () {
      final region = getRegionSource(remote('long.png', _width, _height), size: screen, android: true)!;
      expect(region.url, contains('/assets/remote/thumbnail?size=preview'));
    });

    test('leaves a remote photo to its preview, which the base shows whole', () {
      expect(getRegionSource(remote('photo.jpg', 4032, 3024), size: screen, android: true), isNull);
    });
  });

  group('RegionImage', () {
    late _FakeRegionImageApi api;
    late RegionImage image;

    setUp(() {
      api = _FakeRegionImageApi();
      image = RegionImage(
        const RegionSource(localAssetId: 'local', basePixels: _basePixels),
        api: api,
      );
    });

    tearDown(() => image.dispose());

    // the long screenshot shown fit to its width, 360 logical pixels (3 physical pixels each), at its top
    const display = Size(360, 360.0 * _height / _width);
    const top = Rect.fromLTWH(0, 0, 360, 800);

    Future<void> open() async {
      image
        ..active = true
        ..show(display, top, 3);
      api.opens.single.complete({'id': 7, 'width': _width, 'height': _height});
      await pumpEventQueue();
    }

    test('opens only when on the screen and tiles are needed', () async {
      // the whole image on the screen: the base is enough
      image.show(const Size(43, 800), const Rect.fromLTWH(0, 0, 43, 800), 3);
      image.active = true;
      expect(api.opens, isEmpty);

      image.active = false;
      image.show(display, top, 3);
      expect(api.opens, isEmpty);

      image.active = true;
      expect(api.opens, hasLength(1));
    });

    test('decodes the tiles on the screen, at its scale, the middle first', () async {
      await open();

      // 1080 pixels of the image on 1080 of the screen: not made smaller, in tiles of 512 x 512 (narrower at the
      // right edge), four at a time
      expect(api.decodes, hasLength(4));
      for (final decode in api.decodes) {
        expect(decode.sample, 1);
        expect(decode.x % 512, 0);
        expect(decode.y % 512, 0);
        expect(decode.width, decode.x == 1024 ? 56 : 512);
        expect(decode.height, 512);
        // the screen is the top 2400 pixels of the image
        expect(decode.y, lessThan(2400));
      }
      // the middle of the screen first
      final first = api.decodes.first;
      expect((first.x, first.y), (512, 1024));
    });

    test('makes tiles smaller when the image is shown smaller', () async {
      await open();
      image.show(display / 4, const Rect.fromLTWH(0, 0, 90, 800), 3);
      // 1080 pixels on 270: 4 times smaller
      expect(api.decodes.last.sample, 4);
      expect(api.decodes.last.width, 1080);
    });

    test('cancels the tiles no longer on the screen', () async {
      await open();
      final before = api.decodes.map((d) => d.requestId).toList();

      image.show(display, top.shift(const Offset(0, 5000)), 3);

      expect(api.cancelled, before);
      expect(api.decodes.skip(before.length).map((d) => d.y), everyElement(greaterThanOrEqualTo(14848)));
    });

    testWidgets('keeps the tiles decoded and paints them', (tester) async {
      await tester.runAsync(() async {
        await open();
        var notified = 0;
        image.addListener(() => notified++);
        for (final decode in api.decodes.toList()) {
          decode.succeed();
        }
        // decoding them into images takes a few turns
        for (var i = 0; i < 20 && notified < 4; i++) {
          await Future<void>.delayed(const Duration(milliseconds: 10));
        }
        expect(notified, greaterThanOrEqualTo(4));

        // the middle of the screen is red now
        final recorder = ui.PictureRecorder();
        image.paint(Canvas(recorder), display);
        final picture = recorder.endRecording();
        final painted = await picture.toImage(360, 800);
        final pixels = (await painted.toByteData())!;
        expect(pixels.getUint32((400 * 360 + 180) * 4), 0xff0000ff);
        picture.dispose();
        painted.dispose();
      });
    });

    test('fails, to be decoded whole, when it cannot be opened', () async {
      var notified = false;
      image
        ..addListener(() => notified = true)
        ..active = true
        ..show(display, top, 3);
      api.opens.single.completeError(Exception('not a format that can be decoded in parts'));
      await pumpEventQueue();

      expect(image.failed, isTrue);
      expect(notified, isTrue);
    });

    test('fails when the file shows nothing more than the base', () async {
      image
        ..active = true
        ..show(display, top, 3);
      api.opens.single.complete({'id': 7, 'width': 221, 'height': 4096});
      await pumpEventQueue();

      expect(image.failed, isTrue);
      expect(api.decodes, isEmpty);
    });

    test('closes the image and cancels its decodes when disposed', () async {
      await open();
      final pending = api.decodes.map((d) => d.requestId).toList();

      image.dispose();
      image = RegionImage(
        const RegionSource(localAssetId: 'other', basePixels: _basePixels),
        api: api,
      );

      expect(api.closed, [7]);
      expect(api.cancelled, pending);
    });

    test('closes an image that opens after it was disposed', () async {
      image
        ..active = true
        ..show(display, top, 3);
      image.dispose();
      image = RegionImage(
        const RegionSource(localAssetId: 'other', basePixels: _basePixels),
        api: api,
      );

      api.opens.single.complete({'id': 9, 'width': _width, 'height': _height});
      await pumpEventQueue();

      expect(api.closed, [9]);
    });
  });
}
