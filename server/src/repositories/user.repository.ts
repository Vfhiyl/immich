import { Injectable } from '@nestjs/common';
import { type ExpressionBuilder, type Insertable, type Kysely, type Updateable, sql } from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { DateTime } from 'luxon';
import { InjectKysely } from 'nestjs-kysely';
import type { StorageLocation } from 'src/cores/storage.core.js';
import type { UserMetadata, UserMetadataItem } from 'src/types.js';
import { columns } from 'src/database.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { AssetType, AssetVisibility, BuiltinStorageBackend, UserStatus } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { UserTable } from 'src/schema/tables/user.table.js';
import { asUuid } from 'src/utils/database.js';

export interface UserListFilter {
  id?: string;
  withDeleted?: boolean;
}

export interface UserStatsQueryResponse {
  userId: string;
  userName: string;
  photos: number;
  videos: number;
  usage: number;
  usagePhotos: number;
  usageVideos: number;
  quotaSizeInBytes: number | null;
}

export interface UserFindOptions {
  withDeleted?: boolean;
}

const withMetadata = (eb: ExpressionBuilder<DB, 'user'>) => {
  return jsonArrayFrom(
    eb
      .selectFrom('user_metadata')
      .select(['user_metadata.key', 'user_metadata.value'])
      .whereRef('user.id', '=', 'user_metadata.userId'),
  ).as('metadata');
};

