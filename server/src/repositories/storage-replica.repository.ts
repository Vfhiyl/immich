import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { StorageLocation } from 'src/cores/storage.core.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { StorageBackendRole } from 'src/enum.js';
import { STORAGE_PROBE_PREFIX } from 'src/repositories/storage-backend.repository.js';
import { FoundIssue, MAX_ISSUES_PER_RUN } from 'src/repositories/storage-check.repository.js';
import { DB } from 'src/schema/index.js';

/** The roles whose files are recorded, and copied one by one; database backups are copied when they are stored */
export const TRACKED_REPLICA_ROLES = new Set([StorageBackendRole.Originals]);

/** A copy that failed this often is reported as failing; it is still tried again, less and less often */
export const FAILING_COPY_ATTEMPTS = 5;

export interface ReplicaSource {
  replicaBackendId: string;
  sourceBackendId: string;
}

export interface ReplicaCopy extends ReplicaSource {
  id: string;
  key: string;
  attempts: number;
}

/** A replica keeps the copies of a backend in a folder named after it, which is listed on its own */
export const toListingId = ({ replicaBackendId, sourceBackendId }: ReplicaSource) =>
  `${replicaBackendId}/${sourceBackendId}`;

export interface ReplicaStatus {
  replicaBackendId: string;
  copied: number;
  copiedBytes: number;
  pending: number;
  failing: number;
  oldestPendingAt: Date | null;
}

