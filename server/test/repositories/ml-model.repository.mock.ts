import { randomUUID } from 'node:crypto';
import { Mocked, vitest } from 'vitest';
import type { RepositoryInterface } from 'src/types.js';
import { MachineLearningModelRepository } from 'src/repositories/ml-model.repository.js';

type Model = Awaited<ReturnType<MachineLearningModelRepository['create']>>;

/**
 * Keeps the models and the results of photos in memory, so that services record and find them as with a database;
 * nothing is rebuilt (no photos to select) unless a test says so
 */
export const newMachineLearningModelRepositoryMock = (): Mocked<
  RepositoryInterface<MachineLearningModelRepository>
> => {
  const models: Model[] = [];
  const results = new Map<string, string>();
  const find = (task: string, name: string, fingerprint: string | null) =>
    models.find((model) => model.task === task && model.name === name && model.fingerprint === fingerprint);

  return {
    get: vitest.fn((id: string) => Promise.resolve(models.find((model) => model.id === id))),
    find: vitest.fn((task: string, name: string, fingerprint: string | null) =>
      Promise.resolve(find(task, name, fingerprint)),
    ),
    getAll: vitest.fn((task: string) => Promise.resolve(models.filter((model) => model.task === task))),
    create: vitest.fn(({ task, name, fingerprint, format }) => {
      let model = find(task, name, fingerprint);
      if (!model) {
        const now = new Date() as unknown as Model['createdAt'];
        model = { id: randomUUID(), task, name, fingerprint, format, createdAt: now, lastSeenAt: now, retiredAt: null };
        models.push(model);
      }
      return Promise.resolve(model);
    }),
    update: vitest.fn((id: string, values: Partial<Model>) => {
      Object.assign(
        models.find((model) => model.id === id)!,
        values,
      );
      return Promise.resolve();
    }),
    getResult: vitest.fn((assetId: string, task: string) => Promise.resolve(results.get(`${assetId}/${task}`) ?? null)),
    setResult: vitest.fn((assetId: string, task: string, modelId: string) => {
      results.set(`${assetId}/${task}`, modelId);
      return Promise.resolve();
    }),
    streamForRebuild: vitest.fn(() => (async function* () {})()),
    getProgress: vitest.fn().mockResolvedValue({ total: 0, done: 0 }),
    upsertRebuildEmbedding: vitest.fn().mockResolvedValue(undefined),
    deleteRebuildEmbeddings: vitest.fn().mockResolvedValue(undefined),
    switchSmartSearch: vitest.fn().mockResolvedValue(undefined),
    snapshotFaceAssignments: vitest.fn().mockResolvedValue(undefined),
    getPeopleToRegroup: vitest.fn().mockResolvedValue([]),
    getFacesToRegroup: vitest.fn().mockResolvedValue([]),
    getCloseFacePairs: vitest.fn().mockResolvedValue([]),
    getNearFacePairs: vitest.fn().mockResolvedValue([]),
    getPeopleWithPicture: vitest.fn().mockResolvedValue([]),
    takeFromPerson: vitest.fn().mockResolvedValue(undefined),
    getRegroupChanges: vitest.fn().mockResolvedValue([]),
    undoRegroup: vitest.fn().mockResolvedValue(0),
  } as unknown as Mocked<RepositoryInterface<MachineLearningModelRepository>>;
};
