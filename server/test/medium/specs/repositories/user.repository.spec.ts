import { Kysely } from 'kysely';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { MediumTestContext, newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const { ctx } = newMediumService(BaseService, {
    database: db || defaultDatabase,
    real: [],
    mock: [LoggingRepository],
  });
  return { ctx, sut: ctx.get(UserRepository) };
};

const getProfileImageFile = (ctx: MediumTestContext, userId: string) =>
  ctx.database
    .selectFrom('user_profile_image_file')
    .select(['backendId', 'key'])
    .where('userId', '=', userId)
    .executeTakeFirst();

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(UserRepository.name, () => {
  describe('updateProfileImage', () => {
    it('should record the profile image file and replace it with a new image', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const profileChangedAt = new Date('2024-01-01T00:00:00.000Z');

      await sut.updateProfileImage(user.id, {
        profileImagePath: `/data/profile/${user.id}/a.webp`,
        profileImageFile: { backendId: 'media', key: `profile/${user.id}/a.webp` },
        profileChangedAt,
      });
      const result = await sut.updateProfileImage(user.id, {
        profileImagePath: `/data/profile/${user.id}/b.webp`,
        profileImageFile: { backendId: 'media', key: `profile/${user.id}/b.webp` },
        profileChangedAt,
      });

      expect(result).toMatchObject({
        id: user.id,
        profileImagePath: `/data/profile/${user.id}/b.webp`,
        profileChangedAt,
      });
      await expect(getProfileImageFile(ctx, user.id)).resolves.toEqual({
        backendId: 'media',
        key: `profile/${user.id}/b.webp`,
      });
    });

    it('should remove the profile image file when the image is removed', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      await sut.updateProfileImage(user.id, {
        profileImagePath: `/data/profile/${user.id}/a.webp`,
        profileImageFile: { backendId: 'media', key: `profile/${user.id}/a.webp` },
        profileChangedAt: new Date(),
      });

      await sut.updateProfileImage(user.id, {
        profileImagePath: '',
        profileImageFile: null,
        profileChangedAt: new Date(),
      });

      await expect(getProfileImageFile(ctx, user.id)).resolves.toBeUndefined();
    });

    it('should not record anything for a deleted user', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser({ deletedAt: new Date() });

      await expect(
        sut.updateProfileImage(user.id, {
          profileImagePath: `/data/profile/${user.id}/a.webp`,
          profileImageFile: { backendId: 'media', key: `profile/${user.id}/a.webp` },
          profileChangedAt: new Date(),
        }),
      ).rejects.toThrow();

      await expect(getProfileImageFile(ctx, user.id)).resolves.toBeUndefined();
    });
  });

  describe('getProfileImageFile', () => {
    it('should return the profile image with its recorded location', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      await sut.updateProfileImage(user.id, {
        profileImagePath: `/data/profile/${user.id}/a.webp`,
        profileImageFile: { backendId: 'media', key: `profile/${user.id}/a.webp` },
        profileChangedAt: new Date(),
      });

      await expect(sut.getProfileImageFile(user.id)).resolves.toEqual({
        path: `/data/profile/${user.id}/a.webp`,
        backendId: 'media',
        key: `profile/${user.id}/a.webp`,
      });
    });

    it('should return a profile image without a recorded location', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser({ profileImagePath: '/data/profile/old.webp' });

      await expect(sut.getProfileImageFile(user.id)).resolves.toEqual({
        path: '/data/profile/old.webp',
        backendId: null,
        key: null,
      });
    });

    it('should not return anything for a deleted user', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser({ profileImagePath: '/data/profile/old.webp', deletedAt: new Date() });

      await expect(sut.getProfileImageFile(user.id)).resolves.toBeUndefined();
    });
  });

  describe('profile image file backfill', () => {
    it('should page through users that have a profile image but no profile image file', async () => {
      const db = await getKyselyDB();
      const { ctx, sut } = setup(db);
      const users = [];
      for (const name of ['a', 'b', 'c']) {
        const { user } = await ctx.newUser({ profileImagePath: `/data/profile/${name}.webp` });
        users.push(user);
      }
      await ctx.newUser({ profileImagePath: '' });
      const { user: located } = await ctx.newUser();
      await sut.updateProfileImage(located.id, {
        profileImagePath: '/data/profile/located.webp',
        profileImageFile: { backendId: 'media', key: 'profile/located.webp' },
        profileChangedAt: new Date(),
      });
      const expected = users
        .map(({ id, profileImagePath }) => ({ id, path: profileImagePath }))
        .toSorted((a, b) => a.id!.localeCompare(b.id!));

      await expect(sut.hasUsersWithoutProfileImageFile()).resolves.toBe(true);
      await expect(sut.getUsersWithoutProfileImageFile({ limit: 2 })).resolves.toEqual(expected.slice(0, 2));
      await expect(sut.getUsersWithoutProfileImageFile({ afterId: expected[1].id, limit: 2 })).resolves.toEqual(
        expected.slice(2),
      );
    });

    it('should set profile image files, skipping users that have one and taken locations', async () => {
      const { ctx, sut } = setup();
      const { user: first } = await ctx.newUser({ profileImagePath: '/data/profile/first.webp' });
      const { user: second } = await ctx.newUser({ profileImagePath: '/data/profile/second.webp' });
      const { user: located } = await ctx.newUser();
      const takenFile = { backendId: 'media', key: `profile/${located.id}.webp` };
      await sut.updateProfileImage(located.id!, {
        profileImagePath: '/data/located.webp',
        profileImageFile: takenFile,
        profileChangedAt: new Date(),
      });

      await expect(
        sut.setProfileImageFiles([
          { id: first.id!, backendId: 'media', key: `profile/${first.id}.webp` },
          { id: second.id!, ...takenFile },
          { id: located.id!, backendId: 'media', key: 'profile/other.webp' },
        ]),
      ).resolves.toBe(1);

      await expect(getProfileImageFile(ctx, first.id!)).resolves.toEqual({
        backendId: 'media',
        key: `profile/${first.id}.webp`,
      });
      await expect(getProfileImageFile(ctx, second.id!)).resolves.toBeUndefined();
      await expect(getProfileImageFile(ctx, located.id!)).resolves.toEqual(takenFile);
    });

    it('should do nothing when no profile image files are given', async () => {
      const { sut } = setup();
      await expect(sut.setProfileImageFiles([])).resolves.toBe(0);
    });
  });
});
