import 'dart:async';
import 'dart:math';

import 'package:drift/drift.dart' hide isNull;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/data/db/main/database.dart';
import 'package:immich_mobile/data/db/main/table/local/album.drift.dart';
import 'package:immich_mobile/data/db/main/table/local/album_asset.drift.dart';
import 'package:immich_mobile/data/db/main/table/local/asset.drift.dart';
import 'package:immich_mobile/data/db/main/table/user/user.drift.dart';
import 'package:immich_mobile/data/db/main/timeline_index.dart';
import 'package:immich_mobile/domain/models/album/local_album.model.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/timeline.model.dart';
import 'package:immich_mobile/infrastructure/repositories/main_timeline.dart';
import 'package:immich_mobile/infrastructure/repositories/sync_stream.repository.dart';
import 'package:openapi/api.dart' as api;

void main() {
  late Drift db;
  late SyncStreamRepository sync;
  late Random random;
  const users = ['user-0', 'user-1', 'user-2', 'user-3'];
  // user-3 is not in the timeline (a partner not shown in it)
  const timelineUsers = ['user-0', 'user-1', 'user-2'];

  // few distinct times, so that many photos share one, some close to midnight in UTC
  final times = [
    for (var day = 0; day < 6; day++)
      for (final minute in [0, 1, 30, 23 * 60 + 59]) DateTime.utc(2024, 3, 9 + day).add(Duration(minutes: minute)),
  ];
  String id(String prefix, int i) => '$prefix-${i.toString().padLeft(4, '0')}';

  api.SyncAssetV1 remoteAsset(int i, {String? checksum, String? ownerId}) {
    final createdAt = times[random.nextInt(times.length)];
    return api.SyncAssetV1(
      checksum: checksum ?? 'checksum-$i',
      createdAt: createdAt,
      deletedAt: random.nextInt(10) == 0 ? createdAt : null,
      duration: null,
      fileCreatedAt: createdAt,
      fileModifiedAt: createdAt,
      height: 100,
      id: id('remote', i),
      isEdited: false,
      isFavorite: false,
      libraryId: null,
      livePhotoVideoId: null,
      // as the server sends it: the time where the photo was taken, as if in UTC; sometimes none
      localDateTime: random.nextInt(6) == 0 ? null : createdAt.add(Duration(hours: random.nextInt(27) - 13)),
      originalFileName: 'IMG_$i.jpg',
      ownerId: ownerId ?? users[random.nextInt(users.length)],
      stackId: random.nextInt(5) == 0 ? 'stack-${random.nextInt(8)}' : null,
      thumbhash: null,
      type: api.AssetTypeEnum.IMAGE,
      visibility: random.nextInt(6) == 0 ? api.AssetVisibility.archive : api.AssetVisibility.timeline,
      width: 100,
    );
  }

  Future<void> seed({int remote = 300, int local = 120}) async {
    for (final user in users) {
      await db.into(db.userEntity).insert(UserEntityCompanion.insert(id: user, email: '$user@test.dev', name: user));
    }
    await sync.updateAssetsV1([for (var i = 0; i < remote; i++) remoteAsset(i)]);
    // stacks 0-5 exist (6 and 7 are referenced but unknown); the primary photo of some is not in the stack
    await sync.updateStacksV1([
      for (var s = 0; s < 6; s++)
        api.SyncStackV1(
          createdAt: times.first,
          id: 'stack-$s',
          ownerId: users[s % users.length],
          primaryAssetId: id('remote', random.nextInt(remote)),
          updatedAt: times.first,
        ),
    ]);
    for (final (album, selection) in [
      ('selected', BackupSelection.selected),
      ('none', BackupSelection.none),
      ('excluded', BackupSelection.excluded),
    ]) {
      await db
          .into(db.localAlbumEntity)
          .insert(LocalAlbumEntityCompanion.insert(id: album, name: album, backupSelection: selection));
    }
    for (var i = 0; i < local; i++) {
      // some are on the server already, of a user in the timeline or not
      final checksum = random.nextInt(3) == 0 ? 'checksum-${random.nextInt(remote)}' : 'local-checksum-$i';
      await db
          .into(db.localAssetEntity)
          .insert(
            LocalAssetEntityCompanion.insert(
              id: id('local', i),
              name: 'LOCAL_$i.jpg',
              type: AssetType.image,
              checksum: Value(checksum),
              createdAt: Value(times[random.nextInt(times.length)]),
            ),
          );
      for (final album in ['selected', 'none', 'excluded']) {
        if (random.nextInt(3) == 0) {
          await db
              .into(db.localAlbumAssetEntity)
              .insert(LocalAlbumAssetEntityCompanion.insert(assetId: id('local', i), albumId: album));
        }
      }
    }
  }

  /// Upstream's timeline in the order of [MainTimeline]: newest first, then by id (descending), server photos first
  Future<List<String>> upstreamAssets() async {
    final rows = await db.mergedAssetDrift.mergedAsset(userIds: timelineUsers, limit: (_) => Limit(1000000, 0)).get();
    final keyed = [
      for (final row in rows)
        (createdAt: row.createdAt, id: row.remoteId ?? row.localId!, source: row.remoteId != null ? 0 : 1),
    ];
    keyed.sort((a, b) {
      final byTime = b.createdAt.compareTo(a.createdAt);
      if (byTime != 0) {
        return byTime;
      }
      final byId = b.id.compareTo(a.id);
      return byId != 0 ? byId : a.source.compareTo(b.source);
    });
    return [for (final key in keyed) key.id];
  }

  Future<List<(DateTime, int)>> upstreamBuckets(GroupAssetsBy groupBy) async {
    final rows = await db.mergedAssetDrift.mergedBucket(userIds: timelineUsers, groupBy: groupBy.index).get();
    return [
      for (final row in rows)
        (
          DateTime(
            int.parse(row.bucketDate.substring(0, 4)),
            int.parse(row.bucketDate.substring(5, 7)),
            groupBy == GroupAssetsBy.month ? 1 : int.parse(row.bucketDate.substring(8, 10)),
          ),
          row.assetCount,
        ),
    ];
  }

  Future<List<(DateTime, int)>> buckets(MainTimeline timeline, GroupAssetsBy groupBy) async {
    final buckets = await timeline.watchBuckets(groupBy).first;
    return [for (final bucket in buckets.cast<TimeBucket>()) (bucket.date, bucket.assetCount)];
  }

  /// The whole timeline, in pages of random sizes, as the app loads it (while it watches the buckets)
  Future<List<String>> pagedAssets(MainTimeline timeline) async {
    final watching = Completer<List<Bucket>>();
    final subscription = timeline.watchBuckets(GroupAssetsBy.day).listen((buckets) {
      if (!watching.isCompleted) {
        watching.complete(buckets);
      }
    });
    final total = (await watching.future).fold(0, (sum, bucket) => sum + bucket.assetCount);
    final ids = <String>[];
    while (ids.length < total) {
      final page = await timeline.getAssets(offset: ids.length, count: 1 + random.nextInt(40));
      expect(page, isNotEmpty);
      ids.addAll(page.map((asset) => asset is RemoteAsset ? asset.id : (asset as LocalAsset).id));
    }
    expect(await timeline.getAssets(offset: total, count: 10), isEmpty);
    await subscription.cancel();
    return ids;
  }

  Future<void> expectCountsAreRight() async {
    final counted = await db
        .customSelect(
          'SELECT owner_id, local_day, utc_day, asset_count FROM ${TimelineIndex.countTable} ORDER BY 1, 2, 3',
        )
        .get();
    final actual = await db
        .customSelect(
          "SELECT owner_id, COALESCE(strftime('%Y-%m-%d', local_date_time), '') AS local_day, "
          'substr(created_at, 1, 10) AS utc_day, COUNT(*) AS asset_count FROM remote_asset_entity '
          'WHERE deleted_at IS NULL AND visibility = 0 GROUP BY 1, 2, 3 ORDER BY 1, 2, 3',
        )
        .get();
    expect(counted.map((row) => row.data).toList(), actual.map((row) => row.data).toList());
  }

  Future<void> expectSameAsUpstream() async {
    final timeline = MainTimeline(db, timelineUsers);
    expect(await buckets(timeline, GroupAssetsBy.day), await upstreamBuckets(GroupAssetsBy.day));
    expect(await buckets(timeline, GroupAssetsBy.month), await upstreamBuckets(GroupAssetsBy.month));
    expect(await pagedAssets(timeline), await upstreamAssets());
  }

  setUp(() {
    db = Drift(DatabaseConnection(NativeDatabase.memory(), closeStreamsSynchronously: true));
    sync = SyncStreamRepository(db);
  });

  tearDown(() async {
    await db.close();
  });

  for (final seedValue in [1, 2, 3]) {
    test(
      'shows the same photos in the same days as upstream, page by page without gaps or repeats ($seedValue)',
      () async {
        random = Random(seedValue);
        await seed();

        await expectCountsAreRight();
        await expectSameAsUpstream();
      },
    );
  }

  test('keeps counting right while the server sends changes', () async {
    random = Random(4);
    await seed();

    for (var round = 0; round < 5; round++) {
      // changed photos (moved in time, trashed, archived, given to another user), and new ones
      await sync.updateAssetsV1([for (var i = 0; i < 40; i++) remoteAsset(random.nextInt(400))]);
      // a photo sent again under a new id: the row with the same owner and checksum is replaced
      final replaced = (await db.remoteAssetEntity.select().get())[random.nextInt(100)];
      await sync.updateAssetsV1([remoteAsset(1000 + round, checksum: replaced.checksum, ownerId: replaced.ownerId)]);
      await sync.deleteAssetsV1([
        for (var i = 0; i < 10; i++) api.SyncAssetDeleteV1(assetId: id('remote', random.nextInt(400))),
      ]);
      await sync.updateStacksV1([
        api.SyncStackV1(
          createdAt: times.first,
          id: 'stack-${random.nextInt(8)}',
          ownerId: users.first,
          primaryAssetId: id('remote', random.nextInt(400)),
          updatedAt: times.first,
        ),
      ]);
      await sync.deleteStacksV1([api.SyncStackDeleteV1(stackId: 'stack-${random.nextInt(8)}')]);

      await expectCountsAreRight();
      await expectSameAsUpstream();
    }
  });

  test('counts anew what a migration dropped, or what was counted wrong', () async {
    random = Random(5);
    await seed();

    // a migration rebuilding the table drops its triggers
    await db.customStatement('DROP TRIGGER ext_timeline_count_insert_v1');
    await sync.updateAssetsV1([for (var i = 300; i < 320; i++) remoteAsset(i)]);
    await TimelineIndex.ensure(db);
    await expectCountsAreRight();

    await db.customStatement('UPDATE ${TimelineIndex.countTable} SET asset_count = asset_count + 1');
    await TimelineIndex.ensure(db);
    await expectCountsAreRight();
    await expectSameAsUpstream();
  });

  test('reads a page from the indexes in the order of the timeline, without sorting', () async {
    final recorder = _SelectRecorder();
    await db.close();
    db = Drift(DatabaseConnection(NativeDatabase.memory().interceptWith(recorder), closeStreamsSynchronously: true));
    sync = SyncStreamRepository(db);
    random = Random(7);
    await seed(remote: 50, local: 20);

    recorder.selects.clear();
    await MainTimeline(db, timelineUsers).getAssets(offset: 10, count: 5);
    final (sql, args) = recorder.selects.singleWhere((select) => select.$1.contains('AS sort_id'));
    final plan = await db
        .customSelect('EXPLAIN QUERY PLAN $sql', variables: [for (final arg in args) Variable(arg)])
        .get();

    final details = plan.map((row) => row.read<String>('detail')).toList();
    expect(details, contains(startsWith('SEARCH rae USING INDEX ext_idx_remote_asset_timeline (created_at<?)')));
    expect(details, contains(startsWith('SEARCH lae USING INDEX ext_idx_local_asset_timeline (created_at<?)')));
    // only photos taken at the same time with the same id (a server photo and one of the phone) are put in order
    expect(
      details.where((detail) => detail.contains('TEMP B-TREE')),
      everyElement('USE TEMP B-TREE FOR LAST TERM OF ORDER BY'),
    );
  });

  test('stops watching when the timeline is closed', () async {
    random = Random(6);
    await seed();
    final timeline = MainTimeline(db, timelineUsers);
    final subscription = timeline.watchBuckets(GroupAssetsBy.day).listen((_) {});
    await pumpEventQueue();

    await subscription.cancel().timeout(const Duration(seconds: 5));

    // reads the days itself again
    expect((await timeline.getAssets(offset: 0, count: 5)).length, 5);
  });
}

class _SelectRecorder extends QueryInterceptor {
  final selects = <(String, List<Object?>)>[];

  @override
  Future<List<Map<String, Object?>>> runSelect(QueryExecutor executor, String statement, List<Object?> args) {
    selects.add((statement, args));
    return executor.runSelect(statement, args);
  }
}