@Injectable()
export class StorageReplicaRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql()
  getSources(): Promise<ReplicaSource[]> {
    return this.db
      .selectFrom('storage_replica_source')
      .select(['replicaBackendId', 'sourceBackendId'])
      .orderBy('replicaBackendId')
      .orderBy('sourceBackendId')
      .execute();
  }

  /**
   * Record which backends the replicas copy, as configured; returns the ones that are new. A replica that no longer
   * copies a backend gets no new copies of it, and its copies are left alone.
   */
  async setSources(sources: ReplicaSource[]): Promise<ReplicaSource[]> {
    return this.db.transaction().execute(async (tx) => {
      const existing = await tx
        .selectFrom('storage_replica_source')
        .select(['replicaBackendId', 'sourceBackendId'])
        .execute();
      const configured = new Set(sources.map((source) => toListingId(source)));
      const known = new Set(existing.map((source) => toListingId(source)));

      for (const source of existing) {
        if (configured.has(toListingId(source))) {
          continue;
        }
        await tx
          .deleteFrom('storage_replica_source')
          .where('replicaBackendId', '=', source.replicaBackendId)
          .where('sourceBackendId', '=', source.sourceBackendId)
          .execute();
      }
      const added = sources.filter((source) => !known.has(toListingId(source)));
      if (added.length > 0) {
        await tx.insertInto('storage_replica_source').values(added).execute();
      }
      return added;
    });
  }

  /**
   * Register copies of the originals on a backend that have none on a replica yet, a page of originals at a time after
   * `afterAssetId`: what was recorded before the replica was configured, or slipped past the trigger while it was being
   * configured. Returns the last original looked at, to continue after.
   */
  @GenerateSql({ params: [{ replicaBackendId: DummyValue.STRING, sourceBackendId: DummyValue.STRING }, 10_000] })
  async registerMissing(
    { replicaBackendId, sourceBackendId }: ReplicaSource,
    limit: number,
    afterAssetId?: string,
  ): Promise<{ registered: number; lastAssetId?: string }> {
    const { rows } = await sql<{ registered: string; lastAssetId: string | null }>`
      with "page" as (
        select "assetId", "key" from "asset_original_file"
        where "backendId" = ${sourceBackendId}
          ${afterAssetId ? sql`and "assetId" > ${afterAssetId}` : sql``}
        order by "assetId"
        limit ${limit}
      ), "registered" as (
        insert into "storage_replica_copy" ("replicaBackendId", "sourceBackendId", "key")
        select ${replicaBackendId}, ${sourceBackendId}, "key" from "page"
        on conflict do nothing
        returning 1
      )
      select
        (select count(*) from "registered") as "registered",
        (select "assetId" from "page" order by "assetId" desc limit 1) as "lastAssetId"
    `.execute(this.db);
    return { registered: Number(rows[0].registered), lastAssetId: rows[0].lastAssetId ?? undefined };
  }

  /**
   * Take copies that are due, the longest waiting first, for `leaseMs`: other workers skip them meanwhile. Only copies
   * to replicas that are configured to copy their backend are taken.
   */
  @GenerateSql({ params: [{ now: DummyValue.DATE, limit: 100, leaseMs: 600_000 }] })
  claim({ now, limit, leaseMs }: { now: Date; limit: number; leaseMs: number }): Promise<ReplicaCopy[]> {
    return this.db
      .updateTable('storage_replica_copy')
      .set({ leaseUntil: new Date(now.getTime() + leaseMs) })
      .where('id', 'in', (eb) =>
        eb
          .selectFrom('storage_replica_copy as copy')
          .innerJoin('storage_replica_source as source', (join) =>
            join
              .onRef('source.replicaBackendId', '=', 'copy.replicaBackendId')
              .onRef('source.sourceBackendId', '=', 'copy.sourceBackendId'),
          )
          .select('copy.id')
          .where('copy.completedAt', 'is', null)
          .where('copy.nextAttemptAt', '<=', now)
          .where((eb) => eb.or([eb('copy.leaseUntil', 'is', null), eb('copy.leaseUntil', '<', now)]))
          .orderBy('copy.nextAttemptAt')
          .limit(limit)
          .forUpdate()
          .skipLocked(),
      )
      .returning(['id', 'replicaBackendId', 'sourceBackendId', 'key', 'attempts'])
      .execute();
  }

  /** Record a copy as made; false if it is no longer registered (its file was deleted meanwhile) */
  @GenerateSql({ params: [DummyValue.UUID, 1000, DummyValue.DATE] })
  async complete(id: string, size: number, now: Date): Promise<boolean> {
    const { numUpdatedRows } = await this.db
      .updateTable('storage_replica_copy')
      .set({ completedAt: now, size, leaseUntil: null, lastError: null })
      .where('id', '=', id)
      .executeTakeFirst();
    return numUpdatedRows > 0n;
  }

  /** Note a failed copy and try again after a pause that doubles with every attempt, up to a day */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.STRING, DummyValue.DATE] })
  async recordFailure(id: string, error: string, now: Date) {
    await this.db
      .updateTable('storage_replica_copy')
      .set((eb) => ({
        attempts: eb('attempts', '+', 1),
        lastError: error,
        leaseUntil: null,
        nextAttemptAt: sql<Date>`${now}::timestamptz + make_interval(mins => least(1440, power(2, "attempts")::int))`,
      }))
      .where('id', '=', id)
      .execute();
  }

  /** Try failed copies to a replica again now */
  @GenerateSql({ params: [DummyValue.STRING, DummyValue.DATE] })
  async retryFailed(replicaBackendId: string, now: Date): Promise<number> {
    const { numUpdatedRows } = await this.db
      .updateTable('storage_replica_copy')
      .set({ nextAttemptAt: now })
      .where('replicaBackendId', '=', replicaBackendId)
      .where('completedAt', 'is', null)
      .where('attempts', '>', 0)
      .executeTakeFirst();
    return Number(numUpdatedRows);
  }

  @GenerateSql()
  async getStatus(): Promise<ReplicaStatus[]> {
    const rows = await this.db
      .selectFrom('storage_replica_copy')
      .select((eb) => [
        'replicaBackendId',
        eb.fn.countAll<string>().filterWhere('completedAt', 'is not', null).as('copied'),
        eb.fn.sum<string | null>('size').as('copiedBytes'),
        eb.fn.countAll<string>().filterWhere('completedAt', 'is', null).as('pending'),
        eb.fn
          .countAll<string>()
          .filterWhere((eb) => eb.and([eb('completedAt', 'is', null), eb('attempts', '>=', FAILING_COPY_ATTEMPTS)]))
          .as('failing'),
        eb.fn.min<Date | null>('createdAt').filterWhere('completedAt', 'is', null).as('oldestPendingAt'),
      ])
      .groupBy('replicaBackendId')
      .execute();
    return rows.map((row) => ({
      replicaBackendId: row.replicaBackendId,
      copied: Number(row.copied),
      copiedBytes: Number(row.copiedBytes ?? 0),
      pending: Number(row.pending),
      failing: Number(row.failing),
      oldestPendingAt: row.oldestPendingAt,
    }));
  }

  /** Copies that keep failing, with why, the ones tried most often first */
  @GenerateSql({ params: [DummyValue.STRING, 100] })
  getFailing(replicaBackendId: string, limit: number) {
    return this.db
      .selectFrom('storage_replica_copy')
      .select(['sourceBackendId', 'key', 'attempts', 'lastError', 'nextAttemptAt', 'createdAt'])
      .where('replicaBackendId', '=', replicaBackendId)
      .where('completedAt', 'is', null)
      .where('attempts', '>=', FAILING_COPY_ATTEMPTS)
      .orderBy('attempts', 'desc')
      .limit(limit)
      .execute();
  }

  /** Originals recorded on a backend, which a replica of it should have copies of */
  @GenerateSql({ params: [DummyValue.STRING] })
  async countSourceFiles(sourceBackendId: string): Promise<number> {
    const { count } = await this.db
      .selectFrom('asset_original_file')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('backendId', '=', sourceBackendId)
      .executeTakeFirstOrThrow();
    return Number(count);
  }

  /** The copies of these files, on any replica */
  @GenerateSql({ params: [[{ backendId: DummyValue.STRING, key: DummyValue.STRING }]] })
  async getCopiesOf(locations: StorageLocation[]) {
    if (locations.length === 0) {
      return [];
    }
    const { rows } = await sql<{ id: string; replicaBackendId: string; sourceBackendId: string; key: string }>`
      select "copy"."id", "copy"."replicaBackendId", "copy"."sourceBackendId", "copy"."key"
      from "storage_replica_copy" "copy"
      join (values ${sql.join(locations.map(({ backendId, key }) => sql`(${backendId}, ${key})`))})
        as "location" ("backendId", "key")
        on "copy"."sourceBackendId" = "location"."backendId" and "copy"."key" = "location"."key"
    `.execute(this.db);
    return rows;
  }

  @GenerateSql({ params: [[DummyValue.UUID]] })
  async remove(ids: string[]) {
    if (ids.length === 0) {
      return;
    }
    await this.db.deleteFrom('storage_replica_copy').where('id', 'in', ids).execute();
  }

  // reconciliation: the listing of the folder a replica keeps the copies of a backend in, compared with the copies

  /** Copies made before `madeBefore` that the listing did not have */
  @GenerateSql({
    params: [{ replicaBackendId: DummyValue.STRING, sourceBackendId: DummyValue.STRING }, DummyValue.DATE],
  })
  async findMissing(source: ReplicaSource, madeBefore: Date): Promise<FoundIssue[]> {
    const { rows } = await sql<FoundIssue>`
      select "copy"."key" from "storage_replica_copy" "copy"
      where "copy"."replicaBackendId" = ${source.replicaBackendId}
        and "copy"."sourceBackendId" = ${source.sourceBackendId}
        and "copy"."completedAt" < ${madeBefore}
        and not exists (
          select from "storage_listing" "listed"
          where "listed"."backendId" = ${toListingId(source)} and "listed"."key" = "copy"."key"
        )
      limit ${MAX_ISSUES_PER_RUN}
    `.execute(this.db);
    return rows;
  }

  /** Listed copies of another size than when they were made */
  @GenerateSql({ params: [{ replicaBackendId: DummyValue.STRING, sourceBackendId: DummyValue.STRING }] })
  async findSizeMismatches(source: ReplicaSource): Promise<FoundIssue[]> {
    const { rows } = await sql<{ key: string; size: string; listed: string }>`
      select "copy"."key", "copy"."size", "listed"."size" as "listed"
      from "storage_replica_copy" "copy"
      join "storage_listing" "listed" on "listed"."backendId" = ${toListingId(source)} and "listed"."key" = "copy"."key"
      where "copy"."replicaBackendId" = ${source.replicaBackendId}
        and "copy"."sourceBackendId" = ${source.sourceBackendId}
        and "copy"."completedAt" is not null
        and "listed"."size" <> "copy"."size"
      limit ${MAX_ISSUES_PER_RUN}
    `.execute(this.db);
    return rows.map(({ key, size, listed }) => ({ key, detail: `copied ${size} bytes, stored ${listed} bytes` }));
  }

  /** Listed objects written before `writtenBefore` that are no copy the replica is known to hold or to be getting */
  @GenerateSql({
    params: [{ replicaBackendId: DummyValue.STRING, sourceBackendId: DummyValue.STRING }, DummyValue.DATE],
  })
  async findUntracked(source: ReplicaSource, writtenBefore: Date): Promise<FoundIssue[]> {
    const { rows } = await sql<{ key: string; size: string }>`
      select "listed"."key", "listed"."size" from "storage_listing" "listed"
      where "listed"."backendId" = ${toListingId(source)}
        and "listed"."lastModified" < ${writtenBefore}
        and "listed"."key" not like ${`${STORAGE_PROBE_PREFIX}/%`}
        and not exists (
          select from "storage_replica_copy" "copy"
          where "copy"."replicaBackendId" = ${source.replicaBackendId}
            and "copy"."sourceBackendId" = ${source.sourceBackendId}
            and "copy"."key" = "listed"."key"
        )
      limit ${MAX_ISSUES_PER_RUN}
    `.execute(this.db);
    return rows.map(({ key, size }) => ({ key, detail: `${size} bytes` }));
  }

  /** Copy again what a reconciliation found missing or changed on a replica */
  @GenerateSql({
    params: [
      { replicaBackendId: DummyValue.STRING, sourceBackendId: DummyValue.STRING },
      [DummyValue.STRING],
      DummyValue.DATE,
    ],
  })
  /** How many copies of a source a replica holds */
  @GenerateSql({ params: [{ replicaBackendId: DummyValue.STRING, sourceBackendId: DummyValue.STRING }] })
  async countCopies(source: ReplicaSource): Promise<number> {
    const { count } = await this.db
      .selectFrom('storage_replica_copy')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('replicaBackendId', '=', source.replicaBackendId)
      .where('sourceBackendId', '=', source.sourceBackendId)
      .where('completedAt', 'is not', null)
      .executeTakeFirstOrThrow();
    return Number(count);
  }

  /** Copies of a source that a replica holds, picked at random */
  @GenerateSql({ params: [{ replicaBackendId: DummyValue.STRING, sourceBackendId: DummyValue.STRING }, 100] })
  sampleCopies(source: ReplicaSource, limit: number) {
    return this.db
      .selectFrom('storage_replica_copy')
      .select(['key', 'size'])
      .where('replicaBackendId', '=', source.replicaBackendId)
      .where('sourceBackendId', '=', source.sourceBackendId)
      .where('completedAt', 'is not', null)
      .orderBy(sql`random()`)
      .limit(limit)
      .execute();
  }

  async requeue(source: ReplicaSource, keys: string[], now: Date) {
    if (keys.length === 0) {
      return;
    }
    await this.db
      .updateTable('storage_replica_copy')
      .set({ completedAt: null, size: null, attempts: 0, nextAttemptAt: now, leaseUntil: null, lastError: null })
      .where('replicaBackendId', '=', source.replicaBackendId)
      .where('sourceBackendId', '=', source.sourceBackendId)
      .where('key', 'in', keys)
      .execute();
  }
}
