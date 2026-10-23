import { Kysely } from 'kysely';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { StorageSetupProblemKind } from 'src/enum.js';
import { MasterKeys, generateMasterKey, getMasterKeyId } from 'src/repositories/key-provider.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StorageBackendRepository } from 'src/repositories/storage-backend.repository.js';
import { DB } from 'src/schema/index.js';
import { checkStorageSetup } from 'src/utils/storage-setup.js';
import { DATABASE_BACKUP_KIND } from 'src/utils/stored-database-backups.js';

describe(checkStorageSetup.name, () => {
  let folder: string;
  let repository: StorageBackendRepository;
  let key: string;

  const keyFile = () => join(folder, 'master.key');
  const writeConfig = async (backends: object[], extra: object = {}) => {
    const path = join(folder, 'storage.json');
    await fs.writeFile(path, JSON.stringify({ backends, encryption: { masterKeyFile: keyFile() }, ...extra }));
    return path;
  };
  const backend = (id: string, role: string, encrypted = true) => ({
    id,
    driver: 'local',
    role,
    root: join(folder, id),
    encrypted,
  });
  const standard = () => [backend('originals', 'originals'), backend('backups', 'backup')];
  const check = async (backendsFile: string | undefined) =>
    checkStorageSetup({
      backendsFile,
      repository: new StorageBackendRepository(
        undefined as unknown as Kysely<DB>,
        { setContext: () => {}, warn: () => {}, debug: () => {}, log: () => {} } as unknown as LoggingRepository,
      ),
    });

  beforeEach(async () => {
    folder = await fs.mkdtemp(join(tmpdir(), 'immich-storage-setup-'));
    key = generateMasterKey();
    await fs.writeFile(keyFile(), `${key}\n`);
    for (const id of ['originals', 'backups', 'derived']) {
      await fs.mkdir(join(folder, id));
    }
    repository = new StorageBackendRepository(
      undefined as unknown as Kysely<DB>,
      { setContext: () => {}, warn: () => {}, debug: () => {} } as unknown as LoggingRepository,
    );
  });

  afterEach(async () => {
    await fs.rm(folder, { recursive: true, force: true });
  });

  /** What a server that is restored finds: an original and a database backup, written with `keys` */
  const writeStoredData = async (keys = new MasterKeys([Buffer.from(key, 'base64')])) => {
    const backends = standard().map((config) => ({ ...config, driver: 'local' as const, role: config.role as never }));
    repository.configure(backends as never, keys);
    await repository.getWriteStore('originals').put('original-key', Readable.from([Buffer.from('a photo')]), {
      manifest: { path: '/data/upload/a.jpg' },
    });
    await repository.getWriteStore('backups').put('backup-key', Readable.from([Buffer.from('a database backup')]), {
      manifest: {
        kind: DATABASE_BACKUP_KIND,
        filename: 'immich-db-backup-20261020T020000-v3.3.5-pg14.19.sql.gz',
        keepLast: 14,
        createdAt: '2026-10-20T02:00:00.000Z',
      },
    });
  };

  it('should tell that files are kept in the media location without a configuration file', async () => {
    await expect(check(undefined)).resolves.toMatchObject({ configFile: null, problems: [], backends: [] });
  });

  it('should tell that the configuration file is not there', async () => {
    const path = join(folder, 'missing.yaml');
    const { problems } = await check(path);
    expect(problems).toEqual([expect.objectContaining({ kind: StorageSetupProblemKind.ConfigurationMissing, path })]);
  });

  it('should tell what is wrong in the configuration file', async () => {
    const path = join(folder, 'storage.yaml');
    await fs.writeFile(path, 'backends:\n  - id: originals\n    driver: ftp\n');
    const { problems } = await check(path);
    expect(problems).toEqual([
      expect.objectContaining({
        kind: StorageSetupProblemKind.ConfigurationInvalid,
        path,
        message: expect.stringContaining('backends.0'),
      }),
    ]);
  });

  it('should tell that the master key file is not there, and still check the backends that are not encrypted', async () => {
    await fs.rm(keyFile());
    const report = await check(await writeConfig([...standard(), backend('derived', 'derived', false)]));

    expect(report.problems).toEqual([
      expect.objectContaining({ kind: StorageSetupProblemKind.MasterKeyFileMissing, path: keyFile() }),
    ]);
    expect(report.backends).toEqual([
      expect.objectContaining({ id: 'originals', ok: false }),
      expect.objectContaining({ id: 'backups', ok: false }),
      expect.objectContaining({ id: 'derived', ok: true }),
    ]);
  });

  it('should tell that the master key file holds no key', async () => {
    await fs.writeFile(keyFile(), 'not a key\n');
    const { problems } = await check(await writeConfig(standard()));
    expect(problems).toEqual([expect.objectContaining({ kind: StorageSetupProblemKind.MasterKeysInvalid })]);
  });

  it('should pass a configuration that works, on storage that is empty', async () => {
    const report = await check(await writeConfig(standard()));

    expect(report).toMatchObject({
      problems: [],
      masterKeyFile: keyFile(),
      masterKeyId: getMasterKeyId(Buffer.from(key, 'base64')).toString('hex'),
      hasOriginals: false,
      databaseBackups: [],
    });
    expect(report.backends.every(({ ok }) => ok)).toBe(true);
    // the probes are gone
    await expect(fs.readdir(join(folder, 'originals', '.immich-probe'))).resolves.toEqual([]);
  });

  it('should find the originals and database backups of a server that is restored', async () => {
    await writeStoredData();
    const report = await check(await writeConfig(standard()));

    expect(report.problems).toEqual([]);
    expect(report.hasOriginals).toBe(true);
    expect(report.databaseBackups).toEqual([
      {
        key: 'backup-key',
        filename: 'immich-db-backup-20261020T020000-v3.3.5-pg14.19.sql.gz',
        size: 17,
        createdAt: '2026-10-20T02:00:00.000Z',
      },
    ]);
  });

  it('should tell that the files in storage were encrypted with another master key', async () => {
    const other = Buffer.from(generateMasterKey(), 'base64');
    await writeStoredData(new MasterKeys([other]));
    const report = await check(await writeConfig(standard()));

    expect(report.problems).toEqual([
      expect.objectContaining({
        kind: StorageSetupProblemKind.MasterKeyNotFound,
        keyId: getMasterKeyId(other).toString('hex'),
      }),
    ]);
    expect(report.databaseBackups).toEqual([]);
  });

  it('should tell which backend fails, and check the others', async () => {
    // a file where the folder of the backend should be
    await fs.rm(join(folder, 'backups'), { recursive: true });
    await fs.writeFile(join(folder, 'backups'), '');
    const report = await check(await writeConfig(standard()));

    expect(report.problems).toEqual([
      expect.objectContaining({ kind: StorageSetupProblemKind.BackendFailed, backendId: 'backups' }),
    ]);
    expect(report.backends).toEqual([
      expect.objectContaining({ id: 'originals', ok: true }),
      expect.objectContaining({ id: 'backups', ok: false }),
    ]);
  });
});
