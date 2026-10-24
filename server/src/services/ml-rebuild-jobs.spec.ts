import { AssetFileType, ImmichWorker, JobName, JobStatus, SystemMetadataKey } from 'src/enum.js';
import { ModelTask } from 'src/repositories/machine-learning.repository.js';
import { OcrService, diffOcrLines } from 'src/services/ocr.service.js';
import { PersonService } from 'src/services/person.service.js';
import { SmartInfoService } from 'src/services/smart-info.service.js';
import { MachineLearningModelsState, TaskModelState } from 'src/utils/ml-models.js';
import { AssetFaceFactory } from 'test/factories/asset-face.factory.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { getAsDetectedFace, getForDetectedFaces, getForFacialRecognitionJob } from 'test/mappers.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

// what the jobs of the models do for a photo while a rebuild makes the results of every photo again

const useState = (mocks: ServiceMocks, initial: MachineLearningModelsState) => {
  let state = structuredClone(initial);
  vi.mocked(mocks.systemMetadata.get as (key: SystemMetadataKey) => Promise<unknown>).mockImplementation((key) =>
    Promise.resolve(key === SystemMetadataKey.MachineLearningModels ? state : undefined),
  );
  mocks.systemMetadata.set.mockImplementation((_key, value) => {
    state = structuredClone(value) as MachineLearningModelsState;
    return Promise.resolve();
  });
  return () => state;
};

const rebuilding = (task: Partial<TaskModelState> & Pick<TaskModelState, 'target'>): TaskModelState => ({
  legacyName: 'old',
  generation: 2,
  rebuild: { startedAt: new Date().toISOString() },
  ...task,
});

const line = (text: string, offset = 0) => ({
  x1: 0.1 + offset,
  y1: 0.1,
  x2: 0.5,
  y2: 0.1,
  x3: 0.5,
  y3: 0.2,
  x4: 0.1,
  y4: 0.2,
  text,
});

