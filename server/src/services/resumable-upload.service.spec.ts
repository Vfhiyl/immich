import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { StorageCore } from 'src/cores/storage.core.js';
import { JobStatus, UploadSessionStatus } from 'src/enum.js';
import { ResumableUploadService, getUploadPartSize } from 'src/services/resumable-upload.service.js';
import { UserFactory } from 'test/factories/user.factory.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const assetData = (data: object) => Buffer.from(JSON.stringify(data)).toString('base64url');
const validData = assetData({
  filename: 'IMG_1.jpg',
  fileCreatedAt: '2021-01-01T00:00:00.000Z',
  fileModifiedAt: '2021-01-01T00:00:00.000Z',
});
const emptyBody = () => Readable.from([]);

describe(ResumableUploadService.name, () => {
  let sut: ResumableUploadService;
  let mocks: ServiceMocks;
  let root: string;

  beforeEach(async () => {
    ({ sut, mocks } = newTestService(ResumableUploadService));
    root = await fs.mkdtemp(join(tmpdir(), 'immich-resumable-'));
    StorageCore.setMediaLocation(root);
  });

  afterEach(async () => {
    StorageCore.setMediaLocation('/data');
    await fs.rm(root, { recursive: true, force: true });
  });

  describe(getUploadPartSize.name, () => {
    it('should use parts of 16 MiB, larger ones for large files, and 64 MiB for files of unknown length', () => {
      expect(getUploadPartSize(1000)).toBe(16 * 1024 * 1024);
      expect(getUploadPartSize(10_000 * 16 * 1024 * 1024)).toBe(16 * 1024 * 1024);
      // 200 GiB in 10,000 parts, in steps of 256 KiB
      expect(getUploadPartSize(200 * 1024 ** 3)).toBe(82 * 256 * 1024);
      expect(getUploadPartSize(200 * 1024 ** 3) % (256 * 1024)).toBe(0);
      expect(getUploadPartSize()).toBe(64 * 1024 * 1024);
    });
  });

  describe('getOptions', () => {
    it('should tell the limits, with the largest request a deployment allows', () => {
      expect(sut.getOptions().headers['Upload-Limit']).toBe('min-size=0, max-age=86400');

      mocks.config.getEnv.mockReturnValue({
        ...mocks.config.getEnv(),
        storage: { ...mocks.config.getEnv().storage, uploadMaxAppendSize: 100 * 1000 * 1000 },
      });
      expect(sut.getOptions().headers['Upload-Limit']).toBe('min-size=0, max-append-size=100000000, max-age=86400');
    });
  });

  describe('createUpload', () => {
    it('should need Upload-Complete', async () => {
      const response = await sut.createUpload({
        auth: authStub.admin,
        headers: { 'x-immich-asset-data': validData },
        body: emptyBody(),
      });
      expect(response).toMatchObject({ status: 400, body: { message: expect.stringContaining('Upload-Complete') } });
    });

    it.each([
      ['missing', undefined, 'is missing'],
      ['not base64url JSON', 'not json', 'base64url encoded JSON'],
      [
        'without a file name',
        assetData({ fileCreatedAt: '2021-01-01T00:00:00Z', fileModifiedAt: '2021-01-01T00:00:00Z' }),
        'filename',
      ],
      [
        'with an invalid date',
        assetData({ filename: 'a.jpg', fileCreatedAt: 'yesterday', fileModifiedAt: 'today' }),
        'fileCreatedAt',
      ],
    ])('should reject asset data that is %s', async (_, data, message) => {
      const response = await sut.createUpload({
        auth: authStub.admin,
        headers: { 'upload-complete': '?1', ...(data && { 'x-immich-asset-data': data }) },
        body: emptyBody(),
      });
      expect(response).toMatchObject({ status: 400, body: { message: expect.stringContaining(message) } });
      expect(mocks.uploadSession.create).not.toHaveBeenCalled();
    });

    it('should reject an interop version it does not support', async () => {
      const response = await sut.createUpload({
        auth: authStub.admin,
        headers: { 'upload-draft-interop-version': '2', 'upload-complete': '?1', 'x-immich-asset-data': validData },
        body: emptyBody(),
      });
      expect(response).toMatchObject({ status: 400 });
    });

    it('should answer with the asset the user has already, without uploading', async () => {
      mocks.asset.getUploadAssetIdByChecksum.mockResolvedValue('existing-id');
      const response = await sut.createUpload({
        auth: authStub.admin,
        headers: {
          'upload-complete': '?0',
          'repr-digest': `sha=:${Buffer.alloc(20).toString('base64')}:`,
          'x-immich-asset-data': validData,
        },
        body: emptyBody(),
      });

      expect(response).toEqual({ status: 200, headers: {}, body: { id: 'existing-id', status: 'duplicate' } });
      expect(mocks.uploadSession.create).not.toHaveBeenCalled();
    });

    it('should set aside the quota for uploads still being received', async () => {
      mocks.user.get.mockResolvedValue(UserFactory.create({ quotaSizeInBytes: 1000, quotaUsageInBytes: 500 }));
      mocks.uploadSession.getReservedBytes.mockResolvedValue(400);

      await expect(
        sut.createUpload({
          auth: authStub.admin,
          headers: { 'upload-complete': '?0', 'upload-length': '200', 'x-immich-asset-data': validData },
          body: emptyBody(),
        }),
      ).rejects.toThrow('Quota has been exceeded');
      expect(mocks.uploadSession.create).not.toHaveBeenCalled();
    });
  });

  describe('handleUploadSessionCleanup', () => {
    it('should drop expired uploads, with what they wrote to the backend', async () => {
      const media = mocks.storageBackend.get('media');
      const upload = await media.createUpload('upload/a.jpg', { partSize: 16 * 1024 * 1024 });
      await media.uploadPart('upload/a.jpg', upload, { number: 1, data: Buffer.alloc(10) });
      const abort = vi.spyOn(media, 'abortUpload');
      mocks.uploadSession.getExpired.mockResolvedValue([
        {
          id: 'session-id',
          status: UploadSessionStatus.Receiving,
          backendId: 'media',
          key: 'upload/a.jpg',
          blobUploadId: upload.uploadId,
          partSize: upload.partSize,
          encryption: null,
        } as never,
      ]);
      mocks.uploadSession.delete.mockResolvedValue();

      await expect(sut.handleUploadSessionCleanup()).resolves.toBe(JobStatus.Success);

      expect(abort).toHaveBeenCalledWith('upload/a.jpg', expect.objectContaining({ uploadId: upload.uploadId }));
      expect(mocks.uploadSession.delete).toHaveBeenCalledWith('session-id');
      await expect(fs.readdir(join(root, 'upload'))).resolves.toEqual([]);
    });
  });
});
