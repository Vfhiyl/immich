import { Kysely, sql } from 'kysely';
import { AssetFileType } from 'src/enum.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { ModelTask } from 'src/repositories/machine-learning.repository.js';
import { MachineLearningModelRepository, RebuildPhase } from 'src/repositories/ml-model.repository.js';
import { OcrRepository } from 'src/repositories/ocr.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { newEmbedding } from 'test/small.factory.js';
import { getTestKyselyDB } from 'test/utils.js';

const setup = async () => {
  const db: Kysely<DB> = await getTestKyselyDB();
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  /** A photo with a preview, taken on `day` (of 2020-01), and the dates of its results */
  const newPhoto = async (
    day: number,
    { faces, ocr, preview = true }: { faces?: boolean; ocr?: boolean; preview?: boolean } = {},
  ) => {
    const { asset } = await ctx.newAsset({
      ownerId: user.id,
      fileCreatedAt: new Date(`2020-01-${String(day).padStart(2, '0')}T12:00:00Z`),
    });
    if (preview) {
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, path: `/data/thumbs/${asset.id}.jpg` });
    }
    await db
      .insertInto('asset_job_status')
      .values({ assetId: asset.id, facesRecognizedAt: faces ? new Date() : null, ocrAt: ocr ? new Date() : null })
      .onConflict((oc) =>
        oc
          .column('assetId')
          .doUpdateSet({ facesRecognizedAt: faces ? new Date() : null, ocrAt: ocr ? new Date() : null }),
      )
      .execute();
    return asset.id;
  };
  return { ctx, db, sut: ctx.get(MachineLearningModelRepository), newPhoto };
};

const stream = async (
  sut: MachineLearningModelRepository,
  task: ModelTask,
  phase: RebuildPhase,
  selection: { modelIds: string[]; legacy: boolean },
) => {
  const ids: string[] = [];
  for await (const { id } of sut.streamForRebuild(task, phase, selection)) {
    ids.push(id);
  }
  return ids;
};

const embeddingOf = (dimensions: number, value: number) => `[${Array.from({ length: dimensions }, () => value)}]`;