@Injectable()
export class UserRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.BOOLEAN] })
  get(userId: string, options: UserFindOptions) {
    options ||= {};

    return this.db
      .selectFrom('user')
      .select(columns.userAdmin)
      .select(withMetadata)
      .where('user.id', '=', userId)
      .$if(!options.withDeleted, (eb) => eb.where('user.deletedAt', 'is', null))
      .executeTakeFirst();
  }

  /** The profile image of a user and where it is stored */
  @GenerateSql({ params: [DummyValue.UUID] })
  getProfileImageFile(userId: string) {
    return this.db
      .selectFrom('user')
      .leftJoin('user_profile_image_file', 'user_profile_image_file.userId', 'user.id')
      .select([
        'user.profileImagePath as path',
        'user_profile_image_file.backendId as backendId',
        'user_profile_image_file.key as key',
      ])
      .where('user.id', '=', userId)
      .where('user.deletedAt', 'is', null)
      .executeTakeFirst();
  }

  getMetadata(userId: string) {
    return this.db
      .selectFrom('user_metadata')
      .select(['key', 'value'])
      .where('user_metadata.userId', '=', userId)
      .execute() as Promise<UserMetadataItem[]>;
  }

  @GenerateSql()
  getAdmin() {
    return this.db
      .selectFrom('user')
      .select(columns.userAdmin)
      .select(withMetadata)
      .where('user.isAdmin', '=', true)
      .where('user.deletedAt', 'is', null)
      .executeTakeFirst();
  }

  @GenerateSql()
  getFileSamples() {
    return this.db
      .selectFrom('user')
      .select(['id', 'profileImagePath'])
      .where('profileImagePath', '!=', sql.lit(''))
      .limit(sql.lit(3))
      .execute();
  }

  @GenerateSql()
  async hasAdmin(): Promise<boolean> {
    const admin = await this.db
      .selectFrom('user')
      .select('user.id')
      .where('user.isAdmin', '=', true)
      .where('user.deletedAt', 'is', null)
      .executeTakeFirst();

    return !!admin;
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForPinCode(id: string) {
    return this.db
      .selectFrom('user')
      .select(['user.pinCode', 'user.password'])
      .where('user.id', '=', id)
      .where('user.deletedAt', 'is', null)
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForChangePassword(id: string) {
    return this.db
      .selectFrom('user')
      .select(['user.id', 'user.password'])
      .where('user.id', '=', id)
      .where('user.deletedAt', 'is', null)
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.EMAIL] })
  getByEmail(email: string, options?: { withPassword?: boolean }) {
    return this.db
      .selectFrom('user')
      .select(columns.userAdmin)
      .select(withMetadata)
      .$if(!!options?.withPassword, (eb) => eb.select('password'))
      .where('email', '=', email)
      .where('user.deletedAt', 'is', null)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.STRING] })
  getByStorageLabel(storageLabel: string) {
    return this.db
      .selectFrom('user')
      .select(columns.userAdmin)
      .where('user.storageLabel', '=', storageLabel)
      .where('user.deletedAt', 'is', null)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.STRING] })
  getByOAuthId(oauthId: string) {
    return this.db
      .selectFrom('user')
      .select(columns.userAdmin)
      .select(withMetadata)
      .where('user.oauthId', '=', oauthId)
      .where('user.deletedAt', 'is', null)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DateTime.now().minus({ years: 1 })] })
  getDeletedAfter(target: DateTime) {
    return this.db.selectFrom('user').select(['id']).where('user.deletedAt', '<', target.toJSDate()).execute();
  }

  @GenerateSql(
    { name: 'with deleted', params: [{ withDeleted: true }] },
    { name: 'without deleted', params: [{ withDeleted: false }] },
  )
  getList({ id, withDeleted }: UserListFilter = {}) {
    return this.db
      .selectFrom('user')
      .select(columns.userAdmin)
      .select(withMetadata)
      .$if(!withDeleted, (eb) => eb.where('user.deletedAt', 'is', null))
      .$if(!!id, (eb) => eb.where('user.id', '=', id!))
      .orderBy('createdAt', 'desc')
      .execute();
  }

  async create(dto: Insertable<UserTable>) {
    return this.db
      .insertInto('user')
      .values(dto)
      .returning(columns.userAdmin)
      .returning(withMetadata)
      .executeTakeFirstOrThrow();
  }

  update(id: string, dto: Updateable<UserTable>) {
    return this.db
      .updateTable('user')
      .set(dto)
      .where('user.id', '=', asUuid(id))
      .where('user.deletedAt', 'is', null)
      .returning(columns.userAdmin)
      .returning(withMetadata)
      .executeTakeFirstOrThrow();
  }

  /** Set or clear the profile image of a user, recording where it is stored */
  updateProfileImage(
    id: string,
    {
      profileImagePath,
      profileImageFile,
      profileChangedAt,
    }: {
      profileImagePath: string;
      profileImageFile: (StorageLocation & { size?: number | null; checksum?: Buffer | null }) | null;
      profileChangedAt: Date;
    },
  ) {
    return this.db.transaction().execute(async (tx) => {
      const user = await tx
        .updateTable('user')
        .set({ profileImagePath, profileChangedAt })
        .where('user.id', '=', asUuid(id))
        .where('user.deletedAt', 'is', null)
        .returning(columns.userAdmin)
        .returning(withMetadata)
        .executeTakeFirstOrThrow();

      if (profileImageFile) {
        await tx
          .insertInto('user_profile_image_file')
          .values({ userId: id, ...profileImageFile })
          .onConflict((oc) =>
            oc.column('userId').doUpdateSet((eb) => ({
              backendId: eb.ref('excluded.backendId'),
              key: eb.ref('excluded.key'),
              size: eb.ref('excluded.size'),
              checksum: eb.ref('excluded.checksum'),
            })),
          )
          .execute();
      } else {
        await tx.deleteFrom('user_profile_image_file').where('userId', '=', id).execute();
      }

      return user;
    });
  }

  @GenerateSql({ params: [{ afterId: DummyValue.UUID, limit: 1000 }] })
  getUsersWithoutProfileImageFile({ afterId, limit }: { afterId?: string; limit: number }) {
    return this.db
      .selectFrom('user')
      .select(['user.id', 'user.profileImagePath as path'])
      .where('user.profileImagePath', '!=', '')
      .where((eb) =>
        eb.not(
          eb.exists(
            eb.selectFrom('user_profile_image_file').whereRef('user_profile_image_file.userId', '=', 'user.id'),
          ),
        ),
      )
      .$if(afterId !== undefined, (qb) => qb.where('user.id', '>', asUuid(afterId!)))
      .orderBy('user.id')
      .limit(limit)
      .execute();
  }

  @GenerateSql()
  async hasUsersWithoutProfileImageFile(): Promise<boolean> {
    const [user] = await this.getUsersWithoutProfileImageFile({ limit: 1 });
    return user !== undefined;
  }

  /**
   * Record the profile image file of users that do not have one yet, with the same rules as for asset files. Users
   * deleted in the meantime are skipped. Returns the number of users updated.
   */
  @GenerateSql({ params: [[{ id: DummyValue.UUID, backendId: DummyValue.STRING, key: DummyValue.STRING }]] })
  async setProfileImageFiles(files: Array<{ id: string } & StorageLocation>): Promise<number> {
    if (files.length === 0) {
      return 0;
    }

    const rows = sql.join(files.map(({ id, backendId, key }) => sql`(${id}::uuid, ${backendId}, ${key})`));
    const result = await sql`
      insert into "user_profile_image_file" ("userId", "backendId", "key")
      select "location"."id", "location"."backendId", "location"."key"
      from (values ${rows}) as "location" ("id", "backendId", "key")
      where exists (select from "user" where "user"."id" = "location"."id")
        and (
          "location"."backendId" = ${BuiltinStorageBackend.Host}
          or not exists (
            select from "user_profile_image_file" as "other"
            where "other"."backendId" = "location"."backendId" and "other"."key" = "location"."key"
          )
        )
      on conflict ("userId") do nothing
    `.execute(this.db);

    return Number(result.numAffectedRows ?? 0);
  }

  async updateAll(dto: Updateable<UserTable>) {
    await this.db.updateTable('user').set(dto).execute();
  }

  restore(id: string) {
    return this.db
      .updateTable('user')
      .set({ status: UserStatus.Active, deletedAt: null })
      .where('user.id', '=', asUuid(id))
      .returning(columns.userAdmin)
      .returning(withMetadata)
      .executeTakeFirstOrThrow();
  }

  async upsertMetadata<T extends keyof UserMetadata>(id: string, { key, value }: { key: T; value: UserMetadata[T] }) {
    await this.db
      .insertInto('user_metadata')
      .values({ userId: id, key, value })
      .onConflict((oc) =>
        oc.columns(['userId', 'key']).doUpdateSet({
          key,
          value,
        }),
      )
      .execute();
  }

  async deleteMetadata<T extends keyof UserMetadata>(id: string, key: T) {
    await this.db.deleteFrom('user_metadata').where('userId', '=', id).where('key', '=', key).execute();
  }

  delete(user: { id: string }, hard?: boolean) {
    return hard
      ? this.db.deleteFrom('user').where('id', '=', user.id).execute()
      : this.db.updateTable('user').set({ deletedAt: new Date() }).where('id', '=', user.id).execute();
  }

  @GenerateSql()
  getUserStats() {
    return this.db
      .selectFrom('user')
      .leftJoin('asset', (join) => join.onRef('asset.ownerId', '=', 'user.id').on('asset.deletedAt', 'is', null))
      .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select(['user.id as userId', 'user.name as userName', 'user.quotaSizeInBytes'])
      .select((eb) => [
        eb.fn
          .countAll<number>()
          .filterWhere((eb) =>
            eb.and([
              eb('asset.type', '=', sql.lit(AssetType.Image)),
              eb('asset.visibility', '!=', sql.lit(AssetVisibility.Hidden)),
            ]),
          )
          .as('photos'),
        eb.fn
          .countAll<number>()
          .filterWhere((eb) =>
            eb.and([
              eb('asset.type', '=', sql.lit(AssetType.Video)),
              eb('asset.visibility', '!=', sql.lit(AssetVisibility.Hidden)),
            ]),
          )
          .as('videos'),
        eb.fn
          .coalesce(
            eb.fn.sum<number>('asset_exif.fileSizeInByte').filterWhere('asset.libraryId', 'is', null),
            eb.lit(0),
          )
          .as('usage'),
        eb.fn
          .coalesce(
            eb.fn
              .sum<number>('asset_exif.fileSizeInByte')
              .filterWhere((eb) =>
                eb.and([eb('asset.libraryId', 'is', null), eb('asset.type', '=', sql.lit(AssetType.Image))]),
              ),
            eb.lit(0),
          )
          .as('usagePhotos'),
        eb.fn
          .coalesce(
            eb.fn
              .sum<number>('asset_exif.fileSizeInByte')
              .filterWhere((eb) =>
                eb.and([eb('asset.libraryId', 'is', null), eb('asset.type', '=', sql.lit(AssetType.Video))]),
              ),
            eb.lit(0),
          )
          .as('usageVideos'),
      ])
      .groupBy('user.id')
      .orderBy('user.createdAt', 'asc')
      .execute();
  }

  @GenerateSql()
  async getCount(): Promise<number> {
    const result = await this.db
      .selectFrom('user')
      .select((eb) => eb.fn.countAll().as('count'))
      .where('user.deletedAt', 'is', null)
      .executeTakeFirstOrThrow();
    return Number(result.count);
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.NUMBER] })
  async updateUsage(id: string, delta: number): Promise<void> {
    await this.db
      .updateTable('user')
      .set({ quotaUsageInBytes: sql`"quotaUsageInBytes" + ${delta}`, updatedAt: new Date() })
      .where('id', '=', asUuid(id))
      .where('user.deletedAt', 'is', null)
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async syncUsage(id?: string) {
    const query = this.db
      .updateTable('user')
      .set({
        quotaUsageInBytes: (eb) =>
          eb
            .selectFrom('asset')
            .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
            .select((eb) => eb.fn.coalesce(eb.fn.sum<number>('asset_exif.fileSizeInByte'), eb.lit(0)).as('usage'))
            .where('asset.libraryId', 'is', null)
            .where('asset.ownerId', '=', eb.ref('user.id')),
        updatedAt: new Date(),
      })
      .where('user.deletedAt', 'is', null)
      .$if(id !== undefined, (eb) => eb.where('user.id', '=', asUuid(id!)));

    await query.execute();
  }
}
