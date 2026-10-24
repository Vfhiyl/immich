import { Kysely } from 'kysely';
import { StorageCore } from 'src/cores/storage.core.js';
import { JobName } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ClusterGroupRepository } from 'src/repositories/cluster-group.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { FaceDecisionRepository } from 'src/repositories/face-decision.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PersonUserRepository } from 'src/repositories/person-user.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { PersonService } from 'src/services/person.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getTestKyselyDB } from 'test/utils.js';

// what users decide about faces in the web and the apps is kept apart from what facial recognition made of them
const setup = async () => {
  StorageCore.setMediaLocation('/data');
  const db: Kysely<DB> = await getTestKyselyDB();
  const { sut, ctx } = newMediumService(PersonService, {
    database: db,
    real: [
      AccessRepository,
      AssetRepository,
      ClusterGroupRepository,
      ConfigRepository,
      DatabaseRepository,
      FaceDecisionRepository,
      PersonRepository,
      PersonUserRepository,
      SystemMetadataRepository,
      UserRepository,
    ],
    mock: [JobRepository, LoggingRepository, StorageRepository],
  });
  ctx.getMock(StorageRepository).unlink.mockResolvedValue();
  ctx.getMock(JobRepository).queue.mockResolvedValue();
  ctx.getMock(JobRepository).queueAll.mockResolvedValue();
  const { user } = await ctx.newUser();
  const auth = factory.auth({ user });
  const { asset } = await ctx.newAsset({ ownerId: user.id });
  const newPerson = async (name = '') => {
    const { person } = await ctx.newPerson({ ownerId: user.id, name });
    return person.personGroupId;
  };
  const decisions = ctx.get(FaceDecisionRepository);
  return { sut, ctx, db, user, auth, asset, newPerson, decisions };
};

describe('decisions of users about faces', () => {
  it('should keep that a user moved a face to another person, and that it is not the first one', async () => {
    const { sut, ctx, auth, asset, newPerson, decisions } = await setup();
    const [wrong, right] = [await newPerson('Wrong'), await newPerson('Right')];
    const { assetFace } = await ctx.newAssetFace({ assetId: asset.id, personGroupId: wrong });

    await sut.reassignFacesById(auth, right, { id: assetFace.id });

    await expect(decisions.getAssigned([assetFace.id])).resolves.toEqual(new Set([assetFace.id]));
    await expect(decisions.getExcludedPeople(assetFace.id)).resolves.toEqual(new Set([wrong]));
  });

  it('should keep it for the faces of photos moved from a person page', async () => {
    const { sut, ctx, auth, asset, newPerson, decisions } = await setup();
    const [wrong, right] = [await newPerson('Wrong'), await newPerson('Right')];
    const { assetFace } = await ctx.newAssetFace({ assetId: asset.id, personGroupId: wrong });

    await sut.reassignFaces(auth, right, { data: [{ assetId: asset.id, personId: wrong }] });

    await expect(decisions.getAssigned([assetFace.id])).resolves.toEqual(new Set([assetFace.id]));
  });

  it('should take a face from its person when the user says it is not them, and look for its person again', async () => {
    const { sut, ctx, db, auth, asset, newPerson, decisions } = await setup();
    const person = await newPerson('Someone');
    const { assetFace } = await ctx.newAssetFace({ assetId: asset.id, personGroupId: person });

    await sut.rejectFace(auth, assetFace.id);

    const face = await db
      .selectFrom('asset_face')
      .select('personGroupId')
      .where('id', '=', assetFace.id)
      .executeTakeFirst();
    expect(face?.personGroupId).toBeNull();
    await expect(decisions.getExcludedPeople(assetFace.id)).resolves.toEqual(new Set([person]));
    expect(ctx.getMock(JobRepository).queue).toHaveBeenCalledWith({
      name: JobName.FacialRecognition,
      data: { id: assetFace.id, deferred: false },
    });
    await expect(sut.rejectFace(auth, assetFace.id)).rejects.toThrow('The face has no person');
  });

  it('should move the decisions with the faces as people are merged', async () => {
    const { sut, ctx, auth, asset, newPerson, decisions } = await setup();
    const [target, source, other] = [await newPerson('Target'), await newPerson(), await newPerson('Other')];
    const { assetFace } = await ctx.newAssetFace({ assetId: asset.id, personGroupId: other });
    await sut.reassignFacesById(auth, source, { id: assetFace.id });

    await sut.mergePeople(auth, { ids: [target, source] });

    await expect(decisions.getAssigned([assetFace.id])).resolves.toEqual(new Set([assetFace.id]));
    await expect(decisions.getExcludedPeople(assetFace.id)).resolves.toEqual(new Set([other]));
  });
});