describe(MachineLearningModelRepository.name, () => {
  describe('models', () => {
    it('should record a model once, also without a fingerprint, and the files of one name apart', async () => {
      const { sut } = await setup();

      const unknown = await sut.create({
        task: ModelTask.SEARCH,
        name: 'ViT-B-32__openai',
        fingerprint: null,
        format: null,
      });
      const again = await sut.create({
        task: ModelTask.SEARCH,
        name: 'ViT-B-32__openai',
        fingerprint: null,
        format: null,
      });
      const known = await sut.create({
        task: ModelTask.SEARCH,
        name: 'ViT-B-32__openai',
        fingerprint: 'a',
        format: 'onnx',
      });
      const replaced = await sut.create({
        task: ModelTask.SEARCH,
        name: 'ViT-B-32__openai',
        fingerprint: 'b',
        format: 'onnx',
      });
      const faces = await sut.create({
        task: ModelTask.FACIAL_RECOGNITION,
        name: 'buffalo_l',
        fingerprint: 'a',
        format: 'onnx',
      });

      expect(again.id).toBe(unknown.id);
      expect(new Set([unknown.id, known.id, replaced.id, faces.id]).size).toBe(4);
      await expect(sut.find(ModelTask.SEARCH, 'ViT-B-32__openai', 'b')).resolves.toMatchObject({ id: replaced.id });
      await expect(sut.find(ModelTask.SEARCH, 'ViT-B-32__openai', null)).resolves.toMatchObject({ id: unknown.id });
      await expect(sut.getAll(ModelTask.SEARCH)).resolves.toHaveLength(3);
    });

    it('should keep the model of the results of a photo for each task', async () => {
      const { sut, newPhoto } = await setup();
      const assetId = await newPhoto(1);
      const a = await sut.create({ task: ModelTask.OCR, name: 'PP-OCRv5_mobile', fingerprint: 'a', format: 'onnx' });
      const b = await sut.create({ task: ModelTask.OCR, name: 'PP-OCRv5_mobile', fingerprint: 'b', format: 'onnx' });

      await expect(sut.getResult(assetId, ModelTask.OCR)).resolves.toBeNull();
      await sut.setResult(assetId, ModelTask.OCR, a.id);
      await sut.setResult(assetId, ModelTask.OCR, b.id);

      await expect(sut.getResult(assetId, ModelTask.OCR)).resolves.toBe(b.id);
      await expect(sut.getResult(assetId, ModelTask.FACIAL_RECOGNITION)).resolves.toBeNull();
    });
  });

  describe('rebuild of faces and text', () => {
    it('should select the photos without results, then those of other models, the newest first', async () => {
      const { sut, newPhoto } = await setup();
      const old = await sut.create({
        task: ModelTask.FACIAL_RECOGNITION,
        name: 'buffalo_s',
        fingerprint: 'a',
        format: 'onnx',
      });
      const target = await sut.create({
        task: ModelTask.FACIAL_RECOGNITION,
        name: 'buffalo_l',
        fingerprint: 'b',
        format: 'onnx',
      });
      const missing1 = await newPhoto(1);
      const missing3 = await newPhoto(3);
      const stale2 = await newPhoto(2, { faces: true });
      const stale4 = await newPhoto(4, { faces: true });
      const legacy5 = await newPhoto(5, { faces: true });
      const done6 = await newPhoto(6, { faces: true });
      await newPhoto(7, { preview: false });
      await sut.setResult(stale2, ModelTask.FACIAL_RECOGNITION, old.id);
      await sut.setResult(stale4, ModelTask.FACIAL_RECOGNITION, old.id);
      await sut.setResult(done6, ModelTask.FACIAL_RECOGNITION, target.id);
      const selection = { modelIds: [target.id], legacy: false };

      await expect(stream(sut, ModelTask.FACIAL_RECOGNITION, 'missing', selection)).resolves.toEqual([
        missing3,
        missing1,
      ]);
      await expect(stream(sut, ModelTask.FACIAL_RECOGNITION, 'stale', selection)).resolves.toEqual([
        legacy5,
        stale4,
        stale2,
      ]);
      await expect(sut.getProgress(ModelTask.FACIAL_RECOGNITION, selection)).resolves.toEqual({ total: 6, done: 1 });

      // results made before models were recorded count as of the target when it has the name they were made with
      const legacy = { modelIds: [target.id], legacy: true };
      await expect(stream(sut, ModelTask.FACIAL_RECOGNITION, 'stale', legacy)).resolves.toEqual([stale4, stale2]);
      await expect(sut.getProgress(ModelTask.FACIAL_RECOGNITION, legacy)).resolves.toEqual({ total: 6, done: 2 });
    });

    it('should select text by its own date, also of photos without a preview', async () => {
      const { sut, newPhoto } = await setup();
      const target = await sut.create({
        task: ModelTask.OCR,
        name: 'PP-OCRv5_mobile',
        fingerprint: 'b',
        format: 'onnx',
      });
      const missing = await newPhoto(1, { faces: true, preview: false });
      const done = await newPhoto(2, { ocr: true });
      await sut.setResult(done, ModelTask.OCR, target.id);
      const selection = { modelIds: [target.id], legacy: false };

      await expect(stream(sut, ModelTask.OCR, 'missing', selection)).resolves.toEqual([missing]);
      await expect(stream(sut, ModelTask.OCR, 'stale', selection)).resolves.toEqual([]);
    });
  });

  describe('rebuild of smart search', () => {
    it('should select the photos without an embedding of the target, those not searched first', async () => {
      const { sut, ctx, newPhoto } = await setup();
      const target = await sut.create({
        task: ModelTask.SEARCH,
        name: 'ViT-B-16__openai',
        fingerprint: 'b',
        format: 'onnx',
      });
      const searched = await newPhoto(1);
      const notSearched = await newPhoto(2);
      const rebuilt = await newPhoto(3);
      await ctx.database
        .insertInto('smart_search')
        .values([
          { assetId: searched, embedding: newEmbedding() },
          { assetId: rebuilt, embedding: newEmbedding() },
        ])
        .execute();
      await sut.upsertRebuildEmbedding(rebuilt, target.id, embeddingOf(512, 0.5));
      const selection = { modelIds: [target.id], legacy: false };

      await expect(stream(sut, ModelTask.SEARCH, 'missing', selection)).resolves.toEqual([notSearched]);
      await expect(stream(sut, ModelTask.SEARCH, 'stale', selection)).resolves.toEqual([searched]);
      await expect(sut.getProgress(ModelTask.SEARCH, selection)).resolves.toEqual({ total: 3, done: 1 });
    });

    it('should switch to the embeddings of the target at once, of the same dimension', async () => {
      const { sut, ctx, db, newPhoto } = await setup();
      const target = await sut.create({
        task: ModelTask.SEARCH,
        name: 'ViT-B-32__openai',
        fingerprint: 'b',
        format: 'onnx',
      });
      const other = await sut.create({
        task: ModelTask.SEARCH,
        name: 'ViT-B-32__openai',
        fingerprint: 'c',
        format: 'onnx',
      });
      const [rebuilt, failed, stray] = [await newPhoto(1), await newPhoto(2), await newPhoto(3)];
      await db
        .insertInto('smart_search')
        .values([rebuilt, failed].map((assetId) => ({ assetId, embedding: embeddingOf(512, 0.1) })))
        .execute();
      await sut.upsertRebuildEmbedding(rebuilt, target.id, embeddingOf(512, 0.5));
      await sut.upsertRebuildEmbedding(stray, other.id, embeddingOf(512, 0.9));

      await sut.switchSmartSearch({
        modelIds: [target.id],
        dimSize: 512,
        currentDimSize: 512,
        vectorExtension: await ctx.get(DatabaseRepository).getVectorExtension(),
      });

      const rows = await db
        .selectFrom('smart_search')
        .select(['assetId', sql<string>`embedding::text`.as('embedding')])
        .execute();
      // the photo whose embedding could not be made has none: the job of missing embeddings makes it
      expect(rows).toEqual([{ assetId: rebuilt, embedding: embeddingOf(512, 0.5) }]);
      await expect(db.selectFrom('smart_search_rebuild').selectAll().execute()).resolves.toEqual([]);
    });

    it('should switch to embeddings of another dimension, with the index built again', async () => {
      const { sut, ctx, db, newPhoto } = await setup();
      const database = ctx.get(DatabaseRepository);
      const target = await sut.create({
        task: ModelTask.SEARCH,
        name: 'ViT-L-14__openai',
        fingerprint: 'b',
        format: 'onnx',
      });
      const assetId = await newPhoto(1);
      await db
        .insertInto('smart_search')
        .values({ assetId, embedding: embeddingOf(512, 0.1) })
        .execute();
      await sut.upsertRebuildEmbedding(assetId, target.id, embeddingOf(768, 0.5));

      await sut.switchSmartSearch({
        modelIds: [target.id],
        dimSize: 768,
        currentDimSize: 512,
        vectorExtension: await database.getVectorExtension(),
      });

      await expect(database.getDimensionSize('smart_search')).resolves.toBe(768);
      const indexes = await sql<{
        indexname: string;
      }>`select indexname from pg_indexes where tablename = 'smart_search'`.execute(db);
      expect(indexes.rows.map(({ indexname }) => indexname)).toContain('clip_index');
      const rows = await db
        .selectFrom('smart_search')
        .select(['assetId', sql<string>`embedding::text`.as('embedding')])
        .execute();
      expect(rows).toEqual([{ assetId, embedding: embeddingOf(768, 0.5) }]);
    });

    it('should keep only the embeddings of the models it is told', async () => {
      const { sut, newPhoto, db } = await setup();
      const a = await sut.create({
        task: ModelTask.SEARCH,
        name: 'ViT-B-32__openai',
        fingerprint: 'a',
        format: 'onnx',
      });
      const b = await sut.create({
        task: ModelTask.SEARCH,
        name: 'ViT-B-32__openai',
        fingerprint: 'b',
        format: 'onnx',
      });
      const [first, second] = [await newPhoto(1), await newPhoto(2)];
      await sut.upsertRebuildEmbedding(first, a.id, embeddingOf(512, 0.1));
      await sut.upsertRebuildEmbedding(second, b.id, embeddingOf(512, 0.2));

      await sut.deleteRebuildEmbeddings([b.id]);
      await expect(db.selectFrom('smart_search_rebuild').select('assetId').execute()).resolves.toEqual([
        { assetId: second },
      ]);
      await sut.deleteRebuildEmbeddings();
      await expect(db.selectFrom('smart_search_rebuild').select('assetId').execute()).resolves.toEqual([]);
    });
  });

  describe('what the results are written with', () => {
    it('should change the text of a photo by the lines that changed only', async () => {
      const { ctx, db, newPhoto } = await setup();
      const ocr = ctx.get(OcrRepository);
      const assetId = await newPhoto(1);
      const line = (text: string) => ({
        assetId,
        x1: 0.1,
        y1: 0.1,
        x2: 0.5,
        y2: 0.1,
        x3: 0.5,
        y3: 0.2,
        x4: 0.1,
        y4: 0.2,
        boxScore: 0.9,
        textScore: 0.9,
        text,
      });
      await ocr.update(assetId, [], [line('kept'), line('gone')], 'kept gone');
      const [kept, gone] = await ocr.getByAssetId(assetId, {});
      await ocr.updateOcrVisibilities(assetId, [], [kept]);

      await ocr.update(assetId, [gone.id], [line('new')], 'kept new');

      const lines = await ocr.getByAssetId(assetId, {});
      expect(lines.map(({ id, text, isVisible }) => ({ id, text, isVisible }))).toEqual(
        expect.arrayContaining([
          { id: kept.id, text: 'kept', isVisible: false },
          { id: expect.any(String), text: 'new', isVisible: true },
        ]),
      );
      expect(lines).toHaveLength(2);
      await expect(
        db.selectFrom('ocr_search').select('text').where('assetId', '=', assetId).executeTakeFirst(),
      ).resolves.toEqual({ text: 'kept new' });

      await ocr.update(
        assetId,
        lines.map(({ id }) => id),
        [],
        '',
      );
      await expect(db.selectFrom('ocr_search').selectAll().where('assetId', '=', assetId).execute()).resolves.toEqual(
        [],
      );
    });

    it('should replace the embeddings of faces', async () => {
      const { ctx, db, newPhoto } = await setup();
      const assetId = await newPhoto(1);
      const { assetFace } = await ctx.newAssetFace({ assetId });
      await db
        .insertInto('face_search')
        .values({ faceId: assetFace.id, embedding: embeddingOf(512, 0.1) })
        .execute();

      await ctx
        .get(PersonRepository)
        .updateFaceEmbeddings([{ faceId: assetFace.id, embedding: embeddingOf(512, 0.5) }]);

      const rows = await db
        .selectFrom('face_search')
        .select(['faceId', sql<string>`embedding::text`.as('embedding')])
        .execute();
      expect(rows).toEqual([{ faceId: assetFace.id, embedding: embeddingOf(512, 0.5) }]);
    });
  });
});