describe('jobs of models during a rebuild', () => {
  describe(SmartInfoService.name, () => {
    let sut: SmartInfoService;
    let mocks: ServiceMocks;
    const asset = AssetFactory.from().file({ type: AssetFileType.Preview }).build();
    const target = { name: 'ViT-B-32__openai', fingerprint: 'new', format: 'onnx' };
    const searched = { name: 'ViT-B-16__openai', fingerprint: 'old', format: 'onnx' };

    beforeEach(async () => {
      ({ sut, mocks } = newTestService(SmartInfoService));
      mocks.config.getWorker.mockReturnValue(ImmichWorker.Microservices);
      mocks.assetJob.getForClipEncoding.mockResolvedValue(asset);
      const active = await mocks.machineLearningModel.create({ task: ModelTask.SEARCH, ...searched });
      useState(mocks, {
        clip: rebuilding({
          target: { name: 'ViT-B-32__openai', modelId: null },
          active: { name: 'ViT-B-16__openai', modelId: active.id },
        }),
      });
      mocks.machineLearning.encodeImage.mockImplementation((_path, { modelName }) =>
        Promise.resolve(
          modelName === target.name ? { embedding: '[0.5]', model: target } : { embedding: '[0.1]', model: searched },
        ),
      );
    });

    it('should keep the embedding of the new model apart from those that are searched', async () => {
      mocks.search.getEmbedding.mockResolvedValue({ assetId: asset.id, embedding: '[0.2]' });

      await expect(sut.handleEncodeClip({ id: asset.id })).resolves.toBe(JobStatus.Success);

      expect(mocks.machineLearningModel.upsertRebuildEmbedding).toHaveBeenCalledWith(
        asset.id,
        expect.any(String),
        '[0.5]',
      );
      expect(mocks.search.upsert).not.toHaveBeenCalled();
      expect(mocks.machineLearning.encodeImage).toHaveBeenCalledTimes(1);
    });

    it('should make a new photo searchable before the switch too, with the model that is searched', async () => {
      mocks.search.getEmbedding.mockResolvedValue(undefined);

      await expect(sut.handleEncodeClip({ id: asset.id })).resolves.toBe(JobStatus.Success);

      expect(mocks.machineLearningModel.upsertRebuildEmbedding).toHaveBeenCalledWith(
        asset.id,
        expect.any(String),
        '[0.5]',
      );
      expect(mocks.machineLearning.encodeImage).toHaveBeenCalledWith(
        asset.files[0].path,
        expect.objectContaining({ modelName: 'ViT-B-16__openai' }),
      );
      expect(mocks.search.upsert).toHaveBeenCalledWith(asset.id, '[0.1]');
    });

    it('should not search with an embedding of other files than those searched', async () => {
      mocks.search.getEmbedding.mockResolvedValue(undefined);
      mocks.machineLearning.encodeImage.mockImplementation((_path, { modelName }) =>
        Promise.resolve(
          modelName === target.name
            ? { embedding: '[0.5]', model: target }
            : { embedding: '[0.1]', model: { ...searched, fingerprint: 'other' } },
        ),
      );

      await sut.handleEncodeClip({ id: asset.id });

      expect(mocks.search.upsert).not.toHaveBeenCalled();
    });
  });

  describe(PersonService.name, () => {
    let sut: PersonService;
    let mocks: ServiceMocks;
    let getState: () => MachineLearningModelsState;

    beforeEach(() => {
      ({ sut, mocks } = newTestService(PersonService));
      mocks.config.getWorker.mockReturnValue(ImmichWorker.Microservices);
      getState = useState(mocks, {
        'facial-recognition': rebuilding({ legacyName: 'buffalo_s', target: { name: 'buffalo_l', modelId: null } }),
      });
      mocks.person.refreshFaces.mockResolvedValue();
    });

    it('should keep a face found in the same place, with the embedding of the new model', async () => {
      const face = AssetFaceFactory.create();
      const asset = AssetFactory.from().face(face).file({ type: AssetFileType.Preview }).exif().build();
      mocks.machineLearning.detectFaces.mockResolvedValue(getAsDetectedFace(face));
      mocks.assetJob.getForDetectFacesJob.mockResolvedValue(getForDetectedFaces(asset));

      await expect(sut.handleDetectFaces({ id: asset.id })).resolves.toBe(JobStatus.Success);

      // not removed nor added: its place and person stay, and the apps have nothing to sync
      expect(mocks.person.refreshFaces).not.toHaveBeenCalled();
      expect(mocks.person.updateFaceEmbeddings).toHaveBeenCalledWith([{ faceId: face.id, embedding: '[1, 2, 3, 4]' }]);
      const { target } = getState()['facial-recognition']!;
      expect(mocks.machineLearningModel.setResult).toHaveBeenCalledWith(
        asset.id,
        ModelTask.FACIAL_RECOGNITION,
        target.modelId,
      );
    });

    it('should leave the embedding of a face already of the new model', async () => {
      const face = AssetFaceFactory.create();
      const asset = AssetFactory.from().face(face).file({ type: AssetFileType.Preview }).exif().build();
      mocks.machineLearning.detectFaces.mockResolvedValue(getAsDetectedFace(face));
      mocks.assetJob.getForDetectFacesJob.mockResolvedValue(getForDetectedFaces(asset));
      await sut.handleDetectFaces({ id: asset.id });
      mocks.person.updateFaceEmbeddings.mockClear();

      await sut.handleDetectFaces({ id: asset.id });

      expect(mocks.person.updateFaceEmbeddings).not.toHaveBeenCalled();
    });

    it('should not recognize new faces until the faces of every photo are of the new model', async () => {
      const face = AssetFaceFactory.create();
      const asset = AssetFactory.from().file({ type: AssetFileType.Preview }).exif().build();
      mocks.crypto.randomUUID.mockReturnValue(face.id);
      mocks.machineLearning.detectFaces.mockResolvedValue(getAsDetectedFace(face));
      mocks.assetJob.getForDetectFacesJob.mockResolvedValue(getForDetectedFaces(asset));
      mocks.person.getFaceForFacialRecognitionJob.mockResolvedValue(getForFacialRecognitionJob(face, asset));

      await sut.handleDetectFaces({ id: asset.id });
      expect(mocks.job.queueAll).not.toHaveBeenCalled();

      await expect(sut.handleRecognizeFaces({ id: face.id })).resolves.toBe(JobStatus.Skipped);
      await expect(sut.handleQueueRecognizeFaces({ force: false })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.search.searchFaces).not.toHaveBeenCalled();
    });

    it('should not keep faces found with files that were replaced', async () => {
      const replaced = await mocks.machineLearningModel.create({
        task: ModelTask.FACIAL_RECOGNITION,
        name: 'buffalo_l',
        fingerprint: 'old',
        format: 'onnx',
      });
      await mocks.machineLearningModel.update(replaced.id, { retiredAt: new Date() });
      const current = await mocks.machineLearningModel.create({
        task: ModelTask.FACIAL_RECOGNITION,
        name: 'buffalo_l',
        fingerprint: 'files',
        format: 'onnx',
      });
      useState(mocks, {
        'facial-recognition': rebuilding({ target: { name: 'buffalo_l', modelId: current.id } }),
      });
      const face = AssetFaceFactory.create();
      const asset = AssetFactory.from().file({ type: AssetFileType.Preview }).exif().build();
      mocks.machineLearning.detectFaces.mockResolvedValue({
        ...getAsDetectedFace(face),
        model: { name: 'buffalo_l', fingerprint: 'old', format: 'onnx' },
      });
      mocks.assetJob.getForDetectFacesJob.mockResolvedValue(getForDetectedFaces(asset));

      await expect(sut.handleDetectFaces({ id: asset.id })).resolves.toBe(JobStatus.Failed);

      expect(mocks.person.refreshFaces).not.toHaveBeenCalled();
      expect(mocks.asset.upsertJobStatus).not.toHaveBeenCalled();
    });
  });

  describe(OcrService.name, () => {
    let sut: OcrService;
    let mocks: ServiceMocks;

    beforeEach(() => {
      ({ sut, mocks } = newTestService(OcrService));
      mocks.config.getWorker.mockReturnValue(ImmichWorker.Microservices);
      mocks.assetJob.getForOcr.mockResolvedValue({
        visibility: AssetFactory.create().visibility,
        previewFile: { path: '/data/thumbs/preview.jpg', backendId: null, key: null, size: null, encryption: null },
      });
    });

    it('should tell the lines found again (the same text, the corners hardly moved) from the others', () => {
      const existing = [
        { ...line('kept'), id: 'kept' },
        { ...line('moved'), id: 'moved' },
        { ...line('gone'), id: 'gone' },
      ];
      const found = [line('kept', 0.005), line('moved', 0.05), line('new')];

      expect(diffOcrLines(existing, found)).toEqual({
        add: [line('moved', 0.05), line('new')],
        removeIds: ['moved', 'gone'],
      });
    });

    it('should keep the lines found again, and write only what changed', async () => {
      mocks.ocr.getByAssetId.mockResolvedValue([
        { ...line('kept'), id: 'kept' },
        { ...line('gone'), id: 'gone' },
      ] as never);
      mocks.machineLearning.ocr.mockResolvedValue({
        box: [0.1, 0.1, 0.5, 0.1, 0.5, 0.2, 0.1, 0.2, 0.1, 0.3, 0.5, 0.3, 0.5, 0.4, 0.1, 0.4],
        boxScore: [0.9, 0.9],
        text: ['kept', 'new'],
        textScore: [0.9, 0.9],
        model: { name: 'PP-OCRv5_mobile', fingerprint: 'files', format: 'onnx' },
      });

      await expect(sut.handleOcr({ id: 'asset-id' })).resolves.toBe(JobStatus.Success);

      expect(mocks.ocr.getByAssetId).toHaveBeenCalledWith('asset-id', {});
      expect(mocks.ocr.update).toHaveBeenCalledWith(
        'asset-id',
        ['gone'],
        [expect.objectContaining({ text: 'new', y1: 0.3 })],
        'kept new',
      );
      expect(mocks.machineLearningModel.setResult).toHaveBeenCalledWith('asset-id', ModelTask.OCR, expect.any(String));
      expect(mocks.job.queue).not.toHaveBeenCalledWith(expect.objectContaining({ name: JobName.OcrRebuild }));
    });
  });
});
