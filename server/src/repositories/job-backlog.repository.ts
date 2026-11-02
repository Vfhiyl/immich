import { Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { GenerateSql } from 'src/decorators.js';
import { JobName, QueueName } from 'src/enum.js';
import { DB } from 'src/schema/index.js';

export type BacklogJob = { name: JobName; data: unknown; priority: number };

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

/** Jobs waiting in the database for room in their queue (see `JobRepository.queueAll`) */
@Injectable()
export class JobBacklogRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /**
   * Adds jobs to the backlog of a queue, each with its turn among the jobs of its user: the user of its asset (`data.id`)
   * or its owner (`data.ownerId`), else of no one (who is one user too). A user's jobs take the turns after those it has
   * in the backlog, from the turn of the next job to come out at the earliest: one who comes takes turns with those
   * who wait
   */
  @GenerateSql({
    params: [QueueName.ThumbnailGeneration, [{ name: JobName.AssetGenerateThumbnails, data: {}, priority: 0 }]],
  })
  async add(queueName: QueueName, jobs: BacklogJob[]): Promise<void> {
    if (jobs.length === 0) {
      return;
    }
    const ownerOf = await this.getOwners(jobs);
    // the turn of the next job to come out
    const next = await this.db
      .selectFrom('job_backlog')
      .select('turn')
      .where('queueName', '=', queueName)
      .orderBy('priority')
      .orderBy('turn')
      .orderBy('id')
      .limit(1)
      .executeTakeFirst();
    const head = Number(next?.turn ?? 1);
    const owners = [...new Set(jobs.map((job) => ownerOf(job)))];
    const last = new Map<string | null, number>();
    for (const ownerId of owners) {
      const row = await this.db
        .selectFrom('job_backlog')
        .select((eb) => eb.fn.max('turn').as('last'))
        .where('queueName', '=', queueName)
        .where((eb) => (ownerId === null ? eb('ownerId', 'is', null) : eb('ownerId', '=', ownerId)))
        .executeTakeFirst();
      last.set(ownerId, Math.max(Number(row?.last ?? 0), head - 1));
    }
    await this.db
      .insertInto('job_backlog')
      .values(
        jobs.map((job) => {
          const ownerId = ownerOf(job);
          const turn = last.get(ownerId)! + 1;
          last.set(ownerId, turn);
          return { queueName, name: job.name, data: job.data, priority: job.priority, ownerId, turn };
        }),
      )
      .execute();
  }

  /** The user each job is for: of its asset (`data.id`), or its owner (`data.ownerId`), or none */
  private async getOwners(jobs: BacklogJob[]) {
    const field = (job: BacklogJob, key: string) => {
      const value = (job.data as Record<string, unknown> | null)?.[key];
      return typeof value === 'string' && UUID.test(value) ? value : undefined;
    };
    const assetIds = [...new Set(jobs.map((job) => field(job, 'id')).filter((id): id is string => !!id))];
    const owners = new Map<string, string>();
    if (assetIds.length > 0) {
      const rows = await this.db.selectFrom('asset').select(['id', 'ownerId']).where('id', 'in', assetIds).execute();
      for (const { id, ownerId } of rows) {
        owners.set(id, ownerId);
      }
    }
    return (job: BacklogJob) => {
      const id = field(job, 'id');
      return (id && owners.get(id)) ?? field(job, 'ownerId') ?? null;
    };
  }

  /**
   * Hands the next jobs of a queue to `use`, those without priority first, then the lowest, the users taking turns, each
   * in the order they came; they leave the backlog once it resolved (should the process stop meanwhile, they are
   * handed over again)
   */
  async take(queueName: QueueName, limit: number, use: (jobs: BacklogJob[]) => Promise<void>): Promise<number> {
    return this.db.transaction().execute(async (trx) => {
      const rows = await trx
        .selectFrom('job_backlog')
        .select(['id', 'name', 'data', 'priority'])
        .where('queueName', '=', queueName)
        .orderBy('priority')
        .orderBy('turn')
        .orderBy('id')
        .limit(limit)
        .forUpdate()
        .skipLocked()
        .execute();
      if (rows.length === 0) {
        return 0;
      }
      await use(rows.map(({ name, data, priority }) => ({ name: name as JobName, data, priority })));
      await trx
        .deleteFrom('job_backlog')
        .where(
          'id',
          'in',
          rows.map(({ id }) => id),
        )
        .execute();
      return rows.length;
    });
  }

  @GenerateSql({ params: [QueueName.ThumbnailGeneration] })
  async has(queueName: QueueName): Promise<boolean> {
    const row = await this.db
      .selectFrom('job_backlog')
      .select('id')
      .where('queueName', '=', queueName)
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  @GenerateSql({ params: [QueueName.ThumbnailGeneration] })
  async count(queueName: QueueName): Promise<number> {
    const { count } = await this.db
      .selectFrom('job_backlog')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('queueName', '=', queueName)
      .executeTakeFirstOrThrow();
    return count;
  }

  @GenerateSql({ params: [QueueName.ThumbnailGeneration] })
  async clear(queueName: QueueName): Promise<void> {
    await this.db.deleteFrom('job_backlog').where('queueName', '=', queueName).execute();
  }
}
