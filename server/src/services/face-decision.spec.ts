import { AssetFileType, ImmichWorker, JobStatus } from 'src/enum.js';
import { PersonService } from 'src/services/person.service.js';
import { AssetFaceFactory } from 'test/factories/asset-face.factory.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { faceModel, getForDetectedFaces, getForFaceSearch, getForFacialRecognitionJob } from 'test/mappers.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

// facial recognition keeps to what users decided about faces
describe('decisions of users in facial recognition', () => {
  let sut: PersonService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(PersonService));
    mocks.config.getWorker.mockReturnValue(ImmichWorker.Microservices);
  });

  describe('recognizing a face', () => {
    const asset = AssetFactory.create();
    const face = AssetFaceFactory.create({ assetId: asset.id });
    const rejected = AssetFaceFactory.from().person({ ownerId: asset.ownerId }).build();
    const other = AssetFaceFactory.from().person({ ownerId: asset.ownerId }).build();

    beforeEach(() => {
      mocks.person.getFaceForFacialRecognitionJob.mockResolvedValue(getForFacialRecognitionJob(face, asset));
      // the face itself, then the nearest face (of a person the user said it is not), then another person
      mocks.search.searchFaces.mockResolvedValue([
        getForFaceSearch(face, 0),
        getForFaceSearch(rejected, 0.1),
        getForFaceSearch(other, 0.2),
      ]);
      mocks.person.getByGroupId.mockResolvedValue(other.person!);
    });

    it('should not give it a person it is not, nor the person of another face of its photo', async () => {
      mocks.faceDecision.getExcludedPeople.mockResolvedValue(new Set([rejected.personGroupId!]));

      await expect(sut.handleRecognizeFaces({ id: face.id })).resolves.toBe(JobStatus.Success);

      expect(mocks.faceDecision.getExcludedPeople).toHaveBeenCalledWith(face.id);
      expect(mocks.person.reassignFaces).toHaveBeenCalledWith({
        faceIds: [face.id],
        newPersonGroupId: other.personGroupId,
      });
    });

    it('should look further for a person when every near one is excluded', async () => {
      mocks.faceDecision.getExcludedPeople.mockResolvedValue(new Set([rejected.personGroupId!, other.personGroupId!]));
      const farther = AssetFaceFactory.from().person({ ownerId: asset.ownerId }).build();
      mocks.search.searchFaces
        .mockResolvedValueOnce([
          getForFaceSearch(face, 0),
          getForFaceSearch(rejected, 0.1),
          getForFaceSearch(other, 0.2),
        ])
        .mockResolvedValueOnce([
          getForFaceSearch(rejected, 0.1),
          getForFaceSearch(other, 0.2),
          getForFaceSearch(farther, 0.3),
        ]);
      mocks.person.getByGroupId.mockResolvedValue(farther.person!);

      await sut.handleRecognizeFaces({ id: face.id });

      expect(mocks.search.searchFaces).toHaveBeenLastCalledWith(
        expect.objectContaining({ hasPerson: true, numResults: 3 }),
      );
      expect(mocks.person.reassignFaces).toHaveBeenCalledWith({
        faceIds: [face.id],
        newPersonGroupId: farther.personGroupId,
      });
    });
  });

  describe('detecting faces again', () => {
    it('should keep a face the user gave a person when it is not found again', async () => {
      const given = AssetFaceFactory.from().person().build();
      const automatic = AssetFaceFactory.from().person().build();
      const asset = AssetFactory.from()
        .face(given)
        .face(automatic)
        .file({ type: AssetFileType.Preview })
        .exif()
        .build();
      mocks.assetJob.getForDetectFacesJob.mockResolvedValue(getForDetectedFaces(asset));
      mocks.machineLearning.detectFaces.mockResolvedValue({
        imageHeight: 500,
        imageWidth: 400,
        faces: [],
        model: faceModel,
      });
      mocks.faceDecision.getAssigned.mockResolvedValue(new Set([given.id]));
      mocks.person.refreshFaces.mockResolvedValue();

      await sut.handleDetectFaces({ id: asset.id });

      expect(mocks.faceDecision.getAssigned).toHaveBeenCalledWith([given.id, automatic.id]);
      expect(mocks.person.refreshFaces).toHaveBeenCalledWith([], [automatic.id], []);
      // the same model: its embedding is still comparable
      expect(mocks.person.deleteFaceEmbeddings).not.toHaveBeenCalled();
    });
  });
});
