import 'dart:async';
import 'dart:ffi' show Uint8;

import 'package:ffi/ffi.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/settings_key.dart';
import 'package:immich_mobile/infrastructure/repositories/settings.repository.dart';
import 'package:immich_mobile/platform/region_image_api.g.dart';
import 'package:immich_mobile/platform/remote_image_api.g.dart';
import 'package:immich_mobile/presentation/widgets/images/remote_image_provider.dart';

import '../../../unit/presentation/presentation_context.dart';

// The platform's side of RegionImageApi.decodeWhole and RemoteImageApi.requestImage, recording what is asked
class _Platform {
  final wholes = <String>[];
  final requested = <String>[];
  bool wholeFails = false;

  void install(WidgetTester tester) {
    const region = 'dev.flutter.pigeon.immich_mobile.RegionImageApi';
    const remote = 'dev.flutter.pigeon.immich_mobile.RemoteImageApi';
    tester.binding.defaultBinaryMessenger
      ..setMockDecodedMessageHandler<Object?>(
        const BasicMessageChannel<Object?>('$region.decodeWhole', RegionImageApi.pigeonChannelCodec),
        (message) async {
          wholes.add((message! as List<Object?>).first! as String);
          return wholeFails ? const <Object?>['error', 'not a format that can be decoded in parts', null] : [_pixels()];
        },
      )
      ..setMockDecodedMessageHandler<Object?>(
        const BasicMessageChannel<Object?>('$region.cancel', RegionImageApi.pigeonChannelCodec),
        (_) async => const <Object?>[null],
      )
      ..setMockDecodedMessageHandler<Object?>(
        const BasicMessageChannel<Object?>('$remote.requestImage', RemoteImageApi.pigeonChannelCodec),
        (message) async {
          requested.add((message! as List<Object?>).first! as String);
          return [_pixels()];
        },
      )
      ..setMockDecodedMessageHandler<Object?>(
        const BasicMessageChannel<Object?>('$remote.cancelRequest', RemoteImageApi.pigeonChannelCodec),
        (_) async => const <Object?>[null],
      );
  }

  // 2 x 2 pixels, malloc'd as the platform does (the request frees them)
  static Map<String, int> _pixels() {
    final pointer = malloc.allocate<Uint8>(16);
    return {'pointer': pointer.address, 'width': 2, 'height': 2, 'rowBytes': 8};
  }
}

void main() {
  late PresentationContext context;

  setUp(() async => context = await PresentationContext.create());
  tearDown(() async => context.dispose());

  // a long screenshot, shown in tiles from its preview
  const provider = RemoteFullImageProvider(
    assetId: 'long',
    thumbhash: '',
    assetType: AssetType.image,
    isAnimated: false,
    tiledBaseSize: Size(221, 4096),
  );

  // until the second image (the thumbnail first, then the preview), all in real time (decoding is asynchronous)
  Future<void> load(WidgetTester tester) async {
    await tester.runAsync(() async {
      final done = Completer<void>();
      final stream = provider.resolve(ImageConfiguration.empty);
      var frames = 0;
      final listener = ImageStreamListener((_, _) {
        if (++frames == 2 && !done.isCompleted) {
          done.complete();
        }
      });
      stream.addListener(listener);
      await done.future.timeout(const Duration(seconds: 5), onTimeout: () {});
      stream.removeListener(listener);
    });
    PaintingBinding.instance.imageCache.clear();
  }

  testWidgets('the base of an image in tiles comes from the download of its tiles', (tester) async {
    final platform = _Platform()..install(tester);

    await load(tester);

    expect(platform.wholes, [contains('/assets/long/thumbnail?size=preview')]);
    expect(platform.requested, [contains('size=thumbnail')]);
  });

  testWidgets('it is downloaded as before when the app cannot decode it', (tester) async {
    final platform = _Platform()
      ..wholeFails = true
      ..install(tester);

    await load(tester);

    expect(platform.wholes, hasLength(1));
    expect(platform.requested, [contains('size=thumbnail'), contains('/assets/long/thumbnail?size=preview')]);
  });

  testWidgets('with originals loaded, the tiles come from the original: the preview is downloaded as before', (
    tester,
  ) async {
    final platform = _Platform()..install(tester);
    await tester.runAsync(() => SettingsRepository.instance.write(SettingsKey.imageLoadOriginal, true));

    await load(tester);

    expect(platform.wholes, isEmpty);
    expect(platform.requested, [contains('size=thumbnail'), contains('/assets/long/thumbnail?size=preview')]);
  });
}
