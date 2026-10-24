import { Injectable } from '@nestjs/common';
import { ExpressionBuilder, Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { AssetFileType, AssetVisibility, VectorIndex } from 'src/enum.js';
import { ModelTask } from 'src/repositories/machine-learning.repository.js';
import { DB } from 'src/schema/index.js';
import { vectorIndexQuery } from 'src/utils/database.js';

export type RebuildPhase = 'missing' | 'stale';

type Eligible = ExpressionBuilder<DB & { job_status: DB['asset_job_status'] }, 'asset' | 'job_status'>;

export interface RebuildSelection {
  /** The models whose results count as the target's (see `isCompatible`) */
  modelIds: string[];
  /** Whether results made before models were recorded count as the target's */
  legacy: boolean;
}

/**
 * The models that made results (`ml_model`), which made the results of each photo (`asset_ml_result`), and the
 * embeddings of smart search made for a model it changes to (`smart_search_rebuild`)
 */
@Injectable()
export class MachineLearningModelRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [DummyValue.UUID] })
  get(id: string) {
    return this.db.selectFrom('ml_model').selectAll().where('id', '=', id).executeTakeFirst();
  }

  @GenerateSql({ params: [ModelTask.SEARCH, DummyValue.STRING, DummyValue.STRING] })
  find(task: ModelTask, name: string, fingerprint: string | null) {
    return this.db
      .selectFrom('ml_model')
      .selectAll()
      .where('task', '=', task)
      .where('name', '=', name)
      .where((eb) => (fingerprint === null ? eb('fingerprint', 'is', null) : eb('fingerprint', '=', fingerprint)))
      .executeTakeFirst();
  }

  @GenerateSql({ params: [ModelTask.SEARCH] })
  getAll(task: ModelTask) {
    return this.db.selectFrom('ml_model').selectAll().where('task', '=', task).orderBy('createdAt').execute();
  }

  /** Records a model the first time it is seen; another worker may have done so meanwhile */
  @GenerateSql({ params: [{ task: ModelTask.SEARCH, name: DummyValue.STRING, fingerprint: DummyValue.STRING }] })
  async create(model: { task: ModelTask; name: string; fingerprint: string | null; format: string | null }) {
    await this.db
      .insertInto('ml_model')
      .values(model)
      .onConflict((oc) =>
        model.fingerprint === null
          ? oc.columns(['task', 'name']).where('fingerprint', 'is', null).doNothing()
          : oc.columns(['task', 'name', 'fingerprint']).where('fingerprint', 'is not', null).doNothing(),
      )
      .execute();
    return (await this.find(model.task, model.name, model.fingerprint))!;
  }

  @GenerateSql({ params: [DummyValue.UUID, { lastSeenAt: DummyValue.DATE }] })
  async update(
    id: string,
    values: { lastSeenAt?: Date; format?: string | null; retiredAt?: Date | null },
  ): Promise<void> {
    await this.db.updateTable('ml_model').set(values).where('id', '=', id).execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, ModelTask.FACIAL_RECOGNITION] })
  async getResult(assetId: string, task: ModelTask) {
    const row = await this.db
      .selectFrom('asset_ml_result')
      .select('modelId')
      .where('assetId', '=', assetId)
      .where('task', '=', task)
      .executeTakeFirst();
    return row?.modelId ?? null;
  }

  @GenerateSql({ params: [DummyValue.UUID, ModelTask.FACIAL_RECOGNITION, DummyValue.UUID] })
  async setResult(assetId: string, task: ModelTask, modelId: string): Promise<void> {
    await this.db
      .insertInto('asset_ml_result')
      .values({ assetId, task, modelId })
      .onConflict((oc) => oc.columns(['assetId', 'task']).doUpdateSet({ modelId }))
      .execute();
  }

  /** The photos whose results a task makes again for a model, the newest first: those without results first */
  @GenerateSql({
    params: [ModelTask.FACIAL_RECOGNITION, 'stale', { modelIds: [DummyValue.UUID], legacy: true }],
    stream: true,
  })
  streamForRebuild(task: ModelTask, phase: RebuildPhase, selection: RebuildSelection) {
    return this.eligible(task)
      .where((eb) => (phase === 'missing' ? this.hasNoResult(eb, task) : eb.not(this.hasNoResult(eb, task))))
      .where((eb) => eb.not(this.isOf(eb, task, selection)))
      .select('asset.id')
      .orderBy('asset.fileCreatedAt', 'desc')
      .orderBy('asset.id', 'desc')
      .stream();
  }

  /** How many photos a task makes results for, and how many of them have results of the model `selection` names */
  @GenerateSql({ params: [ModelTask.FACIAL_RECOGNITION, { modelIds: [DummyValue.UUID], legacy: true }] })
  async getProgress(task: ModelTask, selection: RebuildSelection) {
    const { total, done } = await this.eligible(task)
      .select((eb) => [
        eb.fn.countAll<number>().as('total'),
        eb.fn
          .countAll<number>()
          .filterWhere(this.isOf(eb, task, selection))
          .as('done'),
      ])
      .executeTakeFirstOrThrow();
    return { total: Number(total), done: Number(done) };
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID, DummyValue.VECTOR] })
  async upsertRebuildEmbedding(assetId: string, modelId: string, embedding: string): Promise<void> {
    await this.db
      .insertInto('smart_search_rebuild')
      .values({ assetId, modelId, embedding })
      .onConflict((oc) => oc.column('assetId').doUpdateSet({ modelId, embedding }))
      .execute();
  }

  /** Keeps only the embeddings of `modelIds` (all of them without) */
  @GenerateSql({ params: [[DummyValue.UUID]] })
  async deleteRebuildEmbeddings(keepModelIds: string[] = []): Promise<void> {
    await this.db
      .deleteFrom('smart_search_rebuild')
      .$if(keepModelIds.length > 0, (qb) => qb.where('modelId', 'not in', keepModelIds))
      .execute();
  }

  /**
   * Moves the embeddings of `modelIds` to what is searched, at once: searches see either all of the old ones or all
   * of the new ones. Photos without one have none afterwards (the job of missing embeddings makes them). With another
   * dimension, the column changes and the index is built again in the same transaction, while searches wait.
   */
  async switchSmartSearch({
    modelIds,
    dimSize,
    currentDimSize,
    vectorExtension,
  }: {
    modelIds: string[];
    dimSize: number;
    currentDimSize: number;
    vectorExtension: Parameters<typeof vectorIndexQuery>[0]['vectorExtension'];
  }): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      if (dimSize === currentDimSize) {
        await sql`
          delete from smart_search s
          where not exists (
            select from smart_search_rebuild r where r."assetId" = s."assetId" and r."modelId" = any(${modelIds}::uuid[])
          )`.execute(trx);
      } else {
        await sql`delete from smart_search`.execute(trx);
        await sql`drop index if exists ${sql.raw(VectorIndex.Clip)}`.execute(trx);
        await sql`alter table smart_search alter column embedding set data type vector(${sql.raw(String(dimSize))})`.execute(
          trx,
        );
      }
      await sql`
        insert into smart_search ("assetId", embedding)
        select "assetId", embedding from smart_search_rebuild where "modelId" = any(${modelIds}::uuid[])
        on conflict ("assetId") do update set embedding = excluded.embedding`.execute(trx);
      if (dimSize !== currentDimSize) {
        await sql
          .raw(vectorIndexQuery({ vectorExtension, table: 'smart_search', indexName: VectorIndex.Clip }))
          .execute(trx);
      }
      await sql`delete from smart_search_rebuild`.execute(trx);
    });
  }

  /** The photos a task makes results for (as upstream's jobs select them) */
  private eligible(task: ModelTask) {
    const query = this.db
      .selectFrom('asset')
      .innerJoin('asset_job_status as job_status', 'job_status.assetId', 'asset.id')
      .where('asset.visibility', '!=', AssetVisibility.Hidden)
      .where('asset.deletedAt', 'is', null);
    return task === ModelTask.OCR
      ? query
      : query.where((eb) =>
          eb.exists(
            eb
              .selectFrom('asset_file')
              .whereRef('asset_file.assetId', '=', 'asset.id')
              .where('asset_file.type', '=', AssetFileType.Preview),
          ),
        );
  }

  private hasNoResult(eb: Eligible, task: ModelTask) {
    switch (task) {
      case ModelTask.SEARCH: {
        return eb.not(eb.exists(eb.selectFrom('smart_search').whereRef('smart_search.assetId', '=', 'asset.id')));
      }
      case ModelTask.FACIAL_RECOGNITION: {
        return eb('job_status.facesRecognizedAt', 'is', null);
      }
      case ModelTask.OCR: {
        return eb('job_status.ocrAt', 'is', null);
      }
    }
  }

  /** Whether the results of a photo are of the model `selection` names */
  private isOf(eb: Eligible, task: ModelTask, { modelIds, legacy }: RebuildSelection) {
    if (task === ModelTask.SEARCH) {
      // the embeddings searched are all of one model; those of the model it changes to are kept apart
      return eb.exists(
        eb
          .selectFrom('smart_search_rebuild')
          .whereRef('smart_search_rebuild.assetId', '=', 'asset.id')
          .where('smart_search_rebuild.modelId', '=', eb.fn.any(eb.val(modelIds))),
      );
    }
    const recorded = eb
      .selectFrom('asset_ml_result')
      .whereRef('asset_ml_result.assetId', '=', 'asset.id')
      .where('asset_ml_result.task', '=', task);
    return eb.or([
      eb.exists(recorded.where('asset_ml_result.modelId', '=', eb.fn.any(eb.val(modelIds)))),
      ...(legacy ? [eb.and([eb.not(this.hasNoResult(eb, task)), eb.not(eb.exists(recorded))])] : []),
    ]);
  }
}
