import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobName, JobStatus, StorageBackendDriver, StorageBackendRole, SystemMetadataKey } from 'src/enum.js';
import { EncryptedBlobStore } from 'src/repositories/encrypted-blob-store.js';
import { MasterKeys, getMasterKeyId } from 'src/repositories/key-provider.js';
import { StorageService } from 'src/services/storage.service.js';
import { ImmichStartupError } from 'src/utils/misc.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const file = (id: string, path: string) => ({ id, path });

const person = (personGroupId: string, path: string) => ({ ownerId: 'user-id', personGroupId, path });

describe(StorageService.name, () => {
  let sut: StorageService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(StorageService));
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('onBootstrap', () => {
    it('should enable mount folder checking', async () => {
      mocks.systemMetadata.get.mockResolvedValue(null);
      mocks.asset.getFileSamples.mockResolvedValue([]);
      mocks.config.getEnv.mockReturnValue(
        mockEnvData({
          storage: {
            ignoreMountCheckErrors: false,
            mediaLocation: '/data',
          },
        }),
      );

      await expect(sut.onBootstrap()).resolves.toBeUndefined();

      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(SystemMetadataKey.SystemFlags, {
        mountChecks: {
          backups: true,
          'encoded-video': true,
          library: true,
          profile: true,
          thumbs: true,
          upload: true,
        },
      });
      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('/data/encoded-video'));
      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('/data/library'));
      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('/data/profile'));
      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('/data/thumbs'));
      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('/data/upload'));
      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('/data/backups'));
      expect(mocks.storage.createFile).toHaveBeenCalledWith(
        expect.stringContaining('/data/encoded-video/.immich'),
        expect.any(Buffer),
      );
      expect(mocks.storage.createFile).toHaveBeenCalledWith(
        expect.stringContaining('/data/library/.immich'),
        expect.any(Buffer),
      );
      expect(mocks.storage.createFile).toHaveBeenCalledWith(
        expect.stringContaining('/data/profile/.immich'),
        expect.any(Buffer),
      );
      expect(mocks.storage.createFile).toHaveBeenCalledWith(
        expect.stringContaining('/data/thumbs/.immich'),
        expect.any(Buffer),
      );
      expect(mocks.storage.createFile).toHaveBeenCalledWith(
        expect.stringContaining('/data/upload/.immich'),
        expect.any(Buffer),
      );
      expect(mocks.storage.createFile).toHaveBeenCalledWith(
        expect.stringContaining('/data/backups/.immich'),
        expect.any(Buffer),
      );
    });

    it('should enable mount folder checking for a new folder type', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        mountChecks: {
          backups: false,
          'encoded-video': true,
          library: false,
          profile: true,
          thumbs: true,
          upload: true,
        },
      });
      mocks.asset.getFileSamples.mockResolvedValue([]);
      mocks.config.getEnv.mockReturnValue(
        mockEnvData({
          storage: {
            ignoreMountCheckErrors: false,
            mediaLocation: '/data',
          },
        }),
      );

      await expect(sut.onBootstrap()).resolves.toBeUndefined();

      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(SystemMetadataKey.SystemFlags, {
        mountChecks: {
          backups: true,
          'encoded-video': true,
          library: true,
          profile: true,
          thumbs: true,
          upload: true,
        },
      });
      expect(mocks.storage.mkdirSync).toHaveBeenCalledTimes(2);
      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('/data/library'));
      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('/data/backups'));
      expect(mocks.storage.createFile).toHaveBeenCalledTimes(2);
      expect(mocks.storage.createFile).toHaveBeenCalledWith(
        expect.stringContaining('/data/library/.immich'),
        expect.any(Buffer),
      );
      expect(mocks.storage.createFile).toHaveBeenCalledWith(
        expect.stringContaining('/data/backups/.immich'),
        expect.any(Buffer),
      );
    });

    it('should throw an error if .immich is missing', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ mountChecks: { upload: true } });
      mocks.storage.readFile.mockRejectedValue(new Error("ENOENT: no such file or directory, open '/app/.immich'"));

      await expect(sut.onBootstrap()).rejects.toThrow('Failed to read');

      expect(mocks.storage.createOrOverwriteFile).not.toHaveBeenCalled();
      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
    });

    it('should throw an error if .immich is present but read-only', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ mountChecks: { upload: true } });
      mocks.storage.overwriteFile.mockRejectedValue(
        new Error("ENOENT: no such file or directory, open '/app/.immich'"),
      );

      await expect(sut.onBootstrap()).rejects.toThrow('Failed to write');

      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
    });

    it('should skip mount file creation if file already exists', async () => {
      const error = new Error('Error creating file') as any;
      error.code = 'EEXIST';
      mocks.systemMetadata.get.mockResolvedValue({ mountChecks: {} });
      mocks.storage.createFile.mockRejectedValue(error);
      mocks.asset.getFileSamples.mockResolvedValue([]);

      await expect(sut.onBootstrap()).resolves.toBeUndefined();

      expect(mocks.logger.warn).toHaveBeenCalledWith('Found existing mount file, skipping creation');
    });

    it('should throw an error if mount file could not be created', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ mountChecks: {} });
      mocks.storage.createFile.mockRejectedValue(new Error('Error creating file'));

      await expect(sut.onBootstrap()).rejects.toBeInstanceOf(ImmichStartupError);
      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
    });

    it('should startup if checks are disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ mountChecks: { upload: true } });
      mocks.config.getEnv.mockReturnValue(
        mockEnvData({
          storage: { ignoreMountCheckErrors: true },
        }),
      );
      mocks.asset.getFileSamples.mockResolvedValue([]);
      mocks.storage.overwriteFile.mockRejectedValue(
        new Error("ENOENT: no such file or directory, open '/app/.immich'"),
      );

      await expect(sut.onBootstrap()).resolves.toBeUndefined();

      expect(mocks.systemMetadata.set).not.toHaveBeenCalledWith(SystemMetadataKey.SystemFlags, expect.anything());
    });
  });

  describe('handleDeleteFiles', () => {
    it('should handle null values', async () => {
      await sut.handleDeleteFiles({ files: [undefined, null] });

      expect(mocks.storage.unlink).not.toHaveBeenCalled();
    });

    it('should handle an error removing a file', async () => {
      mocks.storage.unlink.mockRejectedValue(new Error('something-went-wrong'));

      await sut.handleDeleteFiles({ files: ['path/to/something'] });

      expect(mocks.storage.unlink).toHaveBeenCalledWith('path/to/something');
    });

    it('should remove the file', async () => {
      await sut.handleDeleteFiles({ files: ['path/to/something'] });

      expect(mocks.storage.unlink).toHaveBeenCalledWith('path/to/something');
    });
  });

  describe('onBootstrapStorageBackends', () => {
    let root: string;
    const backendsFile = '/config/storage.yaml';
    const localBackend = (id: string, role: StorageBackendRole) => ({
      id,
      driver: StorageBackendDriver.Local as const,
      role,
      root: join(root, id),
      encrypted: false,
    });
    const configure = (backends: ReturnType<typeof localBackend>[]) => {
      mocks.config.getEnv.mockReturnValue(mockEnvData({ storage: { ignoreMountCheckErrors: false, backendsFile } }));
      mocks.storageBackend.readConfig.mockResolvedValue({
        backends,
        deletion: { delayDays: 360 },
        databaseBackups: { keepLast: 14 },
      });
    };

    beforeEach(async () => {
      root = await fs.mkdtemp(join(tmpdir(), 'immich-storage-backends-'));
      mocks.crypto.randomUUID.mockReturnValue('probe-id');
    });

    afterEach(async () => {
      await fs.rm(root, { recursive: true, force: true });
    });

    it('should only keep the built-in backends without a configuration file', async () => {
      await sut.onBootstrapStorageBackends();

      expect(mocks.storageBackend.readConfig).not.toHaveBeenCalled();
      expect(mocks.storageBackend.register).toHaveBeenCalledWith([]);
      expect(mocks.storageBackend.configure).toHaveBeenCalledWith([], undefined, undefined, undefined);
    });

    it('should register, configure and probe the configured backends', async () => {
      const originals = localBackend('originals', StorageBackendRole.Originals);
      configure([originals]);

      await sut.onBootstrapStorageBackends();

      expect(mocks.storageBackend.readConfig).toHaveBeenCalledWith(backendsFile);
      expect(mocks.storageBackend.register).toHaveBeenCalledWith([{ id: 'originals', driver: 'local' }]);
      expect(mocks.storageBackend.configure).toHaveBeenCalledWith(
        [originals],
        undefined,
        { delayDays: 360 },
        { keepLast: 14 },
      );
      // the probe was written, read back and removed
      await expect(fs.readdir(join(root, 'originals', '.immich-probe'))).resolves.toEqual([]);
    });

    it('should load the master keys and probe an encrypted backend through its encryption', async () => {
      const originals = { ...localBackend('originals', StorageBackendRole.Originals), encrypted: true };
      const keys = new MasterKeys([randomBytes(32)]);
      configure([originals]);
      mocks.storageBackend.readConfig.mockResolvedValue({
        backends: [originals],
        encryption: { masterKeyFile: '/run/secrets/master.key' },
        deletion: { delayDays: 360 },
        databaseBackups: { keepLast: 14 },
      });
      mocks.storageBackend.readMasterKeys.mockReturnValue(keys);
      const put = vi.spyOn(EncryptedBlobStore.prototype, 'put');

      await sut.onBootstrapStorageBackends();

      expect(mocks.storageBackend.readMasterKeys).toHaveBeenCalledWith({ masterKeyFile: '/run/secrets/master.key' });
      expect(mocks.storageBackend.configure).toHaveBeenCalledWith(
        [originals],
        keys,
        { delayDays: 360 },
        { keepLast: 14 },
      );
      expect(mocks.storageBackend.registerMasterKey).toHaveBeenCalledWith(keys.currentKeyId);
      expect(put).toHaveBeenCalledOnce();
      await expect(fs.readdir(join(root, 'originals', '.immich-probe'))).resolves.toEqual([]);
    });

    it('should not record the master key when no backend is encrypted', async () => {
      configure([localBackend('originals', StorageBackendRole.Originals)]);
      mocks.storageBackend.readConfig.mockResolvedValue({
        backends: [localBackend('originals', StorageBackendRole.Originals)],
        encryption: { masterKeyFile: '/run/secrets/master.key' },
        deletion: { delayDays: 360 },
        databaseBackups: { keepLast: 14 },
      });
      mocks.storageBackend.readMasterKeys.mockReturnValue(new MasterKeys([randomBytes(32)]));

      await sut.onBootstrapStorageBackends();

      expect(mocks.storageBackend.registerMasterKey).not.toHaveBeenCalled();
    });

    it('should refuse to start when a master key that encrypted files is not in the key file', async () => {
      const current = randomBytes(32);
      const lost = randomBytes(32);
      configure([]);
      mocks.storageBackend.readConfig.mockResolvedValue({
        backends: [],
        encryption: { masterKeyFile: '/run/secrets/master.key' },
        deletion: { delayDays: 360 },
        databaseBackups: { keepLast: 14 },
      });
      mocks.storageBackend.readMasterKeys.mockReturnValue(new MasterKeys([current]));
      mocks.storageBackend.getMasterKeyIds.mockResolvedValue([getMasterKeyId(current), getMasterKeyId(lost)]);

      await expect(sut.onBootstrapStorageBackends()).rejects.toThrow(
        `Files were encrypted with master keys that are not in /run/secrets/master.key: ${getMasterKeyId(lost).toString('hex')}`,
      );
      expect(mocks.storageBackend.configure).not.toHaveBeenCalled();
    });

    it('should refuse to start when files are encrypted but no master keys are configured', async () => {
      configure([]);
      mocks.storageBackend.getMasterKeyIds.mockResolvedValue([Buffer.from('0102030405060708', 'hex')]);

      await expect(sut.onBootstrapStorageBackends()).rejects.toThrow(
        'Files were encrypted with master keys 0102030405060708, but no master keys are configured',
      );
    });

    it('should refuse to start when the master key file cannot be read', async () => {
      configure([]);
      mocks.storageBackend.readConfig.mockResolvedValue({
        backends: [],
        encryption: { masterKeyFile: '/run/secrets/master.key' },
        deletion: { delayDays: 360 },
        databaseBackups: { keepLast: 14 },
      });
      mocks.storageBackend.readMasterKeys.mockImplementation(() => {
        throw new Error('ENOENT: no such file');
      });

      await expect(sut.onBootstrapStorageBackends()).rejects.toThrow(ImmichStartupError);
      await expect(sut.onBootstrapStorageBackends()).rejects.toThrow('ENOENT');
      expect(mocks.storageBackend.configure).not.toHaveBeenCalled();
    });

    it('should not register a backend again', async () => {
      configure([localBackend('originals', StorageBackendRole.Originals)]);
      mocks.storageBackend.getRegistered.mockResolvedValue([{ id: 'originals', driver: StorageBackendDriver.Local }]);

      await sut.onBootstrapStorageBackends();

      expect(mocks.storageBackend.register).toHaveBeenCalledWith([]);
    });

    it('should refuse to start with an invalid configuration', async () => {
      mocks.config.getEnv.mockReturnValue(mockEnvData({ storage: { ignoreMountCheckErrors: false, backendsFile } }));
      mocks.storageBackend.readConfig.mockRejectedValue(new Error('backends.0.root: Must be an absolute path'));

      await expect(sut.onBootstrapStorageBackends()).rejects.toThrow(ImmichStartupError);
      await expect(sut.onBootstrapStorageBackends()).rejects.toThrow('Must be an absolute path');
      expect(mocks.storageBackend.register).not.toHaveBeenCalled();
    });

    it('should refuse to start when the driver of a registered backend changed', async () => {
      configure([localBackend('originals', StorageBackendRole.Originals)]);
      mocks.storageBackend.getRegistered.mockResolvedValue([{ id: 'originals', driver: 's3' as StorageBackendDriver }]);

      await expect(sut.onBootstrapStorageBackends()).rejects.toThrow(
        'Storage backend originals is configured with the local driver, but its files were written with the s3 driver',
      );
      expect(mocks.storageBackend.register).not.toHaveBeenCalled();
    });

    it('should refuse to start when a backend that still holds files is no longer configured', async () => {
      configure([]);
      mocks.storageBackend.getRegistered.mockResolvedValue([
        { id: 'media', driver: StorageBackendDriver.Local },
        { id: 'old', driver: StorageBackendDriver.Local },
      ]);
      mocks.storageBackend.isInUse.mockResolvedValue(true);

      await expect(sut.onBootstrapStorageBackends()).rejects.toThrow(
        'Storage backend old still holds files but is not configured in /config/storage.yaml',
      );
      expect(mocks.storageBackend.isInUse).toHaveBeenCalledWith('old');
      expect(mocks.storageBackend.isInUse).not.toHaveBeenCalledWith('media');
    });

    it('should allow removing a backend that holds no files', async () => {
      configure([]);
      mocks.storageBackend.getRegistered.mockResolvedValue([{ id: 'old', driver: StorageBackendDriver.Local }]);
      mocks.storageBackend.isInUse.mockResolvedValue(false);

      await expect(sut.onBootstrapStorageBackends()).resolves.toBeUndefined();
    });

    it('should refuse to start when a backend cannot be written to', async () => {
      const derived = localBackend('derived', StorageBackendRole.Derived);
      // a file where the directory should be
      await fs.writeFile(derived.root, '');
      configure([derived]);

      await expect(sut.onBootstrapStorageBackends()).rejects.toThrow(
        'Storage backend derived failed the startup check',
      );
    });
  });

  describe('getConfiguration', () => {
    it('should describe the backends without their credentials', async () => {
      mocks.storageBackend.configure(
        [
          {
            id: 'originals',
            driver: StorageBackendDriver.S3,
            role: StorageBackendRole.Originals,
            endpoint: 'https://storage.example.com',
            region: 'region-1',
            bucket: 'photos',
            prefix: 'immich/',
            addressing: 'virtual-host',
            credentials: { type: 'chain', profile: 'reader-profile' },
            deletionCredentials: { type: 'chain', profile: 'deleter-profile' },
            encrypted: false,
          },
          {
            id: 'derived',
            driver: StorageBackendDriver.Local,
            role: StorageBackendRole.Derived,
            root: '/d',
            encrypted: false,
          },
        ],
        undefined,
        { delayDays: 720 },
      );

      const configuration = await sut.getConfiguration();

      expect(configuration).toEqual({
        backends: [
          {
            id: 'originals',
            role: 'originals',
            driver: 's3',
            encrypted: false,
            replicaOf: null,
            location: 'https://storage.example.com photos/immich/',
            hasDeletionCredentials: true,
          },
          {
            id: 'derived',
            role: 'derived',
            driver: 'local',
            encrypted: false,
            replicaOf: null,
            location: '/d',
            hasDeletionCredentials: false,
          },
        ],
        masterKeyId: null,
        masterKeySource: null,
        masterKeySavedAt: null,
        deletionDelayDays: 720,
        databaseBackupsKeepLast: 14,
        syncDeleteRetentionDays: 365,
      });
      expect(JSON.stringify(configuration)).not.toMatch(/profile/);
    });

    it('should tell when the current master key was saved, but not for a key saved before a key change', async () => {
      const keys = new MasterKeys([randomBytes(32)], 'command');
      const keyId = keys.currentKeyId.toString('hex');
      mocks.storageBackend.configure([], keys);
      mocks.systemMetadata.get.mockResolvedValue({ keyId, savedAt: '2026-10-23T00:00:00.000Z', userId: 'admin' });

      await expect(sut.getConfiguration()).resolves.toMatchObject({
        masterKeyId: keyId,
        masterKeySource: 'command',
        masterKeySavedAt: '2026-10-23T00:00:00.000Z',
      });

      mocks.systemMetadata.get.mockResolvedValue({
        keyId: 'an older key',
        savedAt: '2026-01-01T00:00:00.000Z',
        userId: 'admin',
      });
      await expect(sut.getConfiguration()).resolves.toMatchObject({ masterKeySavedAt: null });
    });
  });

  describe('exportMasterKeys', () => {
    const auth = { user: { id: 'admin-id', email: 'admin@example.com' } } as never;

    beforeEach(() => {
      mocks.user.getForChangePassword.mockResolvedValue({ id: 'admin-id', password: 'hash' } as never);
      mocks.user.getList.mockResolvedValue([
        { id: 'admin-id', isAdmin: true },
        { id: 'other-admin', isAdmin: true },
        { id: 'user', isAdmin: false },
      ] as never);
      mocks.notification.create.mockImplementation((notification) =>
        Promise.resolve({ ...notification, id: 'notification', createdAt: new Date() } as never),
      );
    });

    it('should give the key file after the password was confirmed, record it and tell every administrator', async () => {
      const keys = new MasterKeys([randomBytes(32), randomBytes(32)], 'file');
      const keyId = keys.currentKeyId.toString('hex');
      mocks.storageBackend.configure([], keys);
      mocks.crypto.compareBcrypt.mockReturnValue(true);

      const exported = await sut.exportMasterKeys(auth, { password: 'secret' });

      expect(exported).toEqual({ keyId, fileName: `immich-master-keys-${keyId}.txt`, keyFile: keys.toKeyFile() });
      expect(mocks.crypto.compareBcrypt).toHaveBeenCalledWith('secret', 'hash');
      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(SystemMetadataKey.StorageMasterKeySaved, {
        keyId,
        savedAt: expect.any(String),
        userId: 'admin-id',
      });
      expect(mocks.notification.create).toHaveBeenCalledTimes(2);
      expect(mocks.notification.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'other-admin', title: 'The master keys were downloaded' }),
      );
    });

    it('should not give the keys for a wrong password, nor without a password', async () => {
      mocks.storageBackend.configure([], new MasterKeys([randomBytes(32)]));
      mocks.crypto.compareBcrypt.mockReturnValue(false);
      await expect(sut.exportMasterKeys(auth, { password: 'wrong' })).rejects.toThrow('Wrong password');

      // e.g. an administrator who only signs in with OAuth
      mocks.user.getForChangePassword.mockResolvedValue({ id: 'admin-id', password: '' } as never);
      mocks.crypto.compareBcrypt.mockReturnValue(true);
      await expect(sut.exportMasterKeys(auth, { password: 'anything' })).rejects.toThrow('Wrong password');

      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
      expect(mocks.notification.create).not.toHaveBeenCalled();
    });

    it('should tell that there are no master keys', async () => {
      mocks.storageBackend.configure([]);
      mocks.crypto.compareBcrypt.mockReturnValue(true);

      await expect(sut.exportMasterKeys(auth, { password: 'secret' })).rejects.toThrow('No master keys are configured');
    });
  });

  describe('handleLocalCopyCleanup', () => {
    it('should remove local copies that are too old or too many', async () => {
      mocks.storageBackend.sweepLocalCopies.mockResolvedValue();

      await expect(sut.handleLocalCopyCleanup()).resolves.toBe(JobStatus.Success);

      expect(mocks.storageBackend.sweepLocalCopies).toHaveBeenCalledOnce();
    });
  });

  describe('handleDeleteFiles with locations', () => {
    let root: string;

    beforeEach(async () => {
      root = await fs.mkdtemp(join(tmpdir(), 'immich-delete-'));
      mocks.storageBackend.configure([
        { id: 'derived', driver: StorageBackendDriver.Local, role: StorageBackendRole.Derived, root, encrypted: false },
      ]);
    });

    afterEach(async () => {
      await fs.rm(root, { recursive: true, force: true });
    });

    it('should delete files from their storage backend', async () => {
      await fs.writeFile(join(root, 'a'), 'a');
      await fs.writeFile(join(root, 'b'), 'b');

      await expect(
        sut.handleDeleteFiles({
          files: [],
          locations: [
            { backendId: 'derived', key: 'a' },
            { backendId: 'derived', key: 'b' },
          ],
          immediate: true,
        }),
      ).resolves.toBe(JobStatus.Success);

      await expect(fs.readdir(root)).resolves.toEqual([]);
      expect(mocks.storage.unlink).not.toHaveBeenCalled();
    });

    it('should register files for deletion once their delay has passed, instead of deleting them', async () => {
      await fs.writeFile(join(root, 'a'), 'a');

      await sut.handleDeleteFiles({ files: [], locations: [{ backendId: 'derived', key: 'a' }] });

      await expect(fs.readdir(root)).resolves.toEqual(['a']);
      expect(mocks.storageDeletion.register).toHaveBeenCalledWith([
        { backendId: 'derived', key: 'a', isOriginal: false, notBefore: expect.any(Date) },
      ]);
      const [[[{ notBefore }]]] = mocks.storageDeletion.register.mock.calls;
      // derived files wait for a fixed 30 days
      expect(new Date(notBefore).getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1000);
      expect(new Date(notBefore).getTime()).toBeLessThan(Date.now() + 31 * 24 * 60 * 60 * 1000);
    });

    it('should not delete a file right away that is recorded again', async () => {
      await fs.writeFile(join(root, 'a'), 'a');
      mocks.storageDeletion.getRecorded.mockResolvedValue([{ backendId: 'derived', key: 'a' }]);

      await sut.handleDeleteFiles({ files: [], locations: [{ backendId: 'derived', key: 'a' }], immediate: true });

      await expect(fs.readdir(root)).resolves.toEqual(['a']);
    });

    it('should also remove the local copies of deleted files', async () => {
      await sut.handleDeleteFiles({ files: [], locations: [{ backendId: 'derived', key: 'a' }] });

      expect(mocks.storageBackend.dropLocalCopy).toHaveBeenCalledWith({ backendId: 'derived', key: 'a' });
    });

    it('should delete by path and by location in one job', async () => {
      await fs.writeFile(join(root, 'a'), 'a');

      await sut.handleDeleteFiles({
        files: ['/data/old.jpg'],
        locations: [{ backendId: 'derived', key: 'a' }],
        immediate: true,
      });

      expect(mocks.storage.unlink).toHaveBeenCalledWith('/data/old.jpg');
      await expect(fs.readdir(root)).resolves.toEqual([]);
    });

    it('should log files that could not be deleted and continue', async () => {
      await fs.mkdir(join(root, 'directory'));
      await fs.writeFile(join(root, 'a'), 'a');

      await expect(
        sut.handleDeleteFiles({
          files: [],
          locations: [
            { backendId: 'unknown', key: 'x' },
            { backendId: 'derived', key: 'directory' },
            { backendId: 'derived', key: 'a' },
          ],
          immediate: true,
        }),
      ).resolves.toBe(JobStatus.Success);

      expect(mocks.logger.warn).toHaveBeenCalledWith(
        'Unable to remove files from storage backend unknown',
        expect.any(Error),
      );
      expect(mocks.logger.warn).toHaveBeenCalledWith('Unable to remove directory from storage backend derived');
      await expect(fs.readdir(root)).resolves.toEqual(['directory']);
    });
  });

  describe('onBootstrapFileLocations', () => {
    it('should queue the backfill when some files have no storage location', async () => {
      mocks.asset.hasFilesWithoutLocation.mockResolvedValue(true);

      await sut.onBootstrapFileLocations();

      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.FileLocationBackfill });
    });

    it('should queue the backfill when some assets have no original file location', async () => {
      mocks.asset.hasAssetsWithoutOriginalFile.mockResolvedValue(true);

      await sut.onBootstrapFileLocations();

      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.FileLocationBackfill });
    });

    it('should queue the backfill when some people have no thumbnail file location', async () => {
      mocks.person.hasPeopleWithoutThumbnailFile.mockResolvedValue(true);

      await sut.onBootstrapFileLocations();

      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.FileLocationBackfill });
    });

    it('should queue the backfill when some users have no profile image file location', async () => {
      mocks.user.hasUsersWithoutProfileImageFile.mockResolvedValue(true);

      await sut.onBootstrapFileLocations();

      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.FileLocationBackfill });
    });

    it('should not queue the backfill when every file has a storage location', async () => {
      mocks.asset.hasFilesWithoutLocation.mockResolvedValue(false);
      mocks.asset.hasAssetsWithoutOriginalFile.mockResolvedValue(false);
      mocks.person.hasPeopleWithoutThumbnailFile.mockResolvedValue(false);
      mocks.user.hasUsersWithoutProfileImageFile.mockResolvedValue(false);

      await sut.onBootstrapFileLocations();

      expect(mocks.job.queue).not.toHaveBeenCalled();
    });
  });

  describe('handleFileLocationBackfill', () => {
    beforeEach(() => {
      mocks.person.getPeopleWithoutThumbnailFile.mockResolvedValue([]);
      mocks.user.getUsersWithoutProfileImageFile.mockResolvedValue([]);
    });

    // the storage repository mock sets the media location to /data
    it('should use the media backend for files under the media location and the host backend otherwise', async () => {
      mocks.asset.getFilesWithoutLocation.mockResolvedValueOnce([
        file('file-1', '/data/thumbs/user-id/ab/cd/asset_thumbnail.webp'),
        file('file-2', '/mnt/external/IMG_1.jpg.xmp'),
      ]);
      mocks.asset.setFileLocations.mockResolvedValue(2);

      await expect(sut.handleFileLocationBackfill()).resolves.toBe(JobStatus.Success);

      expect(mocks.asset.getFilesWithoutLocation).toHaveBeenCalledTimes(1);
      expect(mocks.asset.getFilesWithoutLocation).toHaveBeenCalledWith({ afterId: undefined, limit: 5000 });
      expect(mocks.asset.setFileLocations).toHaveBeenCalledWith([
        { id: 'file-1', backendId: 'media', key: 'thumbs/user-id/ab/cd/asset_thumbnail.webp' },
        { id: 'file-2', backendId: 'host', key: 'mnt/external/IMG_1.jpg.xmp' },
      ]);
      expect(mocks.logger.warn).not.toHaveBeenCalled();
    });

    it('should do nothing when there are no files without a location', async () => {
      await expect(sut.handleFileLocationBackfill()).resolves.toBe(JobStatus.Success);

      expect(mocks.asset.setFileLocations).not.toHaveBeenCalled();
    });

    it('should continue after the last file of a full batch until no files are left', async () => {
      const firstBatch = Array.from({ length: 5000 }, (_, index) => file(`file-${index}`, `/data/upload/${index}.jpg`));
      mocks.asset.getFilesWithoutLocation
        .mockResolvedValueOnce(firstBatch)
        .mockResolvedValueOnce([file('file-last', '/data/upload/last.jpg')]);
      mocks.asset.setFileLocations.mockResolvedValueOnce(5000).mockResolvedValueOnce(1);

      await expect(sut.handleFileLocationBackfill()).resolves.toBe(JobStatus.Success);

      expect(mocks.asset.getFilesWithoutLocation).toHaveBeenCalledTimes(2);
      expect(mocks.asset.getFilesWithoutLocation).toHaveBeenNthCalledWith(2, { afterId: 'file-4999', limit: 5000 });
      expect(mocks.asset.setFileLocations).toHaveBeenNthCalledWith(2, [
        { id: 'file-last', backendId: 'media', key: 'upload/last.jpg' },
      ]);
    });

    it('should page past files it skipped so they are not read again', async () => {
      mocks.asset.getFilesWithoutLocation
        .mockResolvedValueOnce(Array.from({ length: 5000 }, (_, index) => file(`file-${index}`, 'relative/path.jpg')))
        .mockResolvedValueOnce([]);

      await expect(sut.handleFileLocationBackfill()).resolves.toBe(JobStatus.Success);

      expect(mocks.asset.getFilesWithoutLocation).toHaveBeenNthCalledWith(2, { afterId: 'file-4999', limit: 5000 });
      expect(mocks.asset.setFileLocations).toHaveBeenCalledWith([]);
    });

    it('should skip a file whose path cannot be mapped to a storage location', async () => {
      mocks.asset.getFilesWithoutLocation.mockResolvedValueOnce([
        file('file-1', 'relative/path.jpg'),
        file('file-2', '/data/upload/file.jpg'),
      ]);
      mocks.asset.setFileLocations.mockResolvedValue(1);

      await expect(sut.handleFileLocationBackfill()).resolves.toBe(JobStatus.Success);

      expect(mocks.asset.setFileLocations).toHaveBeenCalledWith([
        { id: 'file-2', backendId: 'media', key: 'upload/file.jpg' },
      ]);
      expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('file-1'));
      expect(mocks.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Skipped 1 asset file(s) with an unusable path'),
      );
    });

    it('should only give a location shared by several files in a batch to the first of them', async () => {
      mocks.asset.getFilesWithoutLocation.mockResolvedValueOnce([
        file('file-1', '/data/upload/same.jpg'),
        file('file-2', '/data/upload/same.jpg'),
      ]);
      mocks.asset.setFileLocations.mockResolvedValue(1);

      await expect(sut.handleFileLocationBackfill()).resolves.toBe(JobStatus.Success);

      expect(mocks.asset.setFileLocations).toHaveBeenCalledWith([
        { id: 'file-1', backendId: 'media', key: 'upload/same.jpg' },
      ]);
      expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('1 asset file(s) whose path is shared'));
    });

    it('should give a host location shared by several files to all of them', async () => {
      mocks.asset.getFilesWithoutLocation.mockResolvedValueOnce([
        file('file-1', '/mnt/external/IMG_1.jpg.xmp'),
        file('file-2', '/mnt/external/IMG_1.jpg.xmp'),
      ]);
      mocks.asset.setFileLocations.mockResolvedValue(2);

      await expect(sut.handleFileLocationBackfill()).resolves.toBe(JobStatus.Success);

      expect(mocks.asset.setFileLocations).toHaveBeenCalledWith([
        { id: 'file-1', backendId: 'host', key: 'mnt/external/IMG_1.jpg.xmp' },
        { id: 'file-2', backendId: 'host', key: 'mnt/external/IMG_1.jpg.xmp' },
      ]);
      expect(mocks.logger.warn).not.toHaveBeenCalled();
    });

    it('should count files whose location already belongs to another file as shared', async () => {
      mocks.asset.getFilesWithoutLocation.mockResolvedValueOnce([
        file('file-1', '/data/upload/a.jpg'),
        file('file-2', '/data/upload/b.jpg'),
      ]);
      mocks.asset.setFileLocations.mockResolvedValue(1);

      await expect(sut.handleFileLocationBackfill()).resolves.toBe(JobStatus.Success);

      expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('1 asset file(s) whose path is shared'));
    });

    it('should record the original file of assets the same way', async () => {
      mocks.asset.getAssetsWithoutOriginalFile.mockResolvedValueOnce([
        file('asset-1', '/data/library/admin/IMG_1.jpg'),
        file('asset-2', '/mnt/external/IMG_2.jpg'),
        file('asset-3', 'relative/IMG_3.jpg'),
      ]);
      mocks.asset.setOriginalFiles.mockResolvedValue(2);

      await expect(sut.handleFileLocationBackfill()).resolves.toBe(JobStatus.Success);

      expect(mocks.asset.getAssetsWithoutOriginalFile).toHaveBeenCalledWith({ afterId: undefined, limit: 5000 });
      expect(mocks.asset.setOriginalFiles).toHaveBeenCalledWith([
        { id: 'asset-1', backendId: 'media', key: 'library/admin/IMG_1.jpg' },
        { id: 'asset-2', backendId: 'host', key: 'mnt/external/IMG_2.jpg' },
      ]);
      expect(mocks.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Unable to determine the storage location of original file asset-3'),
      );
      expect(mocks.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Skipped 1 original file(s) with an unusable path'),
      );
    });

    it('should page through original files after the last asset of a full batch', async () => {
      const page = Array.from({ length: 5000 }, (_, index) => file(`asset-${index}`, `/data/upload/${index}.jpg`));
      mocks.asset.getAssetsWithoutOriginalFile.mockResolvedValueOnce(page).mockResolvedValueOnce([]);
      mocks.asset.setOriginalFiles.mockResolvedValue(5000);

      await expect(sut.handleFileLocationBackfill()).resolves.toBe(JobStatus.Success);

      expect(mocks.asset.getAssetsWithoutOriginalFile).toHaveBeenCalledTimes(2);
      expect(mocks.asset.getAssetsWithoutOriginalFile).toHaveBeenLastCalledWith({ afterId: 'asset-4999', limit: 5000 });
    });

    it('should record person thumbnails, paging by owner and person group', async () => {
      const page = Array.from({ length: 5000 }, (_, index) =>
        person(`group-${index}`, `/data/thumbs/user-id/${index}.jpeg`),
      );
      mocks.person.getPeopleWithoutThumbnailFile.mockResolvedValueOnce(page).mockResolvedValueOnce([]);
      mocks.person.setThumbnailFiles.mockResolvedValue(5000);

      await expect(sut.handleFileLocationBackfill()).resolves.toBe(JobStatus.Success);

      expect(mocks.person.getPeopleWithoutThumbnailFile).toHaveBeenNthCalledWith(1, { after: undefined, limit: 5000 });
      expect(mocks.person.getPeopleWithoutThumbnailFile).toHaveBeenNthCalledWith(2, { after: page[4999], limit: 5000 });
      expect(mocks.person.setThumbnailFiles).toHaveBeenCalledWith(
        expect.arrayContaining([
          { ownerId: 'user-id', personGroupId: 'group-0', backendId: 'media', key: 'thumbs/user-id/0.jpeg' },
        ]),
      );
    });

    it('should name the person when a thumbnail path cannot be used', async () => {
      mocks.person.getPeopleWithoutThumbnailFile.mockResolvedValueOnce([
        { ownerId: 'user-id', personGroupId: 'group-id', path: 'relative.jpeg' },
      ]);

      await expect(sut.handleFileLocationBackfill()).resolves.toBe(JobStatus.Success);

      expect(mocks.person.setThumbnailFiles).toHaveBeenCalledWith([]);
      expect(mocks.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('person thumbnail group-id of user user-id (relative.jpeg)'),
      );
    });

    it('should record user profile images', async () => {
      mocks.user.getUsersWithoutProfileImageFile.mockResolvedValueOnce([
        file('user-id', '/data/profile/user-id/image.webp'),
      ]);
      mocks.user.setProfileImageFiles.mockResolvedValue(1);

      await expect(sut.handleFileLocationBackfill()).resolves.toBe(JobStatus.Success);

      expect(mocks.user.getUsersWithoutProfileImageFile).toHaveBeenCalledWith({ afterId: undefined, limit: 5000 });
      expect(mocks.user.setProfileImageFiles).toHaveBeenCalledWith([
        { id: 'user-id', backendId: 'media', key: 'profile/user-id/image.webp' },
      ]);
    });
  });
});
