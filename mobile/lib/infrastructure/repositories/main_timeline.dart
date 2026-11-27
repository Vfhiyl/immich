import 'dart:async';

import 'package:drift/drift.dart';
import 'package:flutter/foundation.dart';
import 'package:immich_mobile/data/db/main/database.dart';
import 'package:immich_mobile/data/db/main/query/merged_asset.drift.dart';
import 'package:immich_mobile/data/db/main/timeline_index.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/timeline.model.dart';

/// The main timeline (the server photos of the user and the partners shown with them, and the photos of this phone
/// not on the server yet), fast at any size: the days come from the counts of [TimelineIndex] instead of counting
/// every photo, and a page starts at the day it is in instead of skipping every photo before it. The same photos in
/// the same order as upstream's `mergedBucket` and `mergedAsset` (by the day the headers group on, `group_date`, then
/// by time), but in a total order (photos taken at the same time do not change places between pages).
class MainTimeline {
  final Drift _db;
  final List<String> _userIds;

  /// The days of the timeline, newest first, while [watchBuckets] is listened to: a page starts at the day it is in.
  /// The timeline loads its pages again after each change of the buckets
  List<({String day, int count})>? _days;

  MainTimeline(this._db, this._userIds);

  Set<ResultSetImplementation> get _tables => {
    _db.remoteAssetEntity,
    _db.stackEntity,
    _db.localAssetEntity,
    _db.localAlbumAssetEntity,
    _db.localAlbumEntity,
  };

  /// Server photos the counts count that the timeline shows as their stack instead: few, looked up by their stack
  static const _hiddenInStack = '''
rae.stack_id IS NOT NULL AND rae.deleted_at IS NULL AND rae.visibility = 0 AND rae.owner_id IN (SELECT id FROM users)
AND NOT EXISTS (SELECT 1 FROM stack_entity se WHERE se.id = rae.stack_id AND se.primary_asset_id = rae.id)''';

  /// Photos of this phone the timeline shows: in a backed up album and not on the server (as upstream's, with the
  /// photos of the albums looked up once instead of every album for every photo)
  static const _localOnly = '''
NOT EXISTS (
  SELECT 1 FROM remote_asset_entity rae WHERE rae.checksum = lae.checksum AND rae.owner_id IN (SELECT id FROM users)
)
AND lae.id IN (
  SELECT laa.asset_id FROM local_album_asset_entity laa INNER JOIN local_album_entity la ON laa.album_id = la.id
  WHERE la.backup_selection = 0
)
AND lae.id NOT IN (
  SELECT laa.asset_id FROM local_album_asset_entity laa INNER JOIN local_album_entity la ON laa.album_id = la.id
  WHERE la.backup_selection = 2
)''';

  /// The photos of the timeline per day (`group_date`, as upstream's `mergedBucket`: the local date of a server photo,
  /// the day on this phone otherwise; photos without one are not shown)
  static const _daysSql =
      '''
SELECT day, SUM(n) AS n FROM (
  SELECT group_date AS day, SUM(asset_count) AS n FROM ${TimelineIndex.countTable}
  WHERE owner_id IN (SELECT id FROM users)
  GROUP BY 1
  UNION ALL
  SELECT rae.group_date, -COUNT(*)
  FROM remote_asset_entity rae INDEXED BY idx_remote_asset_stack_id WHERE $_hiddenInStack AND rae.group_date IS NOT NULL
  GROUP BY 1
  UNION ALL
  SELECT lae.group_date, COUNT(*) FROM local_asset_entity lae WHERE $_localOnly AND lae.group_date IS NOT NULL
  GROUP BY 1
)
GROUP BY 1''';

  @visibleForTesting
  static String get daysSqlForTest => _daysSql;

