import { Kysely } from 'kysely';
import { SourceType } from 'src/enum.js';
import { FaceDecisionRepository } from 'src/repositories/face-decision.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getTestKyselyDB } from 'test/utils.js';

const setup = async () => {
  const db: Kysely<DB> = await getTestKyselyDB();
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: user.id });
  const newPerson = async () => {
    const { person } = await ctx.newPerson({ ownerId: user.id });
    return person.personGroupId;
  };
  const newFace = async (personGroupId: string | null = null, assetId = asset.id) => {
    const { assetFace } = await ctx.newAssetFace({ assetId, personGroupId });
    return assetFace.id;
  };
  const personOf = async (faceId: string) => {
    const face = await db
      .selectFrom('asset_face')
      .select('personGroupId')
      .where('id', '=', faceId)
      .executeTakeFirstOrThrow();
    return face.personGroupId;
  };
  return { ctx, db, user, asset, sut: ctx.get(FaceDecisionRepository), newPerson, newFace, personOf };
};

describe(FaceDecisionRepository.name, () => {
  it('should keep that a user gave a face a person, and that it is not the one it had', async () => {
    const { sut, user, newPerson, newFace, ctx } = await setup();
    const [before, after] = [await newPerson(), await newPerson()];
    const faceId = await newFace(after);

    await sut.assign([{ faceId, previous: before }], after, user.id);

    await expect(sut.getAssigned([faceId])).resolves.toEqual(new Set([faceId]));
    await expect(sut.getExcludedPeople(faceId)).resolves.toEqual(new Set([before]));

    // given back to the person it was taken from: no longer rejected
    await ctx.get(PersonRepository).reassignFace(faceId, before);
    await sut.assign([{ faceId, previous: after }], before, user.id);
    await expect(sut.getExcludedPeople(faceId)).resolves.toEqual(new Set([after]));
  });

  it('should count a face as given by the user only while it is still with that person', async () => {
    const { sut, user, newPerson, newFace, ctx } = await setup();
    const [person, other] = [await newPerson(), await newPerson()];
    const faceId = await newFace(person);
    await sut.assign([{ faceId, previous: null }], person, user.id);

    await ctx.get(PersonRepository).reassignFace(faceId, other);

    await expect(sut.getAssigned([faceId])).resolves.toEqual(new Set());
  });

  it('should take a face from its person for good', async () => {
    const { sut, user, newPerson, newFace, personOf } = await setup();
    const person = await newPerson();
    const faceId = await newFace(person);
    await sut.assign([{ faceId, previous: null }], person, user.id);

    await sut.unassign(faceId, person, user.id);

    await expect(personOf(faceId)).resolves.toBeNull();
    await expect(sut.getExcludedPeople(faceId)).resolves.toEqual(new Set([person]));
    await expect(sut.getAssigned([faceId])).resolves.toEqual(new Set());
  });

  it('should not give a face the person of another face of its photo', async () => {
    const { sut, newPerson, newFace, ctx, user } = await setup();
    const [person, elsewhere] = [await newPerson(), await newPerson()];
    const faceId = await newFace();
    await newFace(person);
    const { asset: other } = await ctx.newAsset({ ownerId: user.id });
    await newFace(elsewhere, other.id);

    await expect(sut.getExcludedPeople(faceId)).resolves.toEqual(new Set([person]));
  });

  it('should move the decisions about a person into the person it is merged into', async () => {
    const { sut, user, newPerson, newFace, ctx } = await setup();
    const [source, target, other] = [await newPerson(), await newPerson(), await newPerson()];
    const given = await newFace(source);
    const rejected = await newFace(other);
    await sut.assign([{ faceId: given, previous: null }], source, user.id);
    await sut.unassign(rejected, other, user.id);
    await ctx.get(PersonRepository).reassignFace(rejected, other);
    await ctx.database.insertInto('face_user_rejection').values({ faceId: rejected, personGroupId: source }).execute();

    await ctx.get(PersonRepository).reassignFaces({ oldPersonGroupId: source, newPersonGroupId: target });
    await sut.move({ ownerId: user.id, oldPersonGroupId: source, newPersonGroupId: target });

    await expect(sut.getAssigned([given])).resolves.toEqual(new Set([given]));
    await expect(sut.getExcludedPeople(rejected)).resolves.toEqual(new Set([other, source, target]));
  });

  it('should keep the faces a user gave a person when facial recognition is reset', async () => {
    const { sut, user, newPerson, newFace, ctx, personOf } = await setup();
    const person = await newPerson();
    const [given, automatic] = [await newFace(person), await newFace(person)];
    await sut.assign([{ faceId: given, previous: null }], person, user.id);

    await ctx.get(PersonRepository).unassignFaces({ sourceType: SourceType.MachineLearning });

    await expect(personOf(given)).resolves.toBe(person);
    await expect(personOf(automatic)).resolves.toBeNull();
  });
});
