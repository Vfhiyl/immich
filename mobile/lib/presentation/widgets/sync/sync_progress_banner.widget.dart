import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/providers/sync_status.provider.dart';

/// Tells that the library is still being synced, while a sync brings many photos (on the first sync, or after a long
/// time without one), so that a timeline that is not complete yet is not taken for the whole library
class SyncProgressBanner extends ConsumerWidget {
  /// A sync of fewer photos and videos is over too soon to be worth telling
  static const minimumAssets = 500;
  static const height = 56.0;

  const SyncProgressBanner({super.key});

  static bool isShown(SyncStatusState state) => state.isRemoteSyncing && state.remoteSyncedAssets >= minimumAssets;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final count = ref.watch(syncStatusProvider.select((state) => state.remoteSyncedAssets));
    return SizedBox(
      height: height,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        child: Row(
          children: [
            const SizedBox.square(dimension: 16, child: CircularProgressIndicator(strokeWidth: 2)),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                context.t.sync_progress_first_sync(count: count),
                style: context.textTheme.bodySmall,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
