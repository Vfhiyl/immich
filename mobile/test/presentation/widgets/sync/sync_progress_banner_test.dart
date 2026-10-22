import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/constants/locales.dart';
import 'package:immich_mobile/generated/codegen_loader.g.dart';
import 'package:immich_mobile/presentation/widgets/sync/sync_progress_banner.widget.dart';
import 'package:immich_mobile/providers/sync_status.provider.dart';

void main() {
  test('shows while a sync brings many photos', () {
    const syncing = SyncStatusState(remoteSyncStatus: SyncStatus.syncing);
    expect(SyncProgressBanner.isShown(syncing.copyWith(remoteSyncedAssets: 499)), isFalse);
    expect(SyncProgressBanner.isShown(syncing.copyWith(remoteSyncedAssets: 500)), isTrue);
    expect(
      SyncProgressBanner.isShown(const SyncStatusState(remoteSyncStatus: SyncStatus.success, remoteSyncedAssets: 9000)),
      isFalse,
    );
  });

  test('counts from zero with every sync', () {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    final notifier = container.read(syncStatusProvider.notifier);

    notifier.startRemoteSync();
    notifier.setRemoteSyncProgress(1200);
    expect(container.read(syncStatusProvider).remoteSyncedAssets, 1200);
    notifier.completeRemoteSync();
    notifier.startRemoteSync();

    expect(container.read(syncStatusProvider).remoteSyncedAssets, 0);
  });

  testWidgets('tells how many photos and videos arrived so far', (tester) async {
    await tester.pumpWidget(
      EasyLocalization(
        supportedLocales: locales.values.toList(),
        path: translationsPath,
        startLocale: locales.values.first,
        fallbackLocale: locales.values.first,
        saveLocale: false,
        useFallbackTranslations: true,
        assetLoader: const CodegenLoader(),
        child: ProviderScope(
          overrides: [syncStatusProvider.overrideWith(_SyncingNotifier.new)],
          child: Builder(
            builder: (context) => MaterialApp(
              localizationsDelegates: context.localizationDelegates,
              supportedLocales: context.supportedLocales,
              locale: context.locale,
              home: const Scaffold(body: SyncProgressBanner()),
            ),
          ),
        ),
      ),
    );
    // the spinner never settles: wait for the translations, which load outside of the fake time of the test
    for (var attempt = 0; attempt < 50 && find.byType(SyncProgressBanner).evaluate().isEmpty; attempt++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
      await tester.pump();
    }

    expect(find.textContaining('1,234 photos and videos'), findsOneWidget);
  });
}

class _SyncingNotifier extends SyncStatusNotifier {
  @override
  SyncStatusState build() => const SyncStatusState(remoteSyncStatus: SyncStatus.syncing, remoteSyncedAssets: 1234);
}
