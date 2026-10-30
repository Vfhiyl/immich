import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/widgets/asset_viewer/asset_stack.provider.dart';
import 'package:immich_mobile/presentation/widgets/images/image_provider.dart';
import 'package:immich_mobile/providers/asset_viewer/asset_viewer.provider.dart';
import 'package:immich_mobile/providers/infrastructure/asset_viewer/asset.provider.dart';
import 'package:immich_mobile/providers/infrastructure/settings.provider.dart';
import 'package:immich_mobile/utils/bytes_units.dart';

/// "View original (12.3 MB)" under a remote photo shown from its preview, "Play original" under a remote video played
/// transcoded: shows that asset from its original until the viewer closes, whatever the settings (which do it for all).
/// A photo's original is shown in tiles (only the part on the screen is decoded).
class ViewOriginalButton extends ConsumerWidget {
  final BaseAsset asset;

  const ViewOriginalButton({super.key, required this.asset});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // the asset shown: the one of the stack chosen
    final stackIndex = ref.watch(assetViewerProvider.select((s) => s.stackIndex));
    final stack = ref.watch(stackChildrenNotifier(asset)).valueOrNull;
    final shown = stack != null && stack.isNotEmpty ? stack[stackIndex.clamp(0, stack.length - 1)] : asset;

    final id = remoteIdOf(shown);
    final originals = ref.watch(assetViewerProvider.select((s) => s.originals));
    final loadOriginalVideo = ref.watch(appConfigProvider.select((c) => c.viewer.loadOriginalVideo));
    final available =
        id != null &&
        !originals.contains(id) &&
        (canViewOriginal(shown) || canPlayOriginal(shown, loadOriginalVideo: loadOriginalVideo));
    final fileSize = available ? ref.watch(assetExifProvider(shown)).valueOrNull?.fileSize : null;
    final size = fileSize == null ? null : formatBytes(fileSize);
    final label = shown.isVideo
        ? (size == null ? context.t.play_original_video : context.t.play_original_video_size(size: size))
        : (size == null ? context.t.view_original : context.t.view_original_size(size: size));

    return AnimatedSwitcher(
      duration: Durations.short4,
      child: !available
          ? const SizedBox.shrink()
          : Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Material(
                color: Colors.black.withValues(alpha: 0.4),
                shape: const StadiumBorder(side: BorderSide(color: Colors.white54)),
                clipBehavior: Clip.antiAlias,
                child: InkWell(
                  key: const Key('view_original'),
                  onTap: () => ref.read(assetViewerProvider.notifier).showOriginal(id),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
                    child: Text(label, style: const TextStyle(color: Colors.white, fontSize: 13)),
                  ),
                ),
              ),
            ),
    );
  }
}
