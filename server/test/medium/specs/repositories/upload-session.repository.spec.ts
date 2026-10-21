import { Kysely } from 'kysely';
import { UploadSessionStatus } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { UploadSessionRepository } from 'src/repositories/upload-session.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

const setup = async () => {
  const db: Kysely<DB> = await getKyselyDB();
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  return { ctx, sut: ctx.get(UploadSessionRepository) };
};

const session = (ownerId: string, overrides: object = {}) => ({
  ownerId,
  status: UploadSessionStatus.Receiving,
  assetData: { filename: 'a.jpg', fileCreatedAt: '2021-01-01T00:00:00Z', fileModifiedAt: '2021-01-01T00:00:00Z' },
  backendId: 'media',
  key: 'upload/a.jpg',
  blobUploadId: '00000000-0000-4000-8000-000000000000',
  partSize: 16 * 1024 * 1024,
  expiresAt: new Date(Date.now() + 60_000),
  ...overrides,
});

describe(UploadSessionRepository.name, () => {
  it('should create, read, update and delete a session', async () => {
    const { sut, ctx } = await setup();
    const { user } = await ctx.newUser();

    const created = await sut.create(session(user.id, { length: 10 }));
    expect(created).toMatchObject({ ownerId: user.id, parts: [], committedOffset: 0, length: 10 });

    const part = { number: 1, etag: 'etag', size: 5 };
    const updated = await sut.update(created.id, { parts: [part], committedOffset: 5 });
    expect(updated).toMatchObject({ parts: [part], committedOffset: 5 });
    await expect(sut.get(created.id)).resolves.toMatchObject({ parts: [part] });

    await sut.delete(created.id);
    await expect(sut.get(created.id)).resolves.toBeUndefined();
  });

  it('should set aside the declared length of uploads still being received', async () => {
    const { sut, ctx } = await setup();
    const { user } = await ctx.newUser();
    const { user: other } = await ctx.newUser();
    await sut.create(session(user.id, { length: 100 }));
    await sut.create(session(user.id, { length: 50 }));
    await sut.create(session(user.id, { length: 1000, status: UploadSessionStatus.Completed }));
    await sut.create(session(user.id));
    await sut.create(session(other.id, { length: 7 }));

    await expect(sut.getReservedBytes(user.id)).resolves.toBe(150);
    await expect(sut.getReservedBytes(other.id)).resolves.toBe(7);
    const { user: none } = await ctx.newUser();
    await expect(sut.getReservedBytes(none.id)).resolves.toBe(0);
  });

  it('should find expired sessions', async () => {
    const { sut, ctx } = await setup();
    const { user } = await ctx.newUser();
    const expired = await sut.create(session(user.id, { expiresAt: new Date(Date.now() - 1000) }));
    await sut.create(session(user.id));

    const found = await sut.getExpired(new Date());
    expect(found.map(({ id }) => id)).toEqual([expired.id]);
  });
});
