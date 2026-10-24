import { Injectable } from '@nestjs/common';
import { ExpressionBuilder, Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { AssetFileType, AssetVisibility, SourceType, VectorIndex } from 'src/enum.js';
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

  /** Keeps who every face belonged to as the regroup starts: to show what changed, and to undo it */
  @GenerateSql()
  async snapshotFaceAssignments(): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await sql`delete from face_regroup`.execute(trx);
      await sql`
        insert into face_regroup ("faceId", "before")
        select id, "personGroupId" from asset_face where "personGroupId" is not null and "deletedAt" is null`.execute(
        trx,
      );
    });
  }

  /** The people with faces facial recognition gave them, after `after` (by id), in order */
  @GenerateSql({ params: [DummyValue.UUID, 100] })
  getPeopleToRegroup(after: string | null, limit: number) {
    return this.db
      .selectFrom('person_group')
      .select('person_group.id')
      .$if(!!after, (qb) => qb.where('person_group.id', '>', after!))
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('asset_face')
            .whereRef('asset_face.personGroupId', '=', 'person_group.id')
            .where('asset_face.sourceType', '=', SourceType.MachineLearning)
            .where('asset_face.deletedAt', 'is', null),
        ),
      )
      .orderBy('person_group.id')
      .limit(limit)
      .execute();
  }

  /**
   * The faces of a person with an embedding: which are fixed (a user gave them, or they were drawn or read from a
   * file), and which is the face of its picture
   */
  @GenerateSql({ params: [DummyValue.UUID] })
  getFacesToRegroup(personGroupId: string) {
    return this.db
      .selectFrom('asset_face')
      .innerJoin('face_search', 'face_search.faceId', 'asset_face.id')
      .select(['asset_face.id'])
      .select((eb) => [
        eb
          .or([
            eb('asset_face.sourceType', '!=', SourceType.MachineLearning),
            eb.exists(
              eb
                .selectFrom('face_user_assignment')
                .whereRef('face_user_assignment.faceId', '=', 'asset_face.id')
                .whereRef('face_user_assignment.personGroupId', '=', 'asset_face.personGroupId'),
            ),
          ])
          .as('isFixed'),
        eb.exists(eb.selectFrom('person').whereRef('person.faceAssetId', '=', 'asset_face.id')).as('isCover'),
      ])
      .where('asset_face.personGroupId', '=', personGroupId)
      .where('asset_face.deletedAt', 'is', null)
      .execute();
  }

  /** Pairs of faces of a person closer than `maxDistance`: all of them for a person with few faces */
  @GenerateSql({ params: [DummyValue.UUID, 0.5] })
  async getCloseFacePairs(personGroupId: string, maxDistance: number) {
    const { rows } = await sql<{ a: string; b: string }>`
      with faces as (
        select fs."faceId", fs.embedding from face_search fs
        join asset_face af on af.id = fs."faceId"
        where af."personGroupId" = ${personGroupId} and af."deletedAt" is null
      )
      select a."faceId" as a, b."faceId" as b from faces a join faces b on a."faceId" < b."faceId"
      where (a.embedding <=> b.embedding) <= ${maxDistance}`.execute(this.db);
    return rows;
  }

  /** For a person with many faces: each of `faceIds` with the nearest faces of the same person (by the vector index) */
  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID], 0.5, 20] })
  async getNearFacePairs(personGroupId: string, faceIds: string[], maxDistance: number, neighbours: number) {
    const { rows } = await sql<{ a: string; b: string }>`
      select f."faceId" as a, n."faceId" as b from face_search f
      cross join lateral (
        select s."faceId", s.embedding <=> f.embedding as distance from face_search s
        order by s.embedding <=> f.embedding limit ${neighbours}
      ) n
      join asset_face other on other.id = n."faceId"
      where f."faceId" = any(${faceIds}::uuid[]) and n."faceId" <> f."faceId" and n.distance <= ${maxDistance}
        and other."personGroupId" = ${personGroupId} and other."deletedAt" is null`.execute(this.db);
    return rows;
  }

  /** The people (of every owner) whose picture is one of `faceIds` */
  @GenerateSql({ params: [[DummyValue.UUID]] })
  getPeopleWithPicture(faceIds: string[]) {
    return this.db
      .selectFrom('person')
      .select(['person.ownerId', 'person.personGroupId'])
      .where('person.faceAssetId', 'in', faceIds)
      .execute();
  }

  /** Takes faces from a person, unless a user gave them to it meanwhile */
  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID]] })
  async takeFromPerson(personGroupId: string, faceIds: string[]): Promise<void> {
    if (faceIds.length === 0) {
      return;
    }
    await this.db
      .updateTable('asset_face')
      .set({ personGroupId: null })
      .where('id', 'in', faceIds)
      .where('personGroupId', '=', personGroupId)
      .where(({ not, exists, selectFrom }) =>
        not(exists(selectFrom('face_user_assignment').whereRef('face_user_assignment.faceId', '=', 'asset_face.id'))),
      )
      .execute();
  }

  /** What the last regroup changed, per person: the faces it had, those that left it, and those that joined it */
  @GenerateSql()
  async getRegroupChanges() {
    const { rows } = await sql<{
      personGroupId: string;
      names: string | null;
      before: number;
      left: number;
      joined: number;
    }>`
      with before as (
        select r."before" as g, count(*)::int as before,
          count(*) filter (where af.id is null or af."personGroupId" is distinct from r."before")::int as "left"
        from face_regroup r
        left join asset_face af on af.id = r."faceId" and af."deletedAt" is null
        where r."before" is not null
        group by r."before"
      ),
      joined as (
        select af."personGroupId" as g, count(*)::int as joined
        from asset_face af
        left join face_regroup r on r."faceId" = af.id
        where af."personGroupId" is not null and af."deletedAt" is null and r."before" is distinct from af."personGroupId"
        group by af."personGroupId"
      )
      select coalesce(b.g, j.g) as "personGroupId",
        (select string_agg(distinct p.name, ', ') from person p where p."personGroupId" = coalesce(b.g, j.g) and p.name <> '') as names,
        coalesce(b.before, 0) as before, coalesce(b."left", 0) as "left", coalesce(j.joined, 0) as joined
      from before b
      full join joined j on j.g = b.g
      where coalesce(b."left", 0) > 0 or coalesce(j.joined, 0) > 0
      order by coalesce(b."left", 0) + coalesce(j.joined, 0) desc`.execute(this.db);
    return rows;
  }

  /**
   * Puts the faces back where they were before the last regroup, but for what users did since (gave a face a person,
   * or said it is not the person it had) and people that are gone
   */
  @GenerateSql()
  async undoRegroup(): Promise<number> {
    return this.db.transaction().execute(async (trx) => {
      const result = await sql`
        update asset_face af set "personGroupId" = r."before"
        from face_regroup r
        where af.id = r."faceId" and r."before" is not null and af."deletedAt" is null
          and af."personGroupId" is distinct from r."before"
          and exists (select from person_group g where g.id = r."before")
          and not exists (
            select from face_user_assignment a where a."faceId" = af.id and a."createdAt" > r."createdAt"
          )
          and not exists (
            select from face_user_rejection x where x."faceId" = af.id and x."personGroupId" = r."before"
          )`.execute(trx);
      await sql`delete from face_regroup`.execute(trx);
      return Number(result.numAffectedRows ?? 0);
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
