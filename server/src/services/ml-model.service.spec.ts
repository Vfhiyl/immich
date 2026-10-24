import { SystemConfig, defaults } from 'src/dtos/config.dto.js';
import { ImmichWorker, JobName, JobStatus, QueueName, SystemMetadataKey } from 'src/enum.js';
import { ModelTask } from 'src/repositories/machine-learning.repository.js';
import { MachineLearningModelService } from 'src/services/ml-model.service.js';
import { MachineLearningModelsState, REBUILD_PRIORITY } from 'src/utils/ml-models.js';
import { ServiceMocks, makeStream, newTestService } from 'test/utils.js';

const counts = (pending: Partial<Record<'waiting' | 'active' | 'delayed' | 'paused', number>> = {}) => ({
  active: 0,
  completed: 0,
  failed: 0,
  delayed: 0,
  waiting: 0,
  paused: 0,
  ...pending,
});

describe(MachineLearningModelService.name, () => {
  let sut: MachineLearningModelService;
  let mocks: ServiceMocks;
  let state: MachineLearningModelsState | undefined;
  let config: SystemConfig;

  const withModel = (task: 'clip' | 'facialRecognition' | 'ocr', modelName: string): SystemConfig => ({
    ...config,
    machineLearning: { ...config.machineLearning, [task]: { ...config.machineLearning[task], modelName } },
  });

  beforeEach(() => {
    ({ sut, mocks } = newTestService(MachineLearningModelService));
    mocks.config.getWorker.mockReturnValue(ImmichWorker.Microservices);
    config = structuredClone(defaults) as SystemConfig;
    state = undefined;
    vi.mocked(mocks.systemMetadata.get as (key: SystemMetadataKey) => Promise<unknown>).mockImplementation((key) =>
      Promise.resolve(key === SystemMetadataKey.MachineLearningModels ? state : undefined),
    );
    mocks.systemMetadata.set.mockImplementation((_key, value) => {
      state = structuredClone(value) as MachineLearningModelsState;
      return Promise.resolve();
    });
    mocks.job.getJobCounts.mockResolvedValue(counts());
    mocks.database.getDimensionSize.mockResolvedValue(512);
  });

  /** As the server finds it: the results made with `config`, then the faces model changed to antelopev2 */
  const startFaceRebuild = async () => {
    await sut.onConfigInit({ newConfig: config });
    await sut.onConfigUpdate({ newConfig: withModel('facialRecognition', 'antelopev2'), oldConfig: config });
    vi.mocked(mocks.systemMetadata.get as (key: SystemMetadataKey) => Promise<unknown>).mockImplementation((key) =>
      Promise.resolve(
        key === SystemMetadataKey.MachineLearningModels
          ? state
          : key === SystemMetadataKey.SystemConfig
            ? { machineLearning: { facialRecognition: { modelName: 'antelopev2' } } }
            : undefined,
      ),
    );
    mocks.job.queue.mockClear();
    return state![ModelTask.FACIAL_RECOGNITION]!.generation;
  };

  describe('following the configuration', () => {
    it('should record the models as the server starts, without making anything again', async () => {
      await sut.onConfigInit({ newConfig: config });

      expect(state).toMatchObject({
        clip: { legacyName: 'ViT-B-32__openai', active: { name: 'ViT-B-32__openai' } },
        'facial-recognition': { legacyName: 'buffalo_l' },
        ocr: { legacyName: 'PP-OCRv5_mobile' },
      });
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('should rebuild the results of a task whose model changed', async () => {
      await sut.onConfigInit({ newConfig: config });

      await sut.onConfigUpdate({ newConfig: withModel('ocr', 'PP-OCRv5_server'), oldConfig: config });

      expect(mocks.job.queue).toHaveBeenCalledExactlyOnceWith({ name: JobName.OcrRebuild, data: { generation: 2 } });
    });

    it('should leave a task that is disabled alone', async () => {
      config.machineLearning.ocr.enabled = false;

      await sut.onConfigInit({ newConfig: config });

      expect(state?.ocr).toBeUndefined();
    });

    it('should take up a rebuild whose jobs were lost as the server starts', async () => {
      const generation = await startFaceRebuild();

      await sut.onConfigInit({ newConfig: withModel('facialRecognition', 'antelopev2') });

      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.FaceDetectionRebuild, data: { generation } });
    });

    it('should not queue a rebuild again whose jobs are still queued', async () => {
      await startFaceRebuild();
      mocks.job.getJobCounts.mockResolvedValue(counts({ waiting: 1000 }));

      await sut.onConfigInit({ newConfig: withModel('facialRecognition', 'antelopev2') });

      expect(mocks.job.queue).not.toHaveBeenCalled();
    });
  });

  describe('a rebuild', () => {
    it('should queue the photos without results, then those of other models, behind new photos, then its end', async () => {
      const generation = await startFaceRebuild();
      mocks.machineLearningModel.streamForRebuild.mockImplementation((_task, phase) =>
        makeStream(phase === 'missing' ? [{ id: 'new-1' }] : [{ id: 'old-1' }, { id: 'old-2' }]),
      );

      await expect(sut.handleFaceDetectionRebuild({ generation })).resolves.toBe(JobStatus.Success);

      expect(mocks.machineLearningModel.streamForRebuild).toHaveBeenCalledWith(
        ModelTask.FACIAL_RECOGNITION,
        'missing',
        expect.objectContaining({ legacy: false }),
      );
      expect(mocks.job.queueAll.mock.calls).toEqual([
        [[{ name: JobName.AssetDetectFaces, data: { id: 'new-1', priority: REBUILD_PRIORITY.missing } }]],
        [
          [
            { name: JobName.AssetDetectFaces, data: { id: 'old-1', priority: REBUILD_PRIORITY.stale } },
            { name: JobName.AssetDetectFaces, data: { id: 'old-2', priority: REBUILD_PRIORITY.stale } },
          ],
        ],
      ]);
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.FaceDetectionRebuild,
        data: { generation, finish: true, priority: REBUILD_PRIORITY.finish, delay: undefined },
      });
    });

    it('should do nothing for a model that changed again since', async () => {
      const generation = await startFaceRebuild();

      await expect(sut.handleFaceDetectionRebuild({ generation: generation - 1 })).resolves.toBe(JobStatus.Skipped);
      await expect(sut.handleFaceDetectionRebuild({ generation: generation - 1, finish: true })).resolves.toBe(
        JobStatus.Skipped,
      );
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    });

    it('should end only after the jobs it queued, looking again later', async () => {
      const generation = await startFaceRebuild();
      mocks.job.getJobCounts.mockResolvedValue(counts({ active: 2, waiting: 10 }));

      await sut.handleFaceDetectionRebuild({ generation, finish: true });

      expect(mocks.job.getJobCounts).toHaveBeenCalledWith(QueueName.FaceDetection);
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.FaceDetectionRebuild,
        data: { generation, finish: true, priority: REBUILD_PRIORITY.finish, delay: 60_000 },
      });
      expect(state?.[ModelTask.FACIAL_RECOGNITION]?.rebuild?.finishedAt).toBeUndefined();
    });

    it('should recognize the faces once those of every photo are of the new model', async () => {
      const generation = await startFaceRebuild();
      mocks.job.getJobCounts.mockResolvedValue(counts({ active: 1 })); // itself

      await sut.handleFaceDetectionRebuild({ generation, finish: true });

      expect(state?.[ModelTask.FACIAL_RECOGNITION]?.rebuild?.finishedAt).toBeDefined();
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.FacialRecognitionQueueAll, data: { force: false } });
    });

    it('should switch smart search at once to the new embeddings, then detect duplicates again', async () => {
      await sut.onConfigInit({ newConfig: config });
      await sut.onConfigUpdate({ newConfig: withModel('clip', 'ViT-L-14__openai'), oldConfig: config });
      vi.mocked(mocks.systemMetadata.get as (key: SystemMetadataKey) => Promise<unknown>).mockImplementation((key) =>
        Promise.resolve(
          key === SystemMetadataKey.MachineLearningModels
            ? state
            : key === SystemMetadataKey.SystemConfig
              ? { machineLearning: { clip: { modelName: 'ViT-L-14__openai' } } }
              : undefined,
        ),
      );
      const target = await mocks.machineLearningModel.create({
        task: ModelTask.SEARCH,
        name: 'ViT-L-14__openai',
        fingerprint: 'x',
        format: 'onnx',
      });
      const { generation } = state![ModelTask.SEARCH]!;

      await sut.handleSmartSearchRebuild({ generation, finish: true });

      expect(mocks.machineLearningModel.switchSmartSearch).toHaveBeenCalledWith(
        expect.objectContaining({ modelIds: [target.id], dimSize: 768, currentDimSize: 512 }),
      );
      expect(state?.[ModelTask.SEARCH]).toMatchObject({
        active: { name: 'ViT-L-14__openai' },
        rebuild: { finishedAt: expect.any(String) },
      });
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.SmartSearchQueueAll, data: { force: false } },
        { name: JobName.AssetDetectDuplicatesQueueAll, data: { force: true } },
      ]);
    });
  });

  describe('getModels', () => {
    it('should tell the model of each task and the progress of a rebuild', async () => {
      await startFaceRebuild();
      mocks.machineLearningModel.getProgress.mockResolvedValue({ total: 10, done: 4 });

      const { tasks } = await sut.getModels();

      expect(tasks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            task: ModelTask.FACIAL_RECOGNITION,
            configuredModel: 'antelopev2',
            target: expect.objectContaining({ name: 'antelopev2', fingerprint: null }),
            active: null,
            rebuild: expect.objectContaining({ finishedAt: null, total: 10, done: 4 }),
          }),
          expect.objectContaining({
            task: ModelTask.SEARCH,
            active: expect.objectContaining({ name: 'ViT-B-32__openai' }),
            rebuild: null,
          }),
        ]),
      );
    });
  });
});
