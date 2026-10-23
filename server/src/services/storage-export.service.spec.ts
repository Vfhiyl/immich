import { join } from 'node:path';
import type { StorageExportState } from 'src/types.js';
import { JobName, JobStatus, NotificationLevel, SystemMetadataKey } from 'src/enum.js';
import { StorageExportService, toTemplateTarget } from 'src/services/storage-export.service.js';
import { ExportedAsset } from 'src/utils/export-tool.js';
import { compileStorageTemplate } from 'src/utils/storage-template.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const asset = (overrides: Partial<ExportedAsset> = {}): ExportedAsset => ({
  id: 'b3f4d2a1-0000-4000-8000-000000000001',
  ownerId: 'user-1',
  ownerEmail: 'ann@example.com',
  type: 'IMAGE',
  originalFileName: 'IMG_0001.HEIC',
  originalPath: '/data/upload/IMG_0001.HEIC',
  fileCreatedAt: new Date('2021-07-04T18:30:00.000Z'),
  localDateTime: new Date('2021-07-04T20:30:00.000Z'),
  isFavorite: false,
  visibility: 'timeline',
  deletedAt: null,
  livePhotoVideoId: null,
  duration: null,
  backendId: null,
  key: null,
  size: 10,
  checksum: null,
  encryption: null,
  exif: null,
  albums: ['Summer'],
  tags: [],
  people: [],
  ...overrides,
});

describe(StorageExportService.name, () => {
  let sut: StorageExportService;
  let mocks: ServiceMocks;
  let state: StorageExportState | null;

  const configure = (exportLocation?: string) =>
    mocks.config.getEnv.mockReturnValue({
      ...mockEnvData({}),
      storage: { ...mockEnvData({}).storage, exportLocation },
    });

  beforeEach(() => {
    ({ sut, mocks } = newTestService(StorageExportService));
    state = null;
    mocks.systemMetadata.get.mockImplementation((key: SystemMetadataKey) =>
      Promise.resolve(key === SystemMetadataKey.StorageExportState ? state : null),
    );
    mocks.systemMetadata.set.mockImplementation((_key: SystemMetadataKey, value: unknown) => {
      state = value as StorageExportState;
      return Promise.resolve();
    });
    mocks.job.queue.mockResolvedValue();
  });

  describe(toTemplateTarget.name, () => {
    it('should name files by the storage template, in the folder of their owner', () => {
      const naming = toTemplateTarget('/export', compileStorageTemplate('{{y}}/{{album}}/{{filename}}'));

      expect(naming(asset())).toEqual({ folder: '/export/ann@example.com/2021/Summer', fileName: 'IMG_0001.heic' });
    });

    it('should not leave the folder of the owner', () => {
      const naming = toTemplateTarget('/export', compileStorageTemplate('../../{{filename}}'));

      expect(naming(asset())).toEqual({
        folder: join('/export', 'ann@example.com', '2021', '2021-07-04'),
        fileName: 'IMG_0001.HEIC',
      });
    });
  });

  describe('startExport', () => {
    it('should need an export location', async () => {
      configure(undefined);

      await expect(sut.startExport({})).rejects.toThrow('IMMICH_EXPORT_LOCATION');
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('should count what it exports, and start', async () => {
      configure('/export');
      mocks.assetJob.countForExport.mockResolvedValue(3);

      await sut.startExport({ userIds: ['user-1'] });

      expect(mocks.assetJob.countForExport).toHaveBeenCalledWith(expect.objectContaining({ userIds: ['user-1'] }));
      expect(state).toMatchObject({ status: 'running', userIds: ['user-1'], total: 3, exported: 0, cursor: null });
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.StorageExport });
    });

    it('should not start a second export while one runs', async () => {
      configure('/export');
      mocks.assetJob.countForExport.mockResolvedValue(0);
      await sut.startExport({});

      await expect(sut.startExport({})).rejects.toThrow('An export is running');
    });
  });

  describe('handleExport', () => {
    it('should go on from where the last chunk stopped, and finish', async () => {
      configure('/export');
      mocks.assetJob.countForExport.mockResolvedValue(2);
      await sut.startExport({});
      state = { ...state!, cursor: { localDateTime: '2021-01-01T00:00:00.000Z', id: 'previous' }, exported: 5 };
      mocks.assetJob.streamForExport.mockReturnValue((async function* () {})());
      mocks.user.getAdmin.mockResolvedValue({ id: 'admin-id' } as never);
      mocks.notification.create.mockResolvedValue({ id: 'notification-id', createdAt: new Date() } as never);

      await expect(sut.handleExport()).resolves.toBe(JobStatus.Success);

      expect(mocks.assetJob.streamForExport).toHaveBeenCalledWith(
        expect.objectContaining({
          output: '/export',
          after: { localDateTime: new Date('2021-01-01T00:00:00.000Z'), id: 'previous' },
        }),
      );
      expect(state).toMatchObject({ status: 'done', exported: 5, finishedAt: expect.any(String) });
      expect(mocks.notification.create).toHaveBeenCalledWith(
        expect.objectContaining({ level: NotificationLevel.Success, title: 'The export of the originals is done' }),
      );
    });

    it('should do nothing when no export runs, or it was cancelled', async () => {
      await expect(sut.handleExport()).resolves.toBe(JobStatus.Skipped);

      configure('/export');
      mocks.assetJob.countForExport.mockResolvedValue(0);
      await sut.startExport({});
      await sut.cancelExport();

      expect(state).toMatchObject({ status: 'cancelled' });
      await expect(sut.handleExport()).resolves.toBe(JobStatus.Skipped);
    });
  });
});
