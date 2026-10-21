import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { StorageCheckStats } from 'src/schema/tables/storage-check.table.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { StorageCheckKind, StorageCheckStatus, StorageIssueKind } from 'src/enum.js';
import { STORAGE_PROBE_PREFIX } from 'src/repositories/storage-backend.repository.js';
import { DB } from 'src/schema/index.js';

/** Issues of one kind that a run reports at most, so that a broken backend does not fill the database */
export const MAX_ISSUES_PER_RUN = 10_000;

/** Bytes an encrypted blob holds besides its content, chunk tags apart: the trailer, at least and at most */
const MIN_TRAILER_BYTES = 66 + 16 + 4 + 40;
const MAX_TRAILER_BYTES = 1024 * 1024 + 4;

export interface ListedBlob {
  key: string;
  size: number;
  lastModified: Date;
}

export interface FoundIssue {
  key: string;
  detail?: string;
}

/** Every file location that is recorded, of the four tables that record them */
const recordedLocations = sql`(
  select "backendId", "key", "size", "checksum", "encryption", "encryption" is not null as "isEncrypted", "createdAt"
  from "asset_file"
  union all
  select "backendId", "key", "size", "checksum", "encryption", "encryption" is not null, "createdAt"
  from "asset_original_file"
  union all
  select "backendId", "key", "size", "checksum", "encryption", "encryption" is not null, "createdAt"
  from "person_thumbnail_file"
  union all
  select "backendId", "key", "size", "checksum", "encryption", "encryption" is not null, "createdAt"
  from "user_profile_image_file"
)`;

/** A recorded file with what reading it back is checked against */
export interface VerifiableFile {
  backendId: string;
  key: string;
  size: number | null;
  checksum: Buffer | null;
  encryption: Buffer | null;
}

