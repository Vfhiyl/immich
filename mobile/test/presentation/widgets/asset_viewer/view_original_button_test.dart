import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/config/app_config.dart';
import 'package:immich_mobile/domain/models/exif.model.dart';
import 'package:immich_mobile/domain/models/settings_key.dart';
import 'package:immich_mobile/presentation/widgets/asset_viewer/view_original_button.widget.dart';
import 'package:immich_mobile/presentation/widgets/images/image_provider.dart';
import 'package:immich_mobile/providers/asset_viewer/asset_viewer.provider.dart';
import 'package:immich_mobile/providers/infrastructure/asset_viewer/asset.provider.dart';
import 'package:immich_mobile/providers/infrastructure/settings.provider.dart';

import '../../../unit/factories/remote_asset_factory.dart';
import '../../../unit/presentation/presentation_context.dart';
import '../../../widget_tester_extensions.dart';

void main() {
  testWidgets('a remote video played transcoded can be played from its original, with its size', (tester) async {
    final video = RemoteAssetFactory.create(type: AssetType.video);
    late WidgetRef ref;

    await tester.pumpConsumerWidget(
      Consumer(
        builder: (context, widgetRef, _) {
          ref = widgetRef;
          return ViewOriginalButton(asset: video);
        },
      ),
      overrides: [
        appConfigProvider.overrideWithValue(const AppConfig()),
        assetExifProvider.overrideWith((ref, asset) => Stream.value(const ExifInfo(fileSize: 52428800))),
      ],
    );
    await tester.pumpAndSettle();

    expect(find.text('Play original (50.0 MiB)'), findsOneWidget);

    await tester.tap(find.byKey(const Key('view_original')));
    await tester.pumpAndSettle();

    expect(ref.read(assetViewerProvider).originals, {video.id});
    // asked once: gone
    expect(find.byKey(const Key('view_original')), findsNothing);

    // while its original is downloaded
    ref.read(assetViewerProvider.notifier).setLoadingOriginal(video.id, true);
    await tester.pump(const Duration(milliseconds: 500));
    expect(find.text('Loading original…'), findsOneWidget);
    ref.read(assetViewerProvider.notifier).setLoadingOriginal(video.id, false);
    await tester.pump(const Duration(milliseconds: 500));
    await tester.pump(const Duration(milliseconds: 500));
    expect(find.byKey(const Key('loading_original')), findsNothing);
  });

  group('a remote photo', () {
    late PresentationContext context;

    setUp(() async {
      context = await PresentationContext.create();
      debugRegionAndroid = true;
    });
    tearDown(() async {
      debugRegionAndroid = null;
      await context.dispose();
    });

    // 8064 x 6048, larger than its preview
    final photo = RemoteAssetFactory.create().copyWith(width: 8064, height: 6048);

    Future<WidgetRef> pump(WidgetTester tester, int fileSize) async {
      late WidgetRef ref;
      await tester.pumpConsumerWidget(
        Consumer(
          builder: (context, widgetRef, _) {
            ref = widgetRef;
            return ViewOriginalButton(asset: photo);
          },
        ),
        overrides: [
          appConfigProvider.overrideWithValue(const AppConfig()),
          assetExifProvider.overrideWith((ref, asset) => Stream.value(ExifInfo(fileSize: fileSize))),
        ],
      );
      await tester.pumpAndSettle();
      return ref;
    }

    testWidgets('is shown from its original on asking', (tester) async {
      final ref = await pump(tester, 20 * 1000 * 1000);

      await tester.tap(find.text('View original (19.1 MiB)'));
      await tester.pumpAndSettle();

      expect(ref.read(assetViewerProvider).originals, {photo.id});
    });

    testWidgets('larger than the viewer downloads stays shown from its preview, and says why', (tester) async {
      final ref = await pump(tester, maxOriginalBytes + 1);

      await tester.tap(find.byKey(const Key('view_original')));
      await tester.pump(const Duration(milliseconds: 500));

      expect(ref.read(assetViewerProvider).originals, isEmpty);
      expect(find.textContaining('too large to view here'), findsOneWidget);
      await tester.pumpAndSettle(const Duration(seconds: 5));
    });
  });

  testWidgets('not when originals are played anyway', (tester) async {
    final video = RemoteAssetFactory.create(type: AssetType.video);

    await tester.pumpConsumerWidget(
      ViewOriginalButton(asset: video),
      overrides: [
        appConfigProvider.overrideWithValue(const AppConfig().write(SettingsKey.viewerLoadOriginalVideo, true)),
        assetExifProvider.overrideWith((ref, asset) => Stream.value(const ExifInfo(fileSize: 1))),
      ],
    );
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('view_original')), findsNothing);
  });
}
