import 'package:drift/drift.dart';

/// What keeps the main timeline fast at any size: indexes in the order of the timeline, and the number of server
/// photos per user and day (`group_date`), kept up to date by triggers.
///
/// Created when the database opens, outside drift's migrated schema: upstream numbers its schema versions in
/// sequence, so a version of ours would collide with upstream's next one. Everything here is named `ext_…`, so as not
/// to collide with upstream's names, and is recreated (and counted anew) when a migration dropped it, e.g. by
/// rebuilding a table.
abstract final class TimelineIndex {
  static const countTable = 'ext_timeline_group_count';

  /// What earlier versions created: dropped
  static const _dropped = [
    'DROP TABLE IF EXISTS ext_timeline_day_count',
    'DROP INDEX IF EXISTS ext_idx_remote_asset_timeline',
    'DROP INDEX IF EXISTS ext_idx_local_asset_timeline',
    'DROP INDEX IF EXISTS ext_idx_remote_asset_timeline_no_local_date',
  ];

  /// Server photos that the main timeline shows, before their stacks are taken into account: those of a day, as
  /// upstream's (`group_date`, the local day the headers group on)
  static const _counted = "deleted_at IS NULL AND visibility = 0 AND group_date IS NOT NULL";

  static const _indexes = [
    'CREATE INDEX IF NOT EXISTS ext_idx_remote_asset_group_timeline ON remote_asset_entity (group_date, created_at, id) WHERE $_counted',
    'CREATE INDEX IF NOT EXISTS ext_idx_local_asset_group_timeline ON local_asset_entity (group_date, created_at, id) WHERE group_date IS NOT NULL',
  ];

  static const _table =
      '''
CREATE TABLE IF NOT EXISTS $countTable (
  owner_id TEXT NOT NULL,
  group_date TEXT NOT NULL,
  asset_count INTEGER NOT NULL,
  PRIMARY KEY (owner_id, group_date)
) WITHOUT ROWID''';

  static String _add(String row) =>
      '''
INSERT INTO $countTable (owner_id, group_date, asset_count)
SELECT $row.owner_id, $row.group_date, 1
WHERE $row.deleted_at IS NULL AND $row.visibility = 0 AND $row.group_date IS NOT NULL
ON CONFLICT (owner_id, group_date) DO UPDATE SET asset_count = asset_count + 1;''';

  static String _remove(String row) =>
      '''
UPDATE $countTable SET asset_count = asset_count - 1
WHERE $row.deleted_at IS NULL AND $row.visibility = 0 AND (owner_id, group_date) = ($row.owner_id, $row.group_date);
DELETE FROM $countTable WHERE (owner_id, group_date) = ($row.owner_id, $row.group_date) AND asset_count <= 0;''';

  // a new version gets new names: the old triggers are dropped, and everything is counted anew
  static const _triggerPrefix = 'ext_timeline_count_';
  static final _triggers = {
    '${_triggerPrefix}insert_v2': 'AFTER INSERT ON remote_asset_entity BEGIN ${_add('NEW')} END',
    '${_triggerPrefix}delete_v2': 'AFTER DELETE ON remote_asset_entity BEGIN ${_remove('OLD')} END',
    '${_triggerPrefix}update_v2':
        'AFTER UPDATE OF owner_id, group_date, deleted_at, visibility ON remote_asset_entity '
        'BEGIN ${_remove('OLD')} ${_add('NEW')} END',
  };

  static const _recount =
      '''
INSERT INTO $countTable (owner_id, group_date, asset_count)
SELECT owner_id, group_date, COUNT(*) FROM remote_asset_entity WHERE $_counted
GROUP BY 1, 2''';

  /// Per connection: rows that `INSERT OR REPLACE` replaces only fire the delete trigger with it, and sync writes
  /// server photos that way
  static Future<void> configureConnection(DatabaseConnectionUser db) =>
      db.customStatement('PRAGMA recursive_triggers = ON');

  static Future<void> ensure(DatabaseConnectionUser db) async {
    // a database of a schema before group_date (as the tests of the migrations open them): nothing to index yet
    if (!await _hasGroupDate(db, 'remote_asset_entity') || !await _hasGroupDate(db, 'local_asset_entity')) {
      return;
    }
    await db.transaction(() async {
      for (final statement in _dropped) {
        await db.customStatement(statement);
      }
      for (final index in _indexes) {
        await db.customStatement(index);
      }
      await db.customStatement(_table);

      final existing = await db
          .customSelect("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '$_triggerPrefix%'")
          .map((row) => row.read<String>('name'))
          .get();
      final isComplete =
          existing.length == _triggers.length && existing.every(_triggers.containsKey) && await _isCounted(db);
      if (isComplete) {
        return;
      }

      for (final name in existing) {
        await db.customStatement('DROP TRIGGER IF EXISTS "$name"');
      }
      for (final MapEntry(key: name, value: body) in _triggers.entries) {
        await db.customStatement('CREATE TRIGGER "$name" $body');
      }
      await db.customStatement('DELETE FROM $countTable');
      await db.customStatement(_recount);
    });
  }

  static Future<bool> _hasGroupDate(DatabaseConnectionUser db, String table) async {
    final columns = await db.customSelect("SELECT name FROM pragma_table_info('$table')").get();
    return columns.any((column) => column.read<String>('name') == 'group_date');
  }

  /// Whether the counts add up to the photos they count: they would not after a write the triggers missed
  static Future<bool> _isCounted(DatabaseConnectionUser db) async {
    final row = await db
        .customSelect(
          'SELECT (SELECT COALESCE(SUM(asset_count), 0) FROM $countTable) AS counted, '
          '(SELECT COUNT(*) FROM remote_asset_entity WHERE $_counted) AS actual',
        )
        .getSingle();
    return row.read<int>('counted') == row.read<int>('actual');
  }
}