  Selectable<({String day, int count})> _selectDays() => _db
      .customSelect(
        // (no users, e.g. while signing in: no rows, as `VALUES` takes none)
        'WITH users(id) AS (${_userIds.isEmpty ? 'SELECT NULL WHERE 0' : 'VALUES ${List.filled(_userIds.length, '(?)').join(', ')}'}) '
        '$_daysSql',
        variables: [for (final id in _userIds) Variable.withString(id)],
        readsFrom: _tables,
      )
      .map((row) => (day: row.read<String>('day'), count: row.read<int>('n')));

  /// The days (or months) of the timeline, newest first, with their number of photos
  Stream<List<Bucket>> watchBuckets(GroupAssetsBy groupBy) {
    StreamSubscription<void>? days;
    final buckets = StreamController<List<Bucket>>();
    buckets.onListen = () {
      days = _selectDays().watch().listen(
        (days) {
          _days = _sum(days, (day) => day.day);
          buckets.add([
            for (final bucket in _sum(
              days,
              (day) => groupBy == GroupAssetsBy.month ? day.day.substring(0, 7) : day.day,
            ))
              TimeBucket(date: _parseDate(bucket.day), assetCount: bucket.count),
          ]);
        },
        onError: buckets.addError,
        onDone: buckets.close,
      );
    };
    buckets.onPause = () => days?.pause();
    buckets.onResume = () => days?.resume();
    buckets.onCancel = () async {
      _days = null;
      await days?.cancel();
      await buckets.close();
    };
    return buckets.stream;
  }

  /// The number of photos per key, newest first, without days that have none
  static List<({String day, int count})> _sum(
    List<({String day, int count})> days,
    String Function(({String day, int count})) key,
  ) {
    final counts = <String, int>{};
    for (final day in days) {
      counts.update(key(day), (count) => count + day.count, ifAbsent: () => day.count);
    }
    return [
      for (final MapEntry(key: day, value: count) in counts.entries)
        if (count > 0) (day: day, count: count),
    ]..sort((a, b) => b.day.compareTo(a.day));
  }

  /// A local date of the form YYYY-MM-DD or YYYY-MM
  static DateTime _parseDate(String date) {
    final parts = date.split('-').map(int.parse).toList();
    return DateTime(parts[0], parts[1], parts.length > 2 ? parts[2] : 1);
  }

  /// [count] photos of the timeline from [offset] on
  Future<List<BaseAsset>> getAssets({required int offset, required int count}) async {
    final days = _days ?? _sum(await _selectDays().get(), (day) => day.day);
    var newer = 0;
    for (final day in days) {
      if (offset < newer + day.count) {
        // the photos of that day and before
        final rows = await _db.mergedAssetDrift
            .mergedAssetPage(userIds: _userIds, day: day.day, count: count, skip: offset - newer)
            .get();
        return rows.map(_toAsset).toList();
      }
      newer += day.count;
    }
    return const [];
  }

  static BaseAsset _toAsset(MergedAssetPageResult row) => row.remoteId != null && row.ownerId != null
      ? RemoteAsset(
          id: row.remoteId!,
          localId: row.localId,
          name: row.name,
          ownerId: row.ownerId!,
          checksum: row.checksum,
          type: row.type,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          uploadedAt: row.uploadedAt,
          thumbHash: row.thumbHash,
          width: row.width,
          height: row.height,
          isFavorite: row.isFavorite,
          durationMs: row.durationMs,
          livePhotoVideoId: row.livePhotoVideoId,
          stackId: row.stackId,
          isEdited: row.isEdited,
        )
      : LocalAsset(
          id: row.localId!,
          remoteId: row.remoteId,
          name: row.name,
          checksum: row.checksum,
          type: row.type,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          width: row.width,
          height: row.height,
          isFavorite: row.isFavorite,
          durationMs: row.durationMs,
          orientation: row.orientation,
          playbackStyle: AssetPlaybackStyle.values[row.playbackStyle],
          cloudId: row.iCloudId,
          latitude: row.latitude,
          longitude: row.longitude,
          adjustmentTime: row.adjustmentTime,
          isEdited: row.isEdited,
        );
}
