import { Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { GenerateSql } from 'src/decorators.js';
import { JobName, QueueName } from 'src/enum.js';
import { DB } from 'src/schema/index.js';

export type BacklogJob = { name: JobName; data: unknown; priority: number };

/** Jobs waiting in the database for room in their queue (see `JobRepository.queueAll`) */
@Injectable()
export class JobBacklogRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({
    params: [QueueName.ThumbnailGeneration, [{ name: JobName.AssetGenerateThumbnails, data: {}, priority: 0 }]],
  })
  async add(queueName: QueueName, jobs: BacklogJob[]): Promise<void> {
    if (jobs.length === 0) {
      return;
    }
    await this.db
      .insertInto('job_backlog')
      .values(jobs.map(({ name, data, priority }) => ({ queueName, name, data, priority })))
      .execute();
  }

  /**
   * Hands the next jobs of a queue to `use`, those without priority first, then the lowest, each in the order they came;
   * they leave the backlog once it resolved (should the process stop meanwhile, they are handed over again)
   */
  async take(queueName: QueueName, limit: number, use: (jobs: BacklogJob[]) => Promise<void>): Promise<number> {
    return this.db.transaction().execute(async (trx) => {
      const rows = await trx
        .selectFrom('job_backlog')
        .select(['id', 'name', 'data', 'priority'])
        .where('queueName', '=', queueName)
        .orderBy('priority')
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