@Injectable()
export class StorageCheckRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  startRun(kind: StorageCheckKind, backends: string[]) {
    return this.db
      .insertInto('storage_check_run')
      .values({
        kind,
        status: StorageCheckStatus.Running,
        stats: { backends, checked: 0, bytes: 0, newIssues: 0, openIssues: 0 },
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID, StorageCheckStatus.Ok, {}] })
  async finishRun(id: string, status: StorageCheckStatus, stats: StorageCheckStats) {
    await this.db
      .updateTable('storage_check_run')
      .set({ status, stats, finishedAt: new Date() })
      .where('id', '=', id)
      .execute();
  }

  @GenerateSql({ params: [StorageCheckKind.Reconcile] })
  getLastRun(kind: StorageCheckKind) {
    return this.db
      .selectFrom('storage_check_run')
      .selectAll()
      .where('kind', '=', kind)
      .orderBy('startedAt', 'desc')
      .limit(1)
      .executeTakeFirst();
  }

  // reconciliation: the listing of a backend, compared with what is recorded

  @GenerateSql({ params: [DummyValue.STRING] })
  async clearListing(backendId: string) {
    await this.db.deleteFrom('storage_listing').where('backendId', '=', backendId).execute();
  }

  async addToListing(backendId: string, blobs: ListedBlob[]) {
    if (blobs.length === 0) {
      return;
    }
    await this.db
      .insertInto('storage_listing')
      .values(blobs.map(({ key, size, lastModified }) => ({ backendId, key, size, lastModified })))
      .onConflict((oc) => oc.columns(['backendId', 'key']).doNothing())
      .execute();
  }

  /** Recorded files the listing did not have, recorded before `recordedBefore` */
  @GenerateSql({ params: [DummyValue.STRING, DummyValue.DATE] })
  async findMissing(backendId: string, recordedBefore: Date): Promise<FoundIssue[]> {
    const { rows } = await sql<FoundIssue>`
      select "recorded"."key" from ${recordedLocations} as "recorded"
      where "recorded"."backendId" = ${backendId}
        and "recorded"."createdAt" < ${recordedBefore}
        and not exists (
          select from "storage_listing" "listed"
          where "listed"."backendId" = "recorded"."backendId" and "listed"."key" = "recorded"."key"
        )
      limit ${MAX_ISSUES_PER_RUN}
    `.execute(this.db);
    return rows;
  }

  /**
   * Listed files whose size is not the recorded one: exactly that size, or for an encrypted file the encrypted chunks of
   * that size and a trailer
   */
  @GenerateSql({ params: [DummyValue.STRING] })
  async findSizeMismatches(backendId: string): Promise<FoundIssue[]> {
    const { rows } = await sql<{ key: string; size: string; listed: string }>`
      select "recorded"."key", "recorded"."size", "listed"."size" as "listed"
      from ${recordedLocations} as "recorded"
      join "storage_listing" "listed"
        on "listed"."backendId" = "recorded"."backendId" and "listed"."key" = "recorded"."key"
      where "recorded"."backendId" = ${backendId}
        and "recorded"."size" is not null
        and case
          when "recorded"."isEncrypted" then
            "listed"."size" < "recorded"."size" + greatest(1, ceil("recorded"."size" / 65536.0)) * 16 + ${MIN_TRAILER_BYTES}
            or "listed"."size" > "recorded"."size" + greatest(1, ceil("recorded"."size" / 65536.0)) * 16 + ${MAX_TRAILER_BYTES}
          else "listed"."size" <> "recorded"."size"
        end
      limit ${MAX_ISSUES_PER_RUN}
    `.execute(this.db);
    return rows.map(({ key, size, listed }) => ({ key, detail: `recorded ${size} bytes, stored ${listed} bytes` }));
  }

  /**
   * Listed files that nothing records, written before `writtenBefore`: no location, no pending deletion, no upload
   * being received, and not the probe of the startup check
   */
  @GenerateSql({ params: [DummyValue.STRING, DummyValue.DATE] })
  async findUntracked(backendId: string, writtenBefore: Date): Promise<FoundIssue[]> {
    const { rows } = await sql<{ key: string; size: string }>`
      select "listed"."key", "listed"."size" from "storage_listing" "listed"
      where "listed"."backendId" = ${backendId}
        and "listed"."lastModified" < ${writtenBefore}
        and "listed"."key" not like ${`${STORAGE_PROBE_PREFIX}/%`}
        and not exists (
          select from ${recordedLocations} as "recorded"
          where "recorded"."backendId" = "listed"."backendId" and "recorded"."key" = "listed"."key"
        )
        and not exists (
          select from "storage_deletion" "deletion"
          where "deletion"."backendId" = "listed"."backendId" and "deletion"."key" = "listed"."key"
        )
        and not exists (
          select from "upload_session" "upload"
          where "upload"."backendId" = "listed"."backendId" and "upload"."key" = "listed"."key"
        )
      limit ${MAX_ISSUES_PER_RUN}
    `.execute(this.db);
    return rows.map(({ key, size }) => ({ key, detail: `${size} bytes` }));
  }

  // verification: reading files back, the ones that failed first, then the ones never verified, then the oldest

  @GenerateSql({ params: [[DummyValue.STRING], DummyValue.DATE] })
  async countVerifiable(backendIds: string[], recordedBefore: Date): Promise<number> {
    const { rows } = await sql<{ count: string }>`
      select count(*) from ${recordedLocations} as "recorded"
      where "recorded"."backendId" in (${sql.join(backendIds)}) and "recorded"."createdAt" < ${recordedBefore}
    `.execute(this.db);
    return Number(rows[0].count);
  }

  /** Files whose last verification failed before `before` (when the run began), so they are tried again first */
  @GenerateSql({ params: [[DummyValue.STRING], DummyValue.DATE, 100] })
  getFailedVerifications(backendIds: string[], before: Date, limit: number) {
    return this.db
      .selectFrom('storage_verification')
      .select(['backendId', 'key'])
      .where('backendId', 'in', backendIds)
      .where('ok', '=', false)
      .where('verifiedAt', '<', before)
      .orderBy('verifiedAt')
      .limit(limit)
      .execute();
  }

  @GenerateSql({ params: [[DummyValue.STRING], DummyValue.DATE, 100] })
  async getUnverified(backendIds: string[], recordedBefore: Date, limit: number): Promise<VerifiableFile[]> {
    const { rows } = await sql<VerifiableFile>`
      select "recorded"."backendId", "recorded"."key", "recorded"."size", "recorded"."checksum", "recorded"."encryption"
      from ${recordedLocations} as "recorded"
      where "recorded"."backendId" in (${sql.join(backendIds)})
        and "recorded"."createdAt" < ${recordedBefore}
        and not exists (
          select from "storage_verification" "verification"
          where "verification"."backendId" = "recorded"."backendId" and "verification"."key" = "recorded"."key"
        )
      limit ${limit}
    `.execute(this.db);
    return rows;
  }

  @GenerateSql({ params: [[DummyValue.STRING], DummyValue.DATE, 100] })
  getOldestVerified(backendIds: string[], before: Date, limit: number) {
    return this.db
      .selectFrom('storage_verification')
      .select(['backendId', 'key'])
      .where('backendId', 'in', backendIds)
      .where('ok', '=', true)
      .where('verifiedAt', '<', before)
      .orderBy('verifiedAt')
      .limit(limit)
      .execute();
  }

  /** What is recorded about files of a backend; files that are no longer recorded are left out */
  @GenerateSql({ params: [DummyValue.STRING, [DummyValue.STRING]] })
  async getRecordedFiles(backendId: string, keys: string[]): Promise<VerifiableFile[]> {
    if (keys.length === 0) {
      return [];
    }
    const { rows } = await sql<VerifiableFile>`
      select "recorded"."backendId", "recorded"."key", "recorded"."size", "recorded"."checksum", "recorded"."encryption"
      from ${recordedLocations} as "recorded"
      where "recorded"."backendId" = ${backendId} and "recorded"."key" in (${sql.join(keys)})
    `.execute(this.db);
    return rows;
  }

  @GenerateSql({ params: [DummyValue.STRING, DummyValue.STRING, true, DummyValue.DATE] })
  async recordVerification(backendId: string, key: string, ok: boolean, verifiedAt: Date) {
    await this.db
      .insertInto('storage_verification')
      .values({ backendId, key, ok, verifiedAt })
      .onConflict((oc) => oc.columns(['backendId', 'key']).doUpdateSet({ ok, verifiedAt }))
      .execute();
  }

  /** Forget the verification of files that are no longer recorded */
  @GenerateSql({ params: [DummyValue.STRING, [DummyValue.STRING]] })
  async removeVerifications(backendId: string, keys: string[]) {
    if (keys.length === 0) {
      return;
    }
    await this.db
      .deleteFrom('storage_verification')
      .where('backendId', '=', backendId)
      .where('key', 'in', keys)
      .execute();
  }

  // issues

  /**
   * Note issues a run saw: a new one is a candidate, one seen before is confirmed (and reported) the second time.
   * Resolves to the number of issues that this confirmed.
   */
  async recordSightings(backendId: string, kind: StorageIssueKind, issues: FoundIssue[], now: Date): Promise<number> {
    if (issues.length === 0) {
      return 0;
    }

    const rows = await this.db
      .insertInto('storage_issue')
      .values(issues.map(({ key, detail }) => ({ backendId, key, kind, detail: detail ?? null, lastSeenAt: now })))
      .onConflict((oc) =>
        oc
          .columns(['backendId', 'key', 'kind'])
          .where('resolvedAt', 'is', null)
          .doUpdateSet((eb) => ({
            sightings: eb('storage_issue.sightings', '+', 1),
            lastSeenAt: now,
            detail: eb.ref('excluded.detail'),
            confirmedAt: eb.fn.coalesce('storage_issue.confirmedAt', eb.val(now)),
          })),
      )
      .returning(['confirmedAt'])
      .execute();
    return rows.filter(({ confirmedAt }) => confirmedAt?.getTime() === now.getTime()).length;
  }

  /** Resolve open issues of these kinds that a run that began at `runStartedAt` no longer saw */
  @GenerateSql({ params: [DummyValue.STRING, [StorageIssueKind.Missing], DummyValue.DATE] })
  async resolveUnseen(backendId: string, kinds: StorageIssueKind[], runStartedAt: Date) {
    await this.db
      .updateTable('storage_issue')
      .set({ resolvedAt: new Date() })
      .where('backendId', '=', backendId)
      .where('kind', 'in', kinds)
      .where('resolvedAt', 'is', null)
      .where('lastSeenAt', '<', runStartedAt)
      .execute();
  }

  @GenerateSql({ params: [DummyValue.STRING, DummyValue.STRING, [StorageIssueKind.Corrupt]] })
  async resolveIssues(backendId: string, key: string, kinds: StorageIssueKind[]) {
    await this.db
      .updateTable('storage_issue')
      .set({ resolvedAt: new Date() })
      .where('backendId', '=', backendId)
      .where('key', '=', key)
      .where('kind', 'in', kinds)
      .where('resolvedAt', 'is', null)
      .execute();
  }

  /** Issues that are reported (confirmed) and not resolved */
  @GenerateSql()
  async countOpenIssues(): Promise<number> {
    const { count } = await this.db
      .selectFrom('storage_issue')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('confirmedAt', 'is not', null)
      .where('resolvedAt', 'is', null)
      .executeTakeFirstOrThrow();
    return Number(count);
  }

  // the report center

  /** Runs, the newest first, a page before `before` */
  @GenerateSql({ params: [{ limit: 50 }] })
  getRuns({ kind, before, limit }: { kind?: StorageCheckKind; before?: Date; limit: number }) {
    return this.db
      .selectFrom('storage_check_run')
      .selectAll()
      .$if(!!kind, (qb) => qb.where('kind', '=', kind!))
      .$if(!!before, (qb) => qb.where('startedAt', '<', before!))
      .orderBy('startedAt', 'desc')
      .limit(limit)
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getRun(id: string) {
    return this.db.selectFrom('storage_check_run').selectAll().where('id', '=', id).executeTakeFirst();
  }

  /** Reported issues, the most recently seen first, a page after `after` */
  @GenerateSql({ params: [{ status: 'open', limit: 50 }] })
  getIssues({ status, kind, backendId, after, limit }: IssueQuery) {
    return this.db
      .selectFrom('storage_issue')
      .selectAll()
      .where('confirmedAt', 'is not', null)
      .$if(status === 'open', (qb) => qb.where('resolvedAt', 'is', null))
      .$if(status === 'resolved', (qb) => qb.where('resolvedAt', 'is not', null))
      .$if(!!kind, (qb) => qb.where('kind', '=', kind!))
      .$if(!!backendId, (qb) => qb.where('backendId', '=', backendId!))
      .$if(!!after, (qb) =>
        qb.where((eb) => eb(eb.refTuple('lastSeenAt', 'id'), '<', eb.tuple(after!.lastSeenAt, after!.id))),
      )
      .orderBy('lastSeenAt', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async acknowledgeIssue(id: string) {
    const result = await this.db
      .updateTable('storage_issue')
      .set({ acknowledgedAt: new Date() })
      .where('id', '=', id)
      .where('confirmedAt', 'is not', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  @GenerateSql()
  async countOpenIssuesByKind(): Promise<Partial<Record<StorageIssueKind, number>>> {
    const rows = await this.db
      .selectFrom('storage_issue')
      .select(['kind', (eb) => eb.fn.countAll<number>().as('count')])
      .where('confirmedAt', 'is not', null)
      .where('resolvedAt', 'is', null)
      .groupBy('kind')
      .execute();
    return Object.fromEntries(rows.map(({ kind, count }) => [kind, Number(count)]));
  }

  /** Per month since `since`: runs, runs that found issues, issues reported and resolved, bytes read back */
  @GenerateSql({ params: [DummyValue.DATE] })
  async getMonthlySummary(since: Date): Promise<MonthlySummary[]> {
    const { rows } = await sql<Record<keyof MonthlySummary, string>>`
      with "months" as (
        select generate_series(date_trunc('month', ${since}::timestamptz), date_trunc('month', now()), interval '1 month') as "month"
      )
      select
        to_char("months"."month", 'YYYY-MM') as "month",
        (select count(*) from "storage_check_run" r
          where date_trunc('month', r."startedAt") = "months"."month") as "runs",
        (select count(*) from "storage_check_run" r
          where date_trunc('month', r."startedAt") = "months"."month" and r."status" in ('issues', 'failed')) as "runsWithProblems",
        (select coalesce(sum((r."stats"->>'bytes')::bigint), 0) from "storage_check_run" r
          where date_trunc('month', r."startedAt") = "months"."month" and r."kind" = 'verify') as "bytesVerified",
        (select count(*) from "storage_issue" i
          where date_trunc('month', i."confirmedAt") = "months"."month") as "issuesReported",
        (select count(*) from "storage_issue" i
          where i."confirmedAt" is not null and date_trunc('month', i."resolvedAt") = "months"."month") as "issuesResolved"
      from "months"
      order by "months"."month"
    `.execute(this.db);
    return rows.map((row) => ({
      month: row.month,
      runs: Number(row.runs),
      runsWithProblems: Number(row.runsWithProblems),
      bytesVerified: Number(row.bytesVerified),
      issuesReported: Number(row.issuesReported),
      issuesResolved: Number(row.issuesResolved),
    }));
  }

  /** Forget runs, and issues resolved, before `before` (reports are kept for three years) */
  @GenerateSql({ params: [DummyValue.DATE] })
  async removeOldReports(before: Date) {
    await this.db.deleteFrom('storage_check_run').where('startedAt', '<', before).execute();
    await this.db.deleteFrom('storage_issue').where('resolvedAt', '<', before).execute();
  }
}

export interface IssueQuery {
  status?: 'open' | 'resolved' | 'all';
  kind?: StorageIssueKind;
  backendId?: string;
  after?: { lastSeenAt: Date; id: string };
  limit: number;
}

export interface MonthlySummary {
  /** As YYYY-MM */
  month: string;
  runs: number;
  runsWithProblems: number;
  bytesVerified: number;
  issuesReported: number;
  issuesResolved: number;
}
