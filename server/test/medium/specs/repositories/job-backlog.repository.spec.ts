import { Kysely } from 'kysely';
import { setTimeout } from 'node:timers/promises';
import { JobName, QueueName } from 'src/enum.js';
import { BacklogJob, JobBacklogRepository } from 'src/repositories/job-backlog.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getTestKyselyDB } from 'test/utils.js';

const job = (id: string, priority = 0): BacklogJob => ({ name: JobName.SmartSearch, data: { id }, priority });

const setup = async () => {
  const db: Kysely<DB> = await getTestKyselyDB();
  return { db, sut: new JobBacklogRepository(db) };
};

describe(JobBacklogRepository.name, () => {
  it('should hand the jobs over without priority first, then the lowest, each in the order they came', async () => {
    const { sut } = await setup();
    // in the order they came, to the millisecond
    for (const jobs of [[job('stale', 20), job('missing', 10)], [job('new-1'), job('missing-2', 10)], [job('new-2')]]) {
      await sut.add(QueueName.SmartSearch, jobs);
      await setTimeout(5);
    }
    await sut.add(QueueName.ThumbnailGeneration, [job('other')]);

    const taken: BacklogJob[] = [];
    await expect(sut.take(QueueName.SmartSearch, 4, (jobs) => Promise.resolve(void taken.push(...jobs)))).resolves.toBe(
      4,
    );

    expect(taken.map(({ data }) => (data as { id: string }).id)).toEqual(['new-1', 'new-2', 'missing', 'missing-2']);
    expect(taken[2]).toEqual(job('missing', 10));
    await expect(sut.count(QueueName.SmartSearch)).resolves.toBe(1);
    await expect(sut.has(QueueName.ThumbnailGeneration)).resolves.toBe(true);
  });

  it('should let users take turns: one who uploads many photos does not hold back those of others', async () => {
    const { db, sut } = await setup();
    const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
    const [{ user: many }, { user: few }] = [await ctx.newUser(), await ctx.newUser()];
    const assetsOf = async (ownerId: string, count: number) => {
      const ids: string[] = [];
      for (let index = 0; index < count; index++) {
        const { asset } = await ctx.newAsset({ ownerId });
        ids.push(asset.id);
      }
      return ids;
    };
    const [manyIds, fewIds] = [await assetsOf(many.id, 6), await assetsOf(few.id, 2)];
    const label = new Map([
      ...manyIds.map((id, index) => [id, `many-${index}`] as const),
      ...fewIds.map((id, index) => [id, `few-${index}`] as const),
    ]);

    await sut.add(
      QueueName.SmartSearch,
      manyIds.map((id) => job(id)),
    );
    // two come out, then the other user uploads
    await sut.take(QueueName.SmartSearch, 2, () => Promise.resolve());
    await sut.add(
      QueueName.SmartSearch,
      fewIds.map((id) => job(id)),
    );
    // and a job of no user (a person's thumbnail is for its owner)
    await sut.add(QueueName.SmartSearch, [
      { name: JobName.PersonGenerateThumbnail, data: { ownerId: few.id }, priority: 0 },
    ]);

    const taken: string[] = [];
    await sut.take(QueueName.SmartSearch, 10, (jobs) => {
      for (const { data } of jobs) {
        const { id } = data as { id?: string };
        taken.push(id ? label.get(id)! : 'person');
      }
      return Promise.resolve();
    });

    expect(taken).toEqual(['many-2', 'few-0', 'many-3', 'few-1', 'many-4', 'person', 'many-5']);
  });

  it('should keep the jobs when they could not be queued', async () => {
    const { sut } = await setup();
    await sut.add(QueueName.SmartSearch, [job('a'), job('b')]);

    await expect(sut.take(QueueName.SmartSearch, 10, () => Promise.reject(new Error('redis is gone')))).rejects.toThrow(
      'redis is gone',
    );

    await expect(sut.count(QueueName.SmartSearch)).resolves.toBe(2);
  });

  it('should empty the backlog of a queue', async () => {
    const { sut } = await setup();
    await sut.add(QueueName.SmartSearch, [job('a')]);
    await sut.add(QueueName.Ocr, [job('b')]);

    await sut.clear(QueueName.SmartSearch);

    await expect(sut.has(QueueName.SmartSearch)).resolves.toBe(false);
    await expect(sut.count(QueueName.Ocr)).resolves.toBe(1);
  });
});
