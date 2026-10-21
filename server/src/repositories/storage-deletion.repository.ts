import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { RecordedFile } from 'src/repositories/storage-backend.repository.js';
import { StorageLocation } from 'src/cores/storage.core.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { BuiltinStorageBackend } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { StorageDeletionTable } from 'src/schema/tables/storage-deletion.table.js';

export type StorageDeletionRequest = Insertable<StorageDeletionTable>;

/** What recovering a deleted original as a new photo needs */
export type OriginalRecovery = Partial<
  Pick<
    StorageDeletionRequest,
    'ownerId' | 'originalFileName' | 'originalPath' | 'fileCreatedAt' | 'size' | 'checksum' | 'encryption'
  >
>;

/** When a deleted file may be deleted from its backend, by whether it is an original */
export interface DeletionTimes {
  /** The backend for derived files, whose files are not originals */
  derivedBackendId?: string;
  originalsNotBefore: Date;
  derivedNotBefore: Date;
}

export interface DueDeletionOptions {
  now: Date;
  /** The configured delay of originals, which also applies to originals registered with a shorter one */
  originalsDelayDays: number;
  limit: number;
}

/** A deleted original as a recorded file, which reads it like any other */
export const toDeletedOriginalFile = (row: {
  backendId: string;
  key: string;
  originalPath: string | null;
  originalFileName: string | null;
  size: number | string | null;
  checksum: Buffer | null;
  encryption: Buffer | null;
}): RecordedFile => ({
  path: row.originalPath ?? row.originalFileName ?? row.key,
  backendId: row.backendId,
  key: row.key,
  size: row.size,
  checksum: row.checksum,
  encryption: row.encryption,
});

const builtinBackends = Object.values(BuiltinStorageBackend);

