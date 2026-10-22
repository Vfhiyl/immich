import 'dart:async';
import 'dart:io';

import 'package:drift/drift.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/data/db/main/database.dart';
import 'package:immich_mobile/domain/models/timeline.model.dart';
import 'package:immich_mobile/infrastructure/repositories/main_timeline.dart';

/// The main timeline with as many server photos as IMMICH_TIMELINE_SCALE says, taken over 20 years, and a fourth as
/// many photos on the phone (at most 100 000), in a database file: run by misc/check.sh with 400000. Many photos share
/// their time, ten users share everything, and the phone has 30 albums. Prints how long upstream's queries take, for
/// comparison.
void main() {
  final scale = int.tryParse(Platform.environment['IMMICH_TIMELINE_SCALE'] ?? '');
  final remoteCount = scale ?? 0;
  final localCount = remoteCount ~/ 4 < 100000 ? remoteCount ~/ 4 : 100000;
  final interval = remoteCount == 0 ? 0 : 20 * 365 * 86400 ~/ remoteCount;
  final users = [for (var i = 0; i < 10; i++) 'user-$i'];
  late Drift db;
  late Directory directory;

  setUpAll(() async {
    if (scale == null) {
      return;
    }
    directory = await Directory.systemTemp.createTemp('main-timeline-scale');
    db = Drift(DatabaseConnection(NativeDatabase(File('${directory.path}/immich.sqlite'))));
    await db.transaction(() async {
      for (final user in users) {
        await db.customStatement(
          "INSERT INTO user_entity (id, name, email, has_profile_image, profile_changed_at, avatar_color) "
          "VALUES ('$user', '$user', '$user@test.dev', 0, '2020-01-01T00:00:00.000Z', 0)",
        );
      }
      // evenly over 20 years, but 5 % of them in groups of 5 taken at the same time
      final time =
          "strftime('%Y-%m-%dT%H:%M:%S.000Z', 1700000000 - (CASE WHEN i % 100 < 5 THEN i - i % 5 ELSE i END) * $interval, 'unixepoch')";
      await db.customStatement('''
        WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < $remoteCount - 1)
        INSERT INTO remote_asset_entity (id, name, type, created_at, updated_at, checksum, owner_id, visibility,
          local_date_time, is_favorite, is_edited)
        SELECT printf('remote-%08d', i), 'IMG_' || i || '.jpg', 1, $time, $time, 'checksum-' || i, 'user-' || (i % 10),
          0, $time, 0, 0
        FROM n''');
      for (var i = 0; i < 30; i++) {
        await db.customStatement(
          'INSERT INTO local_album_entity (id, name, updated_at, backup_selection, is_ios_shared_album, marker) '
          "VALUES ('album-$i', 'Album $i', '2024-01-01T00:00:00.000Z', ${i == 0 ? 0 : 1}, 0, 0)",
        );
      }
      // half of the photos of the phone are on the server already
      await db.customStatement('''
        WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < $localCount - 1)
        INSERT INTO local_asset_entity (id, name, type, created_at, updated_at, checksum, is_favorite, orientation,
          playback_style)
        SELECT printf('local-%08d', i), 'LOCAL_' || i || '.jpg', 1,
          strftime('%Y-%m-%dT%H:%M:%S.000Z', 1700000000 - i * 300, 'unixepoch'), '2024-01-01T00:00:00.000Z',
          CASE WHEN i % 2 = 0 THEN 'checksum-' || i ELSE 'local-checksum-' || i END, 0, 0, 0
        FROM n''');
      await db.customStatement(
        "INSERT INTO local_album_asset_entity (asset_id, album_id, marker) SELECT id, 'album-0', 0 FROM local_asset_entity",
      );
    });
    await db.customStatement('ANALYZE');
  });

  tearDownAll(() async {
    if (scale == null) {
      return;
    }
    await db.close();
    await directory.delete(recursive: true);
  });

  /// The time of a run after a first one
  Future<int> time(String label, Future<Object?> Function() run) async {
    await run();
    final stopwatch = Stopwatch()..start();
    await run();
    // ignore: avoid_print
    print('$label: ${stopwatch.elapsedMilliseconds} ms');
    return stopwatch.elapsedMilliseconds;
  }

  test(
    'loads a page anywhere in milliseconds',
    skip: scale == null ? 'set IMMICH_TIMELINE_SCALE' : false,
    timeout: const Timeout(Duration(minutes: 10)),
    () async {
      final timeline = MainTimeline(db, users);
      final days = Completer<List<Bucket>>();
      final watching = timeline.watchBuckets(GroupAssetsBy.day).listen((buckets) {
        if (!days.isCompleted) {
          days.complete(buckets);
        }
      });
      final total = (await days.future).fold(0, (sum, bucket) => sum + bucket.assetCount);
      expect(total, remoteCount + localCount ~/ 2);

      // what each change costs: a timeline that does not watch its days reads them for each page (a watched stream of
      // the same query would answer from its cache)
      final days2 = await time('days, and one photo', () => MainTimeline(db, users).getAssets(offset: 0, count: 1));
      await time('  upstream days', () => db.mergedAssetDrift.mergedBucket(userIds: users, groupBy: 0).get());
      for (final offset in [0, total ~/ 2, total - 1024]) {
        final page = await time('page at $offset', () => timeline.getAssets(offset: offset, count: 1024));
        await time(
          '  upstream',
          () => db.mergedAssetDrift.mergedAsset(userIds: users, limit: (_) => Limit(1024, offset)).get(),
        );
        // upstream takes about a second here at 400 000 photos on a server CPU, more the further down
        expect(page, lessThan(100));
      }
      expect(days2, lessThan(3000));
      await watching.cancel();
    },
  );
}
