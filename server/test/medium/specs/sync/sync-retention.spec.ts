import { Kysely } from 'kysely';
import { DateTime } from 'luxon';
import { v4, v7 } from 'uuid';
import { SyncEntityType, SyncRequestType, SystemMetadataKey } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SyncCheckpointRepository } from 'src/repositories/sync-checkpoint.repository.js';
import { SyncRepository } from 'src/repositories/sync.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { SyncService } from 'src/services/sync.service.js';
import { SyncDeleteRetentionState, withRetentionSetting } from 'src/utils/sync-retention.js';
import { toAck } from 'src/utils/sync.js';
import { SyncTestContext, newMediumService } from 'test/medium.factory.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const daysAgo = (days: number) => DateTime.now().minus({ days });

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

const setupCleanup = (deleteRetentionDays: number | null) => {
  const { sut, ctx } = newMediumService(SyncService, {
    database: defaultDatabase,
    real: [DatabaseRepository, SyncRepository, SystemMetadataRepository],
    mock: [ConfigRepository, LoggingRepository],
  });
  ctx.getMock(ConfigRepository).getEnv.mockReturnValue({ ...mockEnvData({}), sync: { deleteRetentionDays } });
  return { sut, ctx, metadata: ctx.get(SystemMetadataRepository) };
};

const insertAssetDeletions = async (...days: number[]) => {
  const ownerId = v4();
  await defaultDatabase
    .insertInto('asset_audit')
    .values(days.map((day) => ({ assetId: v4(), ownerId, deletedAt: daysAgo(day).toISO() })))
    .execute();
  return async () => {
    const rows = await defaultDatabase
      .selectFrom('asset_audit')
      .select('deletedAt')
      .where('ownerId', '=', ownerId)
      .execute();
    return rows.length;
  };
};

const setup = async (state: SyncDeleteRetentionState, checkpointDaysAgo: number) => {
  const ctx = new SyncTestContext(defaultDatabase);
  await ctx.get(SystemMetadataRepository).set(SystemMetadataKey.SyncDeleteRetention, state);
  const { auth, session } = await ctx.newSyncAuthUser();
  const updateId = v7({ msecs: daysAgo(checkpointDaysAgo).toMillis() });
  await ctx.get(SyncCheckpointRepository).upsertAll([
    {
      type: SyncEntityType.SyncCompleteV1,
      sessionId: session.id,
      ack: toAck({ type: SyncEntityType.SyncCompleteV1, updateId }),
    },
  ]);
  return { ctx, auth };
};

afterEach(async () => {
  await defaultDatabase
    .deleteFrom('system_metadata')
    .where('key', '=', SystemMetadataKey.SyncDeleteRetention)
    .execute();
});

describe('retention of the records of deletions', () => {
  it('should record the configured retention, and that upstream kept the records for 31 days before', async () => {
    const { sut, metadata } = setupCleanup(365);
    await sut.onBootstrap();

    const state = await metadata.get(SystemMetadataKey.SyncDeleteRetention);
    expect(state?.settings.map(({ days }) => days)).toEqual([31, 365]);
    expect(new Date(state!.prunedBefore!).getTime()).toBeCloseTo(daysAgo(31).toMillis(), -4);
  });

  it('should keep the records of deletions for the configured days', async () => {
    const { sut } = setupCleanup(365);
    await sut.onBootstrap();
    const count = await insertAssetDeletions(35, 300, 400);

    await sut.onAuditTableCleanup();

    await expect(count()).resolves.toBe(2);
  });

  it('should keep the records of deletions forever, if so configured', async () => {
    const { sut } = setupCleanup(null);
    await sut.onBootstrap();
    const count = await insertAssetDeletions(35, 3000);

    await sut.onAuditTableCleanup();

    await expect(count()).resolves.toBe(2);
  });

  it('should remember the time before which records were removed', async () => {
    const { sut, metadata } = setupCleanup(60);
    // configured 400 days ago, so that the retention of upstream before has long passed
    const state = withRetentionSetting(undefined, 60, daysAgo(400).toJSDate());
    await metadata.set(SystemMetadataKey.SyncDeleteRetention, state);

    await sut.onAuditTableCleanup();

    const { prunedBefore } = (await metadata.get(SystemMetadataKey.SyncDeleteRetention))!;
    expect(new Date(prunedBefore!).getTime()).toBeCloseTo(daysAgo(60).toMillis(), -4);
  });
});

describe('full syncs', () => {
  const settings = [{ days: 365, since: null, until: null }];

  it('should not reset a client that synced after the records it needs were kept from', async () => {
    const { ctx, auth } = await setup({ settings, prunedBefore: daysAgo(100).toISO()! }, 60);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.AssetsV2]);
  });

  it('should reset a client that synced before records it needs were removed', async () => {
    const { ctx, auth } = await setup({ settings, prunedBefore: daysAgo(100).toISO()! }, 120);
    await expect(ctx.syncStream(auth, [SyncRequestType.AssetsV2])).resolves.toEqual([
      { type: SyncEntityType.SyncResetV1, data: {}, ack: 'SyncResetV1|reset' },
    ]);
  });

  it('should never reset a client while no records were removed', async () => {
    const { ctx, auth } = await setup({ settings: [{ days: null, since: null, until: null }] }, 1000);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.AssetsV2]);
  });
});