@Injectable()
export class StorageDeletionRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /** Register files for deletion; a file that is registered already keeps its registration */
  async register(requests: StorageDeletionRequest[]) {
    if (requests.length === 0) {
      return;
    }

    await this.db
      .insertInto('storage_deletion')
      .values(requests)
      .onConflict((oc) => oc.columns(['backendId', 'key']).doNothing())
      .execute();
  }

  /**
   * Register every file of a user that is stored on a backend, before the user and their records are deleted. Originals
   * keep what is needed to recover them.
   */
  @GenerateSql({
    params: [DummyValue.UUID, { originalsNotBefore: DummyValue.DATE, derivedNotBefore: DummyValue.DATE }],
  })
  async registerUserFiles(userId: string, times: DeletionTimes) {
    const notBefore = (column: 'backendId' | 'asset_file.backendId') =>
      sql<Date>`case when ${sql.ref(column)} = ${times.derivedBackendId ?? null} then ${times.derivedNotBefore}::timestamptz else ${times.originalsNotBefore}::timestamptz end`;
    const isOriginal = (column: string) =>
      sql<boolean>`${sql.ref(column)} is distinct from ${times.derivedBackendId ?? null}`;

    await this.db.transaction().execute(async (tx) => {
      await tx
        .insertInto('storage_deletion')
        .columns([
          'backendId',
          'key',
          'notBefore',
          'isOriginal',
          'ownerId',
          'originalFileName',
          'originalPath',
          'fileCreatedAt',
          'size',
          'checksum',
          'encryption',
        ])
        .expression((eb) =>
          eb
            .selectFrom('asset_original_file')
            .innerJoin('asset', 'asset.id', 'asset_original_file.assetId')
            .where('asset.ownerId', '=', userId)
            .where('asset_original_file.backendId', 'not in', builtinBackends)
            .select((eb) => [
              'asset_original_file.backendId',
              'asset_original_file.key',
              sql<Date>`${times.originalsNotBefore}::timestamptz`.as('notBefore'),
              eb.val(true).as('isOriginal'),
              'asset.ownerId',
              'asset.originalFileName',
              'asset.originalPath',
              'asset.fileCreatedAt',
              'asset_original_file.size',
              'asset_original_file.checksum',
              'asset_original_file.encryption',
            ]),
        )
        .onConflict((oc) => oc.columns(['backendId', 'key']).doNothing())
        .execute();

      await tx
        .insertInto('storage_deletion')
        .columns(['backendId', 'key', 'notBefore', 'isOriginal'])
        .expression((eb) =>
          eb
            .selectFrom('asset_file')
            .innerJoin('asset', 'asset.id', 'asset_file.assetId')
            .where('asset.ownerId', '=', userId)
            .where('asset_file.backendId', 'not in', builtinBackends)
            .select(['asset_file.backendId', 'asset_file.key'])
            .select([
              notBefore('asset_file.backendId').as('notBefore'),
              isOriginal('asset_file.backendId').as('isOriginal'),
            ])
            .$narrowType<{ backendId: string; key: string }>(),
        )
        .onConflict((oc) => oc.columns(['backendId', 'key']).doNothing())
        .execute();

      for (const table of ['person_thumbnail_file', 'user_profile_image_file'] as const) {
        const owner = table === 'person_thumbnail_file' ? 'ownerId' : 'userId';
        await tx
          .insertInto('storage_deletion')
          .columns(['backendId', 'key', 'notBefore', 'isOriginal'])
          .expression(
            sql`select "backendId", "key", ${notBefore('backendId')}, ${isOriginal('backendId')} from ${sql.table(table)}
              where ${sql.ref(owner)} = ${userId} and "backendId" not in (${sql.join(builtinBackends)})`,
          )
          .onConflict((oc) => oc.columns(['backendId', 'key']).doNothing())
          .execute();
      }
    });
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  get(id: string) {
    return this.db.selectFrom('storage_deletion').selectAll().where('id', '=', id).executeTakeFirst();
  }

  @GenerateSql()
  async countPending(): Promise<{ originals: number; files: number }> {
    const { originals, files } = await this.db
      .selectFrom('storage_deletion')
      .select((eb) => [
        eb.fn.countAll<number>().filterWhere('isOriginal', '=', true).as('originals'),
        eb.fn.countAll<number>().as('files'),
      ])
      .executeTakeFirstOrThrow();
    return { originals: Number(originals), files: Number(files) };
  }

  /** Deleted originals that can be recovered, the most recently deleted first, a page after `after` */
  @GenerateSql({ params: [{ limit: 100 }] })
  listOriginals({
    ownerId,
    after,
    limit,
  }: {
    ownerId?: string;
    after?: { createdAt: Date; id: string };
    limit: number;
  }) {
    return this.db
      .selectFrom('storage_deletion')
      .selectAll()
      .where('isOriginal', '=', true)
      .where('originalFileName', 'is not', null)
      .$if(!!ownerId, (qb) => qb.where('ownerId', '=', ownerId!))
      .$if(!!after, (qb) =>
        qb.where((eb) => eb(eb.refTuple('createdAt', 'id'), '<', eb.tuple(after!.createdAt, after!.id))),
      )
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .execute();
  }

  /** Registered files whose time has come, the longest waiting first */
  @GenerateSql({ params: [{ now: DummyValue.DATE, originalsDelayDays: 360, limit: 1000 }] })
  getDue({ now, originalsDelayDays, limit }: DueDeletionOptions) {
    return this.db
      .selectFrom('storage_deletion')
      .selectAll()
      .where('notBefore', '<=', now)
      .where((eb) =>
        eb.or([
          eb('isOriginal', '=', false),
          eb('createdAt', '<=', sql<Date>`${now}::timestamptz - make_interval(days => ${originalsDelayDays})`),
        ]),
      )
      .orderBy('notBefore')
      .limit(limit)
      .execute();
  }

  @GenerateSql({ params: [{ now: DummyValue.DATE, originalsDelayDays: 360 }] })
  async countDueOriginals({ now, originalsDelayDays }: Omit<DueDeletionOptions, 'limit'>): Promise<number> {
    const { count } = await this.db
      .selectFrom('storage_deletion')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('isOriginal', '=', true)
      .where('notBefore', '<=', now)
      .where('createdAt', '<=', sql<Date>`${now}::timestamptz - make_interval(days => ${originalsDelayDays})`)
      .executeTakeFirstOrThrow();
    return Number(count);
  }

  /** Originals recorded on storage backends, which the size of a deletion is compared with */
  @GenerateSql()
  async countStoredOriginals(): Promise<number> {
    const { count } = await this.db
      .selectFrom('asset_original_file')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('backendId', 'not in', builtinBackends)
      .executeTakeFirstOrThrow();
    return Number(count);
  }

  /** Which of these files are still recorded somewhere; uses the (backendId, key) indexes of the file tables */
  @GenerateSql({ params: [[{ backendId: DummyValue.STRING, key: DummyValue.STRING }]] })
  async getRecorded(locations: StorageLocation[]): Promise<StorageLocation[]> {
    if (locations.length === 0) {
      return [];
    }

    const candidates = sql.join(locations.map(({ backendId, key }) => sql`(${backendId}, ${key})`));
    const { rows } = await sql<StorageLocation>`
      with "candidate" ("backendId", "key") as (values ${candidates})
      select "candidate"."backendId", "candidate"."key" from "candidate"
      where exists (select from "asset_file" f where f."backendId" = "candidate"."backendId" and f."key" = "candidate"."key")
        or exists (select from "asset_original_file" f where f."backendId" = "candidate"."backendId" and f."key" = "candidate"."key")
        or exists (select from "person_thumbnail_file" f where f."backendId" = "candidate"."backendId" and f."key" = "candidate"."key")
        or exists (select from "user_profile_image_file" f where f."backendId" = "candidate"."backendId" and f."key" = "candidate"."key")
    `.execute(this.db);
    return rows;
  }

  @GenerateSql({ params: [[DummyValue.UUID]] })
  async remove(ids: string[]) {
    if (ids.length === 0) {
      return;
    }
    await this.db.deleteFrom('storage_deletion').where('id', 'in', ids).execute();
  }

  /** Note a failed deletion and try again after a pause that grows with every attempt */
  @GenerateSql({ params: [[DummyValue.UUID], DummyValue.STRING, DummyValue.DATE] })
  async recordFailure(ids: string[], error: string, now: Date) {
    if (ids.length === 0) {
      return;
    }
    await this.db
      .updateTable('storage_deletion')
      .set((eb) => ({
        attempts: eb('attempts', '+', 1),
        lastError: error,
        notBefore: sql<Date>`${now}::timestamptz + make_interval(hours => least(24, power(2, "attempts")::int))`,
      }))
      .where('id', 'in', ids)
      .execute();
  }
}
