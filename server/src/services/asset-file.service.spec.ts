import { BadRequestException } from '@nestjs/common';
import { AssetFileType, JobName } from 'src/enum.js';
import { AssetFileService } from 'src/services/asset-file.service.js';
import { AssetFileFactory } from 'test/factories/asset-file.factory.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

describe(AssetFileService.name, () => {
  let sut: AssetFileService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(AssetFileService));
  });

  describe('delete', () => {
    it('should delete a file on a storage backend by its location', async () => {
      const file = AssetFileFactory.create({ type: AssetFileType.Preview, backendId: 'derived', key: 'preview-key' });
      mocks.access.assetFile.checkOwnerAccess.mockResolvedValue(new Set([file.id]));
      mocks.assetFile.get.mockResolvedValue(file);
      mocks.assetFile.delete.mockResolvedValue(true);

      await sut.delete(authStub.admin, file.id);

      expect(mocks.assetFile.delete).toHaveBeenCalledWith(file.id);
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.FileDelete,
        data: { files: [], locations: [{ backendId: 'derived', key: 'preview-key' }] },
      });
    });

    it('should delete a file without a recorded location by its path', async () => {
      const file = AssetFileFactory.create({ type: AssetFileType.Preview });
      mocks.access.assetFile.checkOwnerAccess.mockResolvedValue(new Set([file.id]));
      mocks.assetFile.get.mockResolvedValue(file);
      mocks.assetFile.delete.mockResolvedValue(true);

      await sut.delete(authStub.admin, file.id);

      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.FileDelete,
        data: { files: [file.path], locations: [] },
      });
    });

    it('should not delete a sidecar', async () => {
      const file = AssetFileFactory.create({ type: AssetFileType.Sidecar });
      mocks.access.assetFile.checkOwnerAccess.mockResolvedValue(new Set([file.id]));
      mocks.assetFile.get.mockResolvedValue(file);

      await expect(sut.delete(authStub.admin, file.id)).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.assetFile.delete).not.toHaveBeenCalled();
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });
  });
});
