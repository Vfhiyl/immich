import { Kysely } from 'kysely';
import { AssetFileType, StorageBackendDriver } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { StorageBackendRepository } from 'src/repositories/storage-backend.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

const setup = (db: Kysely<DB>) => {
  const { ctx } = newMediumService(BaseService, {
    database: db,
    real: [],
    mock: [LoggingRepository],
  });
  return { ctx, sut: ctx.get(StorageBackendRepository) };
};

const local = StorageBackendDriver.Local;

describe(StorageBackendRepository.name, () => {
  describe('register', () => {
    it('should list the built-in backends of a new installation', async () => {
      const { sut } = setup(await getKyselyDB());

      await expect(sut.getRegistered()).resolves.toEqual([
        { id: 'host', driver: local },
        { id: 'media', driver: local },
      ]);
    });

    it('should register new backends and leave registered ones alone', async () => {
      const { sut } = setup(await getKyselyDB());

      await sut.register([{ id: 'originals', driver: local }]);
      await sut.register([
        { id: 'originals', driver: local },
        { id: 'derived', driver: local },
      ]);
      await sut.register([]);

      await expect(sut.getRegistered()).resolves.toEqual([
        { id: 'derived', driver: local },
        { id: 'host', driver: local },
        { id: 'media', driver: local },
        { id: 'originals', driver: local },
      ]);
    });
  });

  describe('isInUse', () => {
    it('should not report a backend without files', async () => {
      const { sut } = setup(await getKyselyDB());
      await sut.register([{ id: 'empty', driver: local }]);

      await expect(sut.isInUse('empty')).resolves.toBe(false);
    });

    it('should report a backend that holds an asset file', async () => {
      const { ctx, sut } = setup(await getKyselyDB());
      await sut.register([{ id: 'derived', driver: local }]);
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newAssetFile({
        assetId: asset.id,
        type: AssetFileType.Preview,
        path: '/data/preview.jpg',
        backendId: 'derived',
        key: 'p1',
      });

      await expect(sut.isInUse('derived')).resolves.toBe(true);
    });

    it('should report a backend that holds an original', async () => {
      const { ctx, sut } = setup(await getKyselyDB());
      await sut.register([{ id: 'originals', driver: local }]);
      const { user } = await ctx.newUser();
      await ctx.newAsset({ ownerId: user.id, originalFile: { backendId: 'originals', key: 'o1' } });

      await expect(sut.isInUse('originals')).resolves.toBe(true);
    });

    it('should report a backend that holds a person thumbnail', async () => {
      const { ctx, sut } = setup(await getKyselyDB());
      await sut.register([{ id: 'derived', driver: local }]);
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id });
      await ctx.get(PersonRepository).updateThumbnail({
        ownerId: user.id,
        personGroupId: person.personGroupId,
        thumbnailPath: '/data/face.jpeg',
        thumbnailFile: { backendId: 'derived', key: 'f1' },
      });

      await expect(sut.isInUse('derived')).resolves.toBe(true);
    });

    it('should report a backend that holds a profile image', async () => {
      const { ctx, sut } = setup(await getKyselyDB());
      await sut.register([{ id: 'derived', driver: local }]);
      const { user } = await ctx.newUser();
      await ctx.get(UserRepository).updateProfileImage(user.id, {
        profileImagePath: '/data/profile.webp',
        profileImageFile: { backendId: 'derived', key: 'u1' },
        profileChangedAt: new Date(),
      });

      await expect(sut.isInUse('derived')).resolves.toBe(true);
    });
  });
});
