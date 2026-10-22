import { Kysely } from 'kysely';
import { StorageBackendDriver, StorageUsageCategory } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StorageBackendRepository } from 'src/repositories/storage-backend.repository.js';
import { StorageDeletionRepository } from 'src/repositories/storage-deletion.repository.js';
import { StorageReplicaRepository } from 'src/repositories/storage-replica.repository.js';
import { StorageUsageRepository } from 'src/repositories/storage-usage.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getTestKyselyDB } from 'test/utils.js';

const usage = (day: string, requests: number, purpose = 'api') => ({
  day,
  backendId: 'originals',
  operation: 'GetObject',
  purpose,
  requests,
  bytesSent: 0,
  bytesReceived: requests * 10,
});

const setup = async () => {
  const db: Kysely<DB> = await getTestKyselyDB();
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  await ctx.get(StorageBackendRepository).register([
    { id: 'originals', driver: StorageBackendDriver.Local },
    { id: 'copy', driver: StorageBackendDriver.Local },
  ]);
  return { ctx, db, sut: ctx.get(StorageUsageRepository) };
};

describe(StorageUsageRepository.name, () => {
  it('should add up the requests counted by every process', async () => {
    const { sut } = await setup();
    await sut.addRequests([usage('2026-10-22', 2), usage('2026-10-22', 1, 'StorageReplicate')]);
    await sut.addRequests([usage('2026-10-22', 3)]);
    await sut.addRequests([]);

    const rows = await sut.getRequests('2026-10-22', '2026-10-22');
    expect(rows).toEqual(
      expect.arrayContaining([
        { ...usage('2026-10-22', 5), requests: 5, bytesReceived: 50 },
        usage('2026-10-22', 1, 'StorageReplicate'),
      ]),
    );
    expect(rows).toHaveLength(2);
    await expect(sut.getRequests('2026-10-23', '2026-10-30')).resolves.toEqual([]);
  });

  it('should record what each backend stores, by category, with the overhead of encryption', async () => {
    const { ctx, sut } = await setup();
    const { user } = await ctx.newUser();
    await ctx.get(StorageReplicaRepository).setSources([{ replicaBackendId: 'copy', sourceBackendId: 'originals' }]);
    for (const [key, encryption] of [
      ['plain', null],
      ['encrypted', Buffer.alloc(66)],
    ] as const) {
      await ctx.newAsset({
        ownerId: user.id,
        originalFile: { backendId: 'originals', key, size: 100_000, checksum: Buffer.alloc(20), encryption },
      });
    }
    await ctx.newAsset({ ownerId: user.id });
    await ctx
      .get(StorageDeletionRepository)
      .register([{ backendId: 'originals', key: 'deleted', notBefore: new Date(), isOriginal: true, size: 10 }]);
    const [copy] = await ctx.get(StorageReplicaRepository).claim({ now: new Date(), limit: 1, leaseMs: 1000 });
    await ctx.get(StorageReplicaRepository).complete(copy.id, 100_100, new Date());

    await sut.recordStored('2026-10-22');
    // recording again replaces what was recorded for the day
    await sut.recordStored('2026-10-22');

    const stored = await sut.getStored('2026-10-01', '2026-10-31');
    expect(stored).toEqual(
      expect.arrayContaining([
        // two chunks of 64 KiB with a tag each, and about 512 bytes of trailer
        {
          day: '2026-10-22',
          backendId: 'originals',
          category: StorageUsageCategory.Files,
          objects: 2,
          bytes: 200_000 + 32 + 512,
        },
        {
          day: '2026-10-22',
          backendId: 'originals',
          category: StorageUsageCategory.PendingDeletion,
          objects: 1,
          bytes: 10,
        },
        { day: '2026-10-22', backendId: 'copy', category: StorageUsageCategory.Copies, objects: 1, bytes: 100_100 },
      ]),
    );
    // files on the media location are not on a configured backend
    expect(stored).toHaveLength(3);

    await sut.removeBefore('2026-10-23');
    await expect(sut.getStored('2026-10-01', '2026-10-31')).resolves.toEqual([]);
  });
});
