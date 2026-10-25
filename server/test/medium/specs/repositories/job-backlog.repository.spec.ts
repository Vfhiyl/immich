import { Kysely } from 'kysely';
import { setTimeout } from 'node:timers/promises';
import { JobName, QueueName } from 'src/enum.js';
import { BacklogJob, JobBacklogRepository } from 'src/repositories/job-backlog.repository.js';
import { DB } from 'src/schema/index.js';
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
