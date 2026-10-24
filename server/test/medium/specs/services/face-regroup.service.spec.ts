import { Kysely, sql } from 'kysely';
import { defaults } from 'src/dtos/config.dto.js';
import { JobName, SystemMetadataKey } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { FaceDecisionRepository } from 'src/repositories/face-decision.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { ModelTask } from 'src/repositories/machine-learning.repository.js';
import { MachineLearningModelRepository } from 'src/repositories/ml-model.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { MachineLearningModelService } from 'src/services/ml-model.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getTestKyselyDB } from 'test/utils.js';

/** A unit vector along `axis`, a little off it so that faces of one person are close but not equal */
const embedding = (axis: number, wobble = 0) =>
  `[${Array.from({ length: 512 }, (_, index) => (index === axis ? 1 : index === 500 ? wobble : 0))}]`;

const setup = async () => {
  const db: Kysely<DB> = await getTestKyselyDB();
  const { sut, ctx } = newMediumService(MachineLearningModelService, {
    database: db,
    real: [
      ConfigRepository,
      DatabaseRepository,
      FaceDecisionRepository,
      MachineLearningModelRepository,
      PersonRepository,
      SystemMetadataRepository,
    ],
    mock: [JobRepository, LoggingRepository],
  });
  ctx.getMock(JobRepository).queue.mockResolvedValue();
  ctx.getMock(JobRepository).queueAll.mockResolvedValue();
  const { user } = await ctx.newUser();
  const newPerson = async (name: string) => {
    const { person } = await ctx.newPerson({ ownerId: user.id, name });
    return person.personGroupId;
  };
  /** A face of a photo of its own with an embedding along `axis` */
  const newFace = async (personGroupId: string, axis: number, wobble = 0) => {
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const { assetFace } = await ctx.newAssetFace({ assetId: asset.id, personGroupId });
    await db
      .insertInto('face_search')
      .values({ faceId: assetFace.id, embedding: embedding(axis, wobble) })
      .execute();
    return assetFace.id;
  };
  const personOf = async (faceId: string) => {
    const face = await db.selectFrom('asset_face').select('personGroupId').where('id', '=', faceId).executeTakeFirst();
    return face?.personGroupId;
  };
  /** As the rebuild of faces leaves it: every face detected again, the regroup about to start */
  const startRegroup = async () => {
    const repository = ctx.get(MachineLearningModelRepository);
    await repository.snapshotFaceAssignments();
    const generation = 2;
    await ctx.get(SystemMetadataRepository).set(SystemMetadataKey.MachineLearningModels, {
      [ModelTask.FACIAL_RECOGNITION]: {
        legacyName: 'buffalo_l',
        target: { name: defaults.machineLearning.facialRecognition.modelName, modelId: null },
        generation,
        rebuild: { startedAt: new Date().toISOString() },
        regroup: { generation, startedAt: new Date().toISOString() },
      },
    });
    return generation;
  };
  return { sut, ctx, db, user, newPerson, newFace, personOf, startRegroup };
};

describe('regrouping people after a change of the face model', () => {
  it('should take the faces no longer close to their person, keep the faces users gave, and undo it', async () => {
    const { sut, ctx, user, newPerson, newFace, personOf, startRegroup } = await setup();
    const mom = await newPerson('Mom');
    const momFaces = [await newFace(mom, 1), await newFace(mom, 1, 0.1), await newFace(mom, 1, 0.2)];
    const stray = await newFace(mom, 7);
    const dad = await newPerson('Dad');
    const dadFaces = [await newFace(dad, 2), await newFace(dad, 2, 0.1)];
    // an unusual face a user gave Dad stays, and does not push his other faces out
    const given = await newFace(dad, 9);
    await ctx.get(FaceDecisionRepository).assign([{ faceId: given, previous: null }], dad, user.id);

    const generation = await startRegroup();
    await sut.handleFaceRegroup({ generation });

    for (const face of momFaces) {
      await expect(personOf(face)).resolves.toBe(mom);
    }
    await expect(personOf(stray)).resolves.toBeNull();
    for (const face of [...dadFaces, given]) {
      await expect(personOf(face)).resolves.toBe(dad);
    }
    expect(ctx.getMock(JobRepository).queue).toHaveBeenCalledWith({
      name: JobName.FacialRecognitionQueueAll,
      data: { force: false },
    });

    const { tasks } = await sut.getModels();
    expect(tasks.find(({ task }) => task === ModelTask.FACIAL_RECOGNITION)?.regroup).toMatchObject({
      facesLeft: 1,
      facesJoined: 0,
      people: [{ personGroupId: mom, names: 'Mom', before: 4, left: 1, joined: 0 }],
    });

    await sut.undoFaceRegroup();
    await expect(personOf(stray)).resolves.toBe(mom);
  });

  it('should not undo what users did since the regroup', async () => {
    const { sut, ctx, user, newPerson, newFace, personOf, startRegroup } = await setup();
    const mom = await newPerson('Mom');
    await newFace(mom, 1);
    await newFace(mom, 1, 0.1);
    const [strayA, strayB] = [await newFace(mom, 7), await newFace(mom, 8)];
    const aunt = await newPerson('Aunt');
    const generation = await startRegroup();
    await sut.handleFaceRegroup({ generation });

    // meanwhile a user gives one of them to the aunt, and says the other is not Mom
    await new Promise((resolve) => setTimeout(resolve, 10));
    await ctx.get(PersonRepository).reassignFace(strayA, aunt);
    await ctx.get(FaceDecisionRepository).assign([{ faceId: strayA, previous: null }], aunt, user.id);
    await ctx.database.insertInto('face_user_rejection').values({ faceId: strayB, personGroupId: mom }).execute();
    await sut.undoFaceRegroup();

    await expect(personOf(strayA)).resolves.toBe(aunt);
    await expect(personOf(strayB)).resolves.toBeNull();
  });

  it('should find the close faces of a large person by the vector index as well', async () => {
    const { ctx, newPerson, newFace } = await setup();
    const person = await newPerson('Someone');
    const near = [await newFace(person, 3), await newFace(person, 3, 0.1), await newFace(person, 3, 0.2)];
    const far = await newFace(person, 4);
    const repository = ctx.get(MachineLearningModelRepository);

    const pairs = await repository.getNearFacePairs(person, [...near, far], 0.5, 20);

    const linked = new Set(pairs.flatMap(({ a, b }) => [a, b]));
    expect([...linked].toSorted()).toEqual([...near].toSorted());
    await expect(repository.getCloseFacePairs(person, 0.5)).resolves.toHaveLength(3);
    const { rows } = await sql<{ count: number }>`select count(*)::int as count from face_regroup`.execute(
      ctx.database,
    );
    expect(rows).toEqual([{ count: 0 }]);
  });
});
