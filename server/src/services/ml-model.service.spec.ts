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

const face = (id: string, extra: Partial<{ isFixed: boolean; isCover: boolean }> = {}) => ({
  id,
  isFixed: false,
  isCover: false,
  ...extra,
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

  /** As a rebuild of faces leaves it: every face detected again, the regroup about to start */
  const startRegroup = async () => {
    const generation = await startFaceRebuild();
    mocks.job.getJobCounts.mockResolvedValue(counts({ active: 1 }));
    await sut.handleFaceDetectionRebuild({ generation, finish: true });
    mocks.job.queue.mockClear();
    return generation;
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

    it('should regroup the people once the faces of every photo are of the new model, once', async () => {
      const generation = await startFaceRebuild();
      mocks.job.getJobCounts.mockResolvedValue(counts({ active: 1 })); // itself

      await sut.handleFaceDetectionRebuild({ generation, finish: true });

      expect(mocks.machineLearningModel.snapshotFaceAssignments).toHaveBeenCalledOnce();
      expect(state?.[ModelTask.FACIAL_RECOGNITION]).toMatchObject({
        regroup: { generation, startedAt: expect.any(String) },
        rebuild: { startedAt: expect.any(String) },
      });
      // recognition waits for the regroup
      expect(state?.[ModelTask.FACIAL_RECOGNITION]?.rebuild?.finishedAt).toBeUndefined();
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.FaceRegroup, data: { generation } });

      // as the server starts again before the regroup is done
      await sut.handleFaceDetectionRebuild({ generation, finish: true });
      expect(mocks.machineLearningModel.snapshotFaceAssignments).toHaveBeenCalledOnce();
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

  describe('thresholds', () => {
    it('should refuse a model without thresholds of its own', () => {
      const newConfig = withModel('facialRecognition', 'my-own-model');
      expect(() => sut.onConfigValidate({ newConfig, oldConfig: config })).toThrow(
        'Unknown facial recognition model: my-own-model',
      );
      expect(() => sut.onConfigValidate({ newConfig: config, oldConfig: config })).not.toThrow();
    });

    it('should tell that thresholds in the settings are ignored', async () => {
      config.machineLearning.facialRecognition.maxDistance = 0.6;

      await sut.onConfigInit({ newConfig: config });

      expect(mocks.logger.warn).toHaveBeenCalledWith(
        'The setting machineLearning.facialRecognition.maxDistance (0.6) is ignored: thresholds are fixed per model',
      );
      expect(mocks.logger.warn).toHaveBeenCalledTimes(1);
    });
  });

  describe('regrouping the people', () => {
    it('should take the faces that are no longer close to the rest of their person, then recognize them', async () => {
      const generation = await startRegroup();
      mocks.machineLearningModel.getPeopleToRegroup
        .mockResolvedValueOnce([{ id: 'person-1' }])
        .mockResolvedValueOnce([]);
      mocks.machineLearningModel.getFacesToRegroup.mockResolvedValue([face('a'), face('b'), face('c'), face('far')]);
      mocks.machineLearningModel.getCloseFacePairs.mockResolvedValue([
        { a: 'a', b: 'b' },
        { a: 'b', b: 'c' },
      ]);

      await expect(sut.handleFaceRegroup({ generation })).resolves.toBe(JobStatus.Success);

      expect(mocks.machineLearningModel.getCloseFacePairs).toHaveBeenCalledWith('person-1', 0.5);
      expect(mocks.machineLearningModel.takeFromPerson).toHaveBeenCalledWith('person-1', ['far']);
      expect(state?.[ModelTask.FACIAL_RECOGNITION]).toMatchObject({
        regroup: { finishedAt: expect.any(String) },
        rebuild: { finishedAt: expect.any(String) },
      });
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.FacialRecognitionQueueAll, data: { force: false } });
    });

    it('should go on after the last person regrouped before a restart', async () => {
      const generation = await startRegroup();
      mocks.machineLearningModel.getPeopleToRegroup
        .mockResolvedValueOnce([{ id: 'person-1' }])
        .mockRejectedValueOnce(new Error('stopped'));
      mocks.machineLearningModel.getFacesToRegroup.mockResolvedValue([]);
      await expect(sut.handleFaceRegroup({ generation })).rejects.toThrow('stopped');

      mocks.machineLearningModel.getPeopleToRegroup.mockResolvedValue([]);
      await sut.handleFaceRegroup({ generation });

      expect(mocks.machineLearningModel.getPeopleToRegroup).toHaveBeenLastCalledWith('person-1', 100);
    });

    it('should give a person whose picture left another one', async () => {
      const generation = await startRegroup();
      mocks.machineLearningModel.getPeopleToRegroup.mockResolvedValueOnce([{ id: 'person-1' }]).mockResolvedValue([]);
      mocks.machineLearningModel.getFacesToRegroup.mockResolvedValue([
        face('a'),
        face('b'),
        face('c', { isCover: true }),
      ]);
      mocks.machineLearningModel.getCloseFacePairs.mockResolvedValue([{ a: 'a', b: 'b' }]);
      const owner = { ownerId: 'user-1', personGroupId: 'person-1' };
      mocks.machineLearningModel.getPeopleWithPicture.mockResolvedValue([owner]);
      mocks.person.getRandomFace.mockResolvedValue({ id: 'a' } as never);

      await sut.handleFaceRegroup({ generation });

      expect(mocks.machineLearningModel.takeFromPerson).toHaveBeenCalledWith('person-1', ['c']);
      expect(mocks.person.update).toHaveBeenCalledWith({ ...owner, faceAssetId: 'a' });
      expect(mocks.job.queueAll).toHaveBeenCalledWith([{ name: JobName.PersonGenerateThumbnail, data: owner }]);
    });

    it('should tell what changed, and undo it once', async () => {
      const generation = await startRegroup();
      mocks.machineLearningModel.getPeopleToRegroup.mockResolvedValue([]);
      await sut.handleFaceRegroup({ generation });
      mocks.machineLearningModel.getRegroupChanges.mockResolvedValue([
        { personGroupId: 'mom', names: 'Mom', before: 100, left: 5, joined: 2 },
        { personGroupId: 'new', names: null, before: 0, left: 0, joined: 5 },
      ]);

      const { tasks } = await sut.getModels();
      expect(tasks.find(({ task }) => task === ModelTask.FACIAL_RECOGNITION)?.regroup).toEqual({
        startedAt: expect.any(String),
        finishedAt: expect.any(String),
        undoneAt: null,
        facesLeft: 5,
        facesJoined: 7,
        people: [{ personGroupId: 'mom', names: 'Mom', before: 100, left: 5, joined: 2 }],
        otherPeople: 1,
      });

      await sut.undoFaceRegroup();
      expect(mocks.machineLearningModel.undoRegroup).toHaveBeenCalledOnce();
      await expect(sut.undoFaceRegroup()).rejects.toThrow('There is no regroup of people to undo');
    });

    it('should not undo a regroup that is not done', async () => {
      await startRegroup();

      await expect(sut.undoFaceRegroup()).rejects.toThrow('There is no regroup of people to undo');
      expect(mocks.machineLearningModel.undoRegroup).not.toHaveBeenCalled();
    });
  });
});
