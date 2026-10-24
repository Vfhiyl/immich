import { defaults } from 'src/dtos/config.dto.js';
import { JobName, SystemMetadataKey } from 'src/enum.js';
import { ModelTask, getReportedModel } from 'src/repositories/machine-learning.repository.js';
import { BaseService } from 'src/services/base.service.js';
import {
  KnownModel,
  MachineLearningModels,
  RETURN_AFTER_MS,
  TaskModelState,
  decideModel,
  isCompatible,
} from 'src/utils/ml-models.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const model = (id: string, fingerprint: string | null, extra: Partial<KnownModel> = {}): KnownModel => ({
  id,
  name: 'buffalo_l',
  fingerprint,
  lastSeenAt: new Date(),
  retiredAt: null,
  ...extra,
});

const reported = (fingerprint: string | null, name = 'buffalo_l') => ({ name, fingerprint, format: 'onnx' });

describe('machine learning models', () => {
  describe(isCompatible.name, () => {
    it('should count results of the same name as one model unless both fingerprints are known and differ', () => {
      expect(isCompatible({ name: 'a', fingerprint: 'x' }, { name: 'a', fingerprint: 'x' })).toBe(true);
      expect(isCompatible({ name: 'a', fingerprint: null }, { name: 'a', fingerprint: 'x' })).toBe(true);
      expect(isCompatible({ name: 'a', fingerprint: 'x' }, { name: 'a', fingerprint: null })).toBe(true);
      expect(isCompatible({ name: 'a', fingerprint: 'x' }, { name: 'a', fingerprint: 'y' })).toBe(false);
      expect(isCompatible({ name: 'a', fingerprint: null }, { name: 'b', fingerprint: null })).toBe(false);
    });
  });

  describe(decideModel.name, () => {
    const now = new Date();
    const target = { name: 'buffalo_l', modelId: 'current' };

    it('should keep a result of the target', () => {
      const current = model('current', 'x');
      expect(decideModel({ target, targetModel: current, model: current, now })).toEqual({ kind: 'target' });
      // a service that does not tell its files
      expect(decideModel({ target, targetModel: current, model: model('unknown', null), now })).toEqual({
        kind: 'target',
      });
    });

    it('should learn the files of a target that has none known yet', () => {
      expect(
        decideModel({ target: { ...target, modelId: null }, targetModel: null, model: model('a', 'x'), now }),
      ).toEqual({ kind: 'learn' });
      expect(decideModel({ target, targetModel: model('current', null), model: model('a', 'x'), now })).toEqual({
        kind: 'learn',
      });
    });

    it('should not keep a result of another model', () => {
      expect(
        decideModel({ target, targetModel: model('current', 'x'), model: model('a', 'x', { name: 'buffalo_s' }), now }),
      ).toEqual({ kind: 'other' });
    });

    it('should take new files of the target model as the target', () => {
      expect(decideModel({ target, targetModel: model('current', 'x'), model: model('new', 'y'), now })).toEqual({
        kind: 'replace',
      });
    });

    it('should not keep a result of files that were replaced while the current ones are still seen', () => {
      const replaced = model('old', 'w', { retiredAt: new Date() });
      const current = model('current', 'x', { lastSeenAt: new Date(now.getTime() - RETURN_AFTER_MS + 60_000) });
      expect(decideModel({ target, targetModel: current, model: replaced, now })).toEqual({ kind: 'conflict' });
    });

    it('should take files that were replaced as the target again once the current ones went unseen for a day', () => {
      const replaced = model('old', 'w', { retiredAt: new Date() });
      const current = model('current', 'x', { lastSeenAt: new Date(now.getTime() - RETURN_AFTER_MS - 60_000) });
      expect(decideModel({ target, targetModel: current, model: replaced, now })).toEqual({ kind: 'return' });
    });
  });

  describe(getReportedModel.name, () => {
    it('should take the files of all models of a task as one fingerprint', () => {
      const files = { name: 'buffalo_l', fingerprint: 'x', format: 'onnx' };
      expect(
        getReportedModel(
          { models: { 'facial-recognition': { detection: files, recognition: files } } },
          ModelTask.FACIAL_RECOGNITION,
          'buffalo_l',
        ),
      ).toEqual({ name: 'buffalo_l', fingerprint: 'x', format: 'onnx' });
      expect(
        getReportedModel(
          {
            models: {
              ocr: {
                recognition: { ...files, fingerprint: 'r' },
                detection: { ...files, fingerprint: 'd', format: 'rknn' },
              },
            },
          },
          ModelTask.OCR,
          'PP-OCRv5_mobile',
        ),
      ).toEqual({ name: 'PP-OCRv5_mobile', fingerprint: 'detection:d+recognition:r', format: 'rknn+onnx' });
    });

    it('should tell no files for a service that does not report them', () => {
      expect(getReportedModel({}, ModelTask.SEARCH, 'ViT-B-32__openai')).toEqual({
        name: 'ViT-B-32__openai',
        fingerprint: null,
        format: null,
      });
    });
  });

  describe(MachineLearningModels.name, () => {
    let mocks: ServiceMocks;
    let models: MachineLearningModels;
    let stored: Partial<Record<ModelTask, TaskModelState>> | undefined;
    const config = defaults.machineLearning;
    const faces = ModelTask.FACIAL_RECOGNITION;

    beforeEach(() => {
      ({ mocks } = newTestService(BaseService));
      stored = undefined;
      vi.mocked(mocks.systemMetadata.get as (key: SystemMetadataKey) => Promise<unknown>).mockImplementation((key) =>
        Promise.resolve(key === SystemMetadataKey.MachineLearningModels ? stored : undefined),
      );
      mocks.systemMetadata.set.mockImplementation((_key, value) => {
        stored = structuredClone(value) as typeof stored;
        return Promise.resolve();
      });
      models = new MachineLearningModels({
        databaseRepository: mocks.database as never,
        jobRepository: mocks.job as never,
        logger: mocks.logger as never,
        machineLearningModelRepository: mocks.machineLearningModel as never,
        systemMetadataRepository: mocks.systemMetadata as never,
      });
    });

    it('should count the results so far as of the configured model, and keep that once recorded', async () => {
      await models.followConfig(faces, config);
      await models.followConfig(faces, {
        ...config,
        facialRecognition: { ...config.facialRecognition, modelName: 'antelopev2' },
      });

      expect(stored?.[faces]).toMatchObject({ legacyName: 'buffalo_l', target: { name: 'antelopev2' } });
    });

    it('should learn the files of the target from the first result, with nothing to make again', async () => {
      await models.followConfig(faces, config);

      const observed = await models.observe(faces, reported('x'), config);

      expect(observed).toMatchObject({ keep: true, conflict: false });
      expect(stored?.[faces]?.target).toEqual({ name: 'buffalo_l', modelId: observed.modelId });
      expect(stored?.[faces]?.rebuild).toBeUndefined();
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('should start a rebuild when the configured model changes, after the state is written', async () => {
      await models.followConfig(faces, config);
      mocks.job.queue.mockImplementation(() => {
        expect(stored?.[faces]?.target.name).toBe('antelopev2');
        return Promise.resolve();
      });

      const state = await models.followConfig(faces, {
        ...config,
        facialRecognition: { ...config.facialRecognition, modelName: 'antelopev2' },
      });

      expect(state).toMatchObject({ target: { name: 'antelopev2', modelId: null }, generation: 2 });
      expect(state.rebuild?.startedAt).toBeDefined();
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.FaceDetectionRebuild, data: { generation: 2 } });
    });

    it('should start a rebuild when the files of the model change, and tell what replaced what', async () => {
      await models.followConfig(faces, config);
      const first = await models.observe(faces, reported('x'), config);

      const second = await models.observe(faces, reported('y'), config);

      expect(second).toMatchObject({ keep: true, conflict: false });
      expect(stored?.[faces]).toMatchObject({
        target: { name: 'buffalo_l', modelId: second.modelId },
        replaced: { fromModelId: first.modelId, toModelId: second.modelId },
      });
      await expect(mocks.machineLearningModel.get(first.modelId)).resolves.toMatchObject({
        retiredAt: expect.any(Date),
      });
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.FaceDetectionRebuild, data: { generation: 2 } });
      expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('changed'));
    });

    it('should not keep results of files that were replaced, and not rebuild again for them', async () => {
      await models.followConfig(faces, config);
      await models.observe(faces, reported('x'), config);
      const current = await models.observe(faces, reported('y'), config);
      mocks.job.queue.mockClear();

      const old = await models.observe(faces, reported('x'), config);
      await models.observe(faces, reported('x'), config);

      expect(old).toMatchObject({ keep: false, conflict: true });
      expect(stored?.[faces]).toMatchObject({
        target: { modelId: current.modelId },
        conflict: { modelId: old.modelId },
      });
      expect(mocks.job.queue).not.toHaveBeenCalled();
      // told once, not for every photo
      expect(mocks.logger.warn).toHaveBeenCalledTimes(2);
    });

    it('should keep results of a service that does not tell its files', async () => {
      await models.followConfig(faces, config);
      await models.observe(faces, reported('x'), config);

      await expect(models.observe(faces, reported(null), config)).resolves.toMatchObject({ keep: true });
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('should not keep results of another model, made while the configuration changed', async () => {
      await models.followConfig(faces, config);

      await expect(models.observe(faces, reported('x', 'buffalo_s'), config)).resolves.toMatchObject({
        keep: false,
        conflict: false,
      });
    });

    it('should not rebuild smart search when it changes back to the model that is searched', async () => {
      const clip = (modelName: string) => ({ ...config, clip: { ...config.clip, modelName } });
      await models.followConfig(ModelTask.SEARCH, config);

      const changed = await models.followConfig(ModelTask.SEARCH, clip('ViT-B-16__openai'));
      const back = await models.followConfig(ModelTask.SEARCH, clip('ViT-B-32__openai'));

      expect(changed.rebuild).toBeDefined();
      expect(back).toMatchObject({ target: { name: 'ViT-B-32__openai' }, active: { name: 'ViT-B-32__openai' } });
      expect(back.rebuild).toBeUndefined();
      expect(mocks.machineLearningModel.deleteRebuildEmbeddings).toHaveBeenLastCalledWith();
    });

    it('should select the results of the target, and those made before models were recorded of its name', async () => {
      await models.followConfig(faces, config);
      const { modelId } = await models.observe(faces, reported('x'), config);
      await mocks.machineLearningModel.create({ task: faces, name: 'buffalo_l', fingerprint: null, format: null });
      await mocks.machineLearningModel.create({ task: faces, name: 'buffalo_s', fingerprint: 'x', format: null });
      const state = await models.getState(faces, config);

      const selection = await models.getSelection(faces, state);

      expect(selection.legacy).toBe(true);
      expect(selection.modelIds).toHaveLength(2);
      expect(selection.modelIds).toContain(modelId);
    });
  });
});
