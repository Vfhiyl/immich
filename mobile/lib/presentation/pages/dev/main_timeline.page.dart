import 'package:auto_route/auto_route.dart';
import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/presentation/widgets/feature_message/feature_message_dialog.widget.dart';
import 'package:immich_mobile/presentation/widgets/memory/memory_lane.widget.dart';
import 'package:immich_mobile/presentation/widgets/sync/sync_progress_banner.widget.dart';
import 'package:immich_mobile/presentation/widgets/timeline/timeline.widget.dart';
import 'package:immich_mobile/providers/feature_message.provider.dart';
import 'package:immich_mobile/providers/infrastructure/memory.provider.dart';
import 'package:immich_mobile/providers/sync_status.provider.dart';

@RoutePage()
class MainTimelinePage extends ConsumerStatefulWidget {
  const MainTimelinePage({super.key});

  @override
  ConsumerState<MainTimelinePage> createState() => _MainTimelinePageState();
}

class _MainTimelinePageState extends ConsumerState<MainTimelinePage> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!mounted) {
        return;
      }
      final service = ref.read(featureMessageServiceProvider);
      if (!service.shouldShow()) {
        return;
      }

      await service.markSeen();
      if (!mounted) {
        return;
      }

      await showFeatureMessageDialog(context);
    });
  }

  @override
  Widget build(BuildContext context) {
    final hasMemories = ref.watch(memoryLaneProvider.select((state) => state.value?.isNotEmpty ?? false));
    final isSyncing = ref.watch(syncStatusProvider.select(SyncProgressBanner.isShown));
    return Timeline(
      topSliverWidget: SliverToBoxAdapter(
        child: Column(children: [if (isSyncing) const SyncProgressBanner(), const MemoryLane()]),
      ),
      topSliverWidgetHeight: (hasMemories ? 200 : 0) + (isSyncing ? SyncProgressBanner.height : 0),
      showStorageIndicator: true,
    );
  }
}
