import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  Api,
  ImmichServer,
  S3Service,
  TestEnvironment,
  eventually,
  runEncryptionTool,
  sha1,
  testAssetDir,
} from 'src/storage-backends.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const photoPath = join(testAssetDir, 'formats/jpg/el_torcal_rocks.jpg');
const motionPhotoPath = join(testAssetDir, 'formats/motionphoto/pixel-6-pro.jpg');
const otherPhotoPath = join(testAssetDir, 'formats/webp/denali.webp');
const pngPath = join(testAssetDir, 'formats/png/density_plot.png');
const uuid = expect.stringMatching(/^[0-9a-f-]{36}$/);

type OriginalRow = {
  backendId: string;
  key: string;
  size: string;
  checksum: string;
  encryption: string | null;
  originalPath: string;
};
type FileRow = {
  type: string;
  backendId: string;
  key: string;
  size: string;
  checksum: string | null;
  encryption: string | null;
  path: string;
};

const getOriginal = async (environment: TestEnvironment, assetId: string) => {
  const [row] = await environment.query<OriginalRow>(
    `select o."backendId", o.key, o.size, encode(o.checksum, 'hex') as checksum,
       encode(o.encryption, 'hex') as encryption, a."originalPath"
     from asset a join asset_original_file o on o."assetId" = a.id where a.id = $1`,
    [assetId],
  );
  return row;
};

/** What the server logged lately, so that a failed test shows why */
const printServerLogs = (test: string, server?: ImmichServer) => {
  const lines = server?.logs.split('\n') ?? [];
  console.log(`Server output for "${test}" (last 80 lines):\n${lines.slice(-80).join('\n')}`);
};

/** The id of the master key that wrapped the key of a file, from its recorded header (bytes 18 to 26) */
const masterKeyIdOf = ({ encryption }: { encryption: string | null }) => encryption?.slice(36, 52);

const getFiles = (environment: TestEnvironment, assetId: string) =>
  environment.query<FileRow>(
    `select type, "backendId", key, size, encode(checksum, 'hex') as checksum, encode(encryption, 'hex') as encryption,
       path
     from asset_file where "assetId" = $1 order by type`,
    [assetId],
  );

describe('storage backends for originals and derived files', () => {
  let environment: TestEnvironment;
  let server: ImmichServer;
  let api: Api;
  let photo: Buffer;
  let assetId: string;

  beforeAll(async () => {
    environment = await TestEnvironment.create();
    await environment.writeBackends([
      { id: 'originals', role: 'originals' },
      { id: 'derived', role: 'derived' },
    ]);
    server = await ImmichServer.start(environment);
    api = await Api.signUpAdmin();

    photo = await readFile(photoPath);
    ({ id: assetId } = await api.upload(photoPath, photo));
  });

  afterEach(({ task }) => {
    if (task.result?.state === 'fail') {
      printServerLogs(task.name, server);
    }
  });

  afterAll(async () => {
    await server?.stop();
    await environment?.destroy();
  });

  it('should register the configured backends on startup', () => {
    expect(server.logs).toContain('Using storage backends: originals (originals), derived (derived)');
  });

  it('should store an upload on the originals backend and remove the uploaded file', async () => {
    const original = await getOriginal(environment, assetId);

    expect(original).toEqual({
      backendId: 'originals',
      key: uuid,
      size: String(photo.length),
      checksum: sha1(photo),
      // local backends are not encrypted unless configured to be
      encryption: null,
      originalPath: expect.stringContaining(join(environment.mediaLocation, 'upload')),
    });
    await expect(readFile(join(environment.backendRoot('originals'), original.key))).resolves.toEqual(photo);
    await eventually(() => expect(stat(original.originalPath)).rejects.toThrow('ENOENT'));
  });

  it('should store thumbnails on the derived backend under their logical path', async () => {
    const files = await eventually(async () => {
      const files = await getFiles(environment, assetId);
      expect(files.map(({ type }) => type)).toEqual(['preview', 'thumbnail']);
      return files;
    });

    for (const file of files) {
      expect(file).toEqual(
        expect.objectContaining({ backendId: 'derived', key: uuid, path: expect.stringContaining(assetId) }),
      );
      const stored = await stat(join(environment.backendRoot('derived'), file.key));
      expect(String(stored.size)).toBe(file.size);
    }
    await expect(environment.listStaging()).resolves.toEqual([]);
  });

  it('should extract metadata from the stored original, keeping the modification time from the upload', async () => {
    const [exif] = await eventually(async () => {
      const rows = await environment.query<{ make: string; size: string; modifyDate: Date }>(
        `select make, "fileSizeInByte" as size, "modifyDate" from asset_exif where "assetId" = $1`,
        [assetId],
      );
      expect(rows[0]?.make).toBeTruthy();
      return rows;
    });

    expect(exif).toEqual({
      make: 'SONY',
      size: String(photo.length),
      modifyDate: new Date('2020-01-02T03:04:05.000Z'),
    });
  });

  it('should serve originals, thumbnails and byte ranges from the backends', async () => {
    await expect(api.download(`/assets/${assetId}/original`)).resolves.toEqual({ status: 200, body: photo });

    const [, thumbnail] = await getFiles(environment, assetId);
    const storedThumbnail = await readFile(join(environment.backendRoot('derived'), thumbnail.key));
    await expect(api.download(`/assets/${assetId}/thumbnail?size=thumbnail`)).resolves.toEqual({
      status: 200,
      body: storedThumbnail,
    });

    await expect(api.download(`/assets/${assetId}/original`, { Range: 'bytes=100-199' })).resolves.toEqual({
      status: 206,
      body: photo.subarray(100, 200),
    });
  });

  it('should store motion photo videos on the originals backend and their encoded videos on the derived backend', async () => {
    const { id } = await api.upload(motionPhotoPath, await readFile(motionPhotoPath));

    const [video] = await eventually(async () => {
      const rows = await environment.query<{ id: string; backendId: string }>(
        `select v.id, o."backendId" from asset a
         join asset v on v.id = a."livePhotoVideoId"
         join asset_original_file o on o."assetId" = v.id
         where a.id = $1`,
        [id],
      );
      expect(rows).toHaveLength(1);
      return rows;
    });
    expect(video.backendId).toBe('originals');

    const encoded = await eventually(
      async () => {
        const files = await getFiles(environment, video.id);
        expect(files).toEqual([expect.objectContaining({ type: 'encoded_video', backendId: 'derived', key: uuid })]);
        return files[0];
      },
      { timeout: 60_000 },
    );
    await expect(stat(join(environment.backendRoot('derived'), encoded.key))).resolves.toBeTruthy();
  });

  it('should keep the files of permanently deleted assets until their deletion delay has passed', async () => {
    const assets = await environment.query<{ id: string }>(
      `select id from asset where "livePhotoVideoId" is not null or id = $1`,
      [assetId],
    );
    const stored = [...(await environment.listBackend('originals')), ...(await environment.listBackend('derived'))];
    await api.deleteAssets(assets.map(({ id }) => id));

    await eventually(async () => {
      await expect(environment.query(`select id from asset`)).resolves.toEqual([]);
      const registered = await environment.query<{ key: string }>(`select key from storage_deletion`);
      expect(registered.map(({ key }) => key)).toEqual(expect.arrayContaining(stored));
      expect(registered).toHaveLength(stored.length);
    });
    await expect(environment.listBackend('originals')).resolves.not.toEqual([]);

    await environment.makeDeletionsDue();
    await server.stop();
    server = await ImmichServer.start(environment);

    await eventually(async () => {
      await expect(environment.listBackend('originals')).resolves.toEqual([]);
      await expect(environment.listBackend('derived')).resolves.toEqual([]);
      await expect(environment.query(`select key from storage_deletion`)).resolves.toEqual([]);
    });
  });

  it('should refuse to start while a backend that holds files is not configured', async () => {
    const { id } = await api.upload(photoPath, photo);
    await eventually(() => expect(getOriginal(environment, id)).resolves.toBeTruthy());
    await server.stop();

    await environment.writeBackends([{ id: 'derived', role: 'derived' }]);
    await expect(ImmichServer.start(environment)).rejects.toThrow(
      `Storage backend originals still holds files but is not configured in ${environment.backendsFile}`,
    );

    await environment.writeBackends([
      { id: 'originals', role: 'originals' },
      { id: 'derived', role: 'derived' },
    ]);
    server = await ImmichServer.start(environment);
    api = await Api.login({ email: 'admin@immich.cloud', password: 'admin' });
    await expect(api.download(`/assets/${id}/original`)).resolves.toEqual({ status: 200, body: photo });
  });
});

describe('storage backends on an S3 service', () => {
  let environment: TestEnvironment;
  let s3: S3Service;
  let server: ImmichServer;
  let api: Api;
  let photo: Buffer;
  let assetId: string;

  beforeAll(async () => {
    environment = await TestEnvironment.create();
    s3 = await S3Service.start(environment);
    await environment.writeBackends([
      { id: 'originals', role: 'originals', s3: { service: s3, prefix: 'originals/' } },
      { id: 'derived', role: 'derived', s3: { service: s3, prefix: 'derived/' } },
      { id: 'backups', role: 'backup', s3: { service: s3, prefix: 'backups/' } },
    ]);
    server = await ImmichServer.start(environment);
    api = await Api.signUpAdmin();

    photo = await readFile(photoPath);
    ({ id: assetId } = await api.upload(photoPath, photo));
  });

  afterEach(({ task }) => {
    if (task.result?.state === 'fail') {
      printServerLogs(task.name, server);
    }
  });

  afterAll(async () => {
    await server?.stop();
    s3?.stop();
    await environment?.destroy();
  });

  it('should store an upload as an encrypted object and remove the uploaded file', async () => {
    const original = await getOriginal(environment, assetId);

    // size and checksum are those of the photo, the object holds it encrypted
    expect(original).toEqual(
      expect.objectContaining({
        backendId: 'originals',
        key: uuid,
        size: String(photo.length),
        checksum: sha1(photo),
        encryption: expect.stringMatching(/^[0-9a-f]{132}$/),
      }),
    );
    const stored = await readFile(join(environment.backendRoot('originals'), original.key));
    expect(stored.length).toBeGreaterThan(photo.length);
    expect(stored.includes(photo.subarray(0, 64))).toBe(false);
    await eventually(() => expect(stat(original.originalPath)).rejects.toThrow('ENOENT'));
  });

  it('should generate thumbnails from the stored original and store them as encrypted objects', async () => {
    const files = await eventually(async () => {
      const files = await getFiles(environment, assetId);
      expect(files.map(({ type }) => type)).toEqual(['preview', 'thumbnail']);
      return files;
    });

    for (const file of files) {
      expect(file).toEqual(expect.objectContaining({ backendId: 'derived', encryption: expect.any(String) }));
      const stored = await stat(join(environment.backendRoot('derived'), file.key));
      expect(stored.size).toBeGreaterThan(Number(file.size));
    }
    await eventually(() => expect(environment.listStaging()).resolves.toEqual([]));
    // the upload was kept for processing, and removed once its thumbnails were made
    await eventually(() => expect(environment.listLocalCopies()).resolves.toEqual([]));
  });

  it('should extract metadata from the stored original', async () => {
    await eventually(async () => {
      const [exif] = await environment.query<{ make: string; modifyDate: Date }>(
        `select make, "modifyDate" from asset_exif where "assetId" = $1`,
        [assetId],
      );
      expect(exif).toEqual({ make: 'SONY', modifyDate: new Date('2020-01-02T03:04:05.000Z') });
    });
  });

  it('should stream originals, thumbnails and byte ranges from the service', async () => {
    await expect(api.download(`/assets/${assetId}/original`)).resolves.toEqual({ status: 200, body: photo });
    await expect(api.download(`/assets/${assetId}/original`, { Range: 'bytes=100-199' })).resolves.toEqual({
      status: 206,
      body: photo.subarray(100, 200),
    });
    await expect(api.download(`/assets/${assetId}/original`, { Range: 'bytes=-10' })).resolves.toEqual({
      status: 206,
      body: photo.subarray(-10),
    });
    await expect(api.download(`/assets/${assetId}/original`, { Range: `bytes=${photo.length}-` })).resolves.toEqual(
      expect.objectContaining({ status: 416 }),
    );

    const [, thumbnail] = await getFiles(environment, assetId);
    const { status, body } = await api.download(`/assets/${assetId}/thumbnail?size=thumbnail`);
    expect(status).toBe(200);
    expect(body.length).toBe(Number(thumbnail.size));
    expect(sha1(body)).toBe(thumbnail.checksum);
  });

  it('should serve thumbnails from the local cache', async () => {
    const [, thumbnail] = await getFiles(environment, assetId);
    await expect(environment.listLocalCopies({ cache: true })).resolves.toContain(thumbnail.key);

    // without the object, the thumbnail can only come from the cache
    await rm(join(environment.backendRoot('derived'), thumbnail.key));
    const { status, body } = await api.download(`/assets/${assetId}/thumbnail?size=thumbnail`);
    expect(status).toBe(200);
    expect(sha1(body)).toBe(thumbnail.checksum);
  });

  it('should answer a conditional request for an unchanged blob without the content', async () => {
    const original = await getOriginal(environment, assetId);
    await expect(
      api.download(`/assets/${assetId}/original`, { 'If-None-Match': `"${original.key}"` }),
    ).resolves.toEqual({
      status: 304,
      body: Buffer.alloc(0),
    });
  });

  it('should put stored originals into downloaded archives', async () => {
    const { status, body } = await api.downloadArchive([assetId]);

    expect(status).toBe(200);
    // the archive stores files uncompressed
    expect(body.includes(photo)).toBe(true);
  });

  it('should extract, store and encode motion photo videos', async () => {
    const { id } = await api.upload(motionPhotoPath, await readFile(motionPhotoPath));

    const [video] = await eventually(async () => {
      const rows = await environment.query<{ id: string; backendId: string }>(
        `select v.id, o."backendId" from asset a
         join asset v on v.id = a."livePhotoVideoId"
         join asset_original_file o on o."assetId" = v.id
         where a.id = $1`,
        [id],
      );
      expect(rows).toHaveLength(1);
      return rows;
    });
    expect(video.backendId).toBe('originals');

    await eventually(
      async () => {
        const files = await getFiles(environment, video.id);
        expect(files).toEqual([expect.objectContaining({ type: 'encoded_video', backendId: 'derived', key: uuid })]);
      },
      { timeout: 60_000 },
    );
  });

  it('should recover an original from the stored object and the master key file alone', async () => {
    const original = await getOriginal(environment, assetId);
    const target = join(environment.root, 'recovered.jpg');

    // the object as the service stores it, as a copy of the bucket would hold it
    const output = await runEncryptionTool([
      'decrypt',
      '--keys',
      environment.masterKeyFile,
      join(environment.backendRoot('originals'), original.key),
      target,
    ]);

    await expect(readFile(target)).resolves.toEqual(photo);
    expect(output).toContain(`stored as ${original.key}`);
    expect(output).toContain('originalFileName: el_torcal_rocks.jpg');
  });

  it('should recover a deleted original as a new photo, or delete it early with the administrator password', async () => {
    type Deleted = { items: Array<{ id: string; originalFileName: string; size: number }> };
    const content = await readFile(pngPath);
    const { id } = await api.upload(pngPath, content);
    const { id: other } = await api.upload(otherPhotoPath, await readFile(otherPhotoPath));
    await eventually(() => expect(getFiles(environment, id)).resolves.toHaveLength(2), { timeout: 60_000 });
    await api.deleteAssets([id, other]);

    const deleted = await eventually(async () => {
      const { body } = await api.json<Deleted>('/admin/storage/deletions/originals');
      const names = body.items.map(({ originalFileName }) => originalFileName);
      expect(names).toEqual(expect.arrayContaining(['density_plot.png', 'denali.webp']));
      return body.items;
    });
    const png = deleted.find(({ originalFileName }) => originalFileName === 'density_plot.png')!;
    const webp = deleted.find(({ originalFileName }) => originalFileName === 'denali.webp')!;
    expect(png.size).toBe(content.length);

    // a look at it first, decrypted
    await expect(api.download(`/admin/storage/deletions/originals/${png.id}/file`)).resolves.toEqual({
      status: 200,
      body: content,
    });

    const imported = await api.json<{ id: string; status: string }>(
      `/admin/storage/deletions/originals/${png.id}/import`,
      { method: 'POST', body: {} },
    );
    expect(imported).toEqual({ status: 201, body: { id: expect.not.stringMatching(id), status: 'created' } });
    await expect(api.download(`/assets/${imported.body.id}/original`)).resolves.toEqual({ status: 200, body: content });
    await eventually(() => expect(getFiles(environment, imported.body.id)).resolves.toHaveLength(2), {
      timeout: 60_000,
    });

    const [{ key }] = await environment.query<{ key: string }>(`select key from storage_deletion where id = $1`, [
      webp.id,
    ]);
    const purge = (password: string) =>
      api.json(`/admin/storage/deletions/originals/${webp.id}/purge`, { method: 'POST', body: { password } });
    await expect(purge('wrong')).resolves.toMatchObject({ status: 401 });
    await expect(environment.listBackend('originals')).resolves.toContain(key);
    await expect(purge('admin')).resolves.toMatchObject({ status: 204 });
    await expect(environment.listBackend('originals')).resolves.not.toContain(key);
    await expect(api.json(`/admin/storage/deletions/originals/${webp.id}/file`)).resolves.toMatchObject({
      status: 404,
    });
  });

  it('should report the status of deleting files from storage', async () => {
    const { status, body } = await api.json('/admin/storage/deletions');
    expect(status).toBe(200);
    expect(body).toEqual(
      expect.objectContaining({ isPaused: false, delayDays: 360, pendingOriginals: expect.any(Number) }),
    );
  });

  it('should store database backups on the backend for backups, readable with the master key alone', async () => {
    type Stored = { backups: Array<{ key: string; filename: string; size: number }> };
    await expect(api.json('/jobs', { method: 'POST', body: { name: 'backup-database' } })).resolves.toMatchObject({
      status: 204,
    });

    const [backup] = await eventually(
      async () => {
        const { body } = await api.json<Stored>('/admin/storage/database-backups');
        expect(body.backups).toEqual([
          {
            key: uuid,
            filename: expect.stringMatching(/^immich-db-backup-.*\.sql\.gz$/),
            size: expect.any(Number),
            createdAt: expect.any(String),
          },
        ]);
        return body.backups;
      },
      { timeout: 60_000 },
    );

    // the object holds the backup encrypted, under a random key
    const object = join(environment.backendRoot('backups'), backup.key);
    const stored = await readFile(object);
    expect(stored.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b]))).toBe(false);
    const target = join(environment.root, 'restored.sql.gz');
    await runEncryptionTool(['decrypt', '--keys', environment.masterKeyFile, object, target]);
    expect(gunzipSync(await readFile(target)).toString()).toContain('PostgreSQL database dump');

    // fetched into the backups folder, where it can be restored like any backup
    await expect(
      api.json(`/admin/storage/database-backups/${backup.key}/fetch`, { method: 'POST' }),
    ).resolves.toMatchObject({ status: 201, body: { filename: `uploaded-${backup.filename}` } });
    const { body: local } = await api.json<{ backups: Array<{ filename: string }> }>('/admin/database-backups');
    expect(local.backups.map(({ filename }) => filename)).toContain(`uploaded-${backup.filename}`);
  });

  it('should keep reading files after the master key was rotated, and encrypt new files with the new key', async () => {
    const before = await getOriginal(environment, assetId);
    const output = await runEncryptionTool(['generate-key', '--rotate', environment.masterKeyFile]);
    const [, newKeyId] = /Added master key ([0-9a-f]{16})/.exec(output) ?? [];
    expect(newKeyId).toBeDefined();
    expect(masterKeyIdOf(before)).not.toBe(newKeyId);

    await server.stop();
    server = await ImmichServer.start(environment);

    await expect(api.download(`/assets/${assetId}/original`)).resolves.toEqual({ status: 200, body: photo });
    const other = await readFile(otherPhotoPath);
    const { id } = await api.upload(otherPhotoPath, other);
    expect(masterKeyIdOf(await getOriginal(environment, id))).toBe(newKeyId);
    await expect(api.download(`/assets/${id}/original`)).resolves.toEqual({ status: 200, body: other });
  });

  it('should refuse to start when the key file lost a master key that encrypted files', async () => {
    const keyFile = await readFile(environment.masterKeyFile, 'utf8');
    const current = keyFile.split('\n').find((line) => line && !line.startsWith('#'));
    await server.stop();

    await writeFile(environment.masterKeyFile, `${current}\n`);
    await expect(ImmichServer.start(environment)).rejects.toThrow(
      `Files were encrypted with master keys that are not in ${environment.masterKeyFile}`,
    );

    await writeFile(environment.masterKeyFile, keyFile);
    server = await ImmichServer.start(environment);
  });

  it('should remove every object of permanently deleted assets', async () => {
    await eventually(
      async () => {
        const rows = await environment.query<{ count: string }>(
          `select count(*) from asset_job_status where "metadataExtractedAt" is null`,
        );
        expect(rows[0].count).toBe('0');
      },
      { timeout: 60_000 },
    );
    const assets = await environment.query<{ id: string }>(`select id from asset where visibility = 'timeline'`);
    await api.deleteAssets(assets.map(({ id }) => id));

    // kept, with what recovering the originals needs
    await eventually(async () => {
      await expect(environment.query(`select id from asset`)).resolves.toEqual([]);
      const originals = await environment.query<{ originalFileName: string; encryption: string }>(
        `select "originalFileName", encode(encryption, 'hex') as encryption from storage_deletion where "isOriginal"
         and "originalFileName" is not null order by "originalFileName"`,
      );
      expect(originals).toEqual(
        expect.arrayContaining([{ originalFileName: 'el_torcal_rocks.jpg', encryption: expect.any(String) }]),
      );
    });

    await environment.makeDeletionsDue();
    await server.stop();
    server = await ImmichServer.start(environment);

    await eventually(
      async () => {
        await expect(environment.query(`select key from storage_deletion`)).resolves.toEqual([]);
        await expect(environment.listBackend('originals')).resolves.toEqual([]);
        await expect(environment.listBackend('derived')).resolves.toEqual([]);
        await expect(environment.listLocalCopies()).resolves.toEqual([]);
        await expect(environment.listLocalCopies({ cache: true })).resolves.toEqual([]);
      },
      { timeout: 60_000 },
    );
  });
});

describe('without storage backends', () => {
  let environment: TestEnvironment;
  let server: ImmichServer;
  let api: Api;

  beforeAll(async () => {
    environment = await TestEnvironment.create();
    server = await ImmichServer.start(environment, { backends: false });
    api = await Api.signUpAdmin();
  });

  afterEach(({ task }) => {
    if (task.result?.state === 'fail') {
      printServerLogs(task.name, server);
    }
  });

  afterAll(async () => {
    await server?.stop();
    await environment?.destroy();
  });

  it('should keep uploads and thumbnails in the media location', async () => {
    const photo = await readFile(photoPath);
    const { id } = await api.upload(photoPath, photo);

    const original = await getOriginal(environment, id);
    expect(original).toEqual(
      expect.objectContaining({ backendId: 'media', key: expect.stringMatching(/^upload\//), size: null }),
    );
    await expect(readFile(original.originalPath)).resolves.toEqual(photo);

    const files = await eventually(async () => {
      const files = await getFiles(environment, id);
      expect(files).toHaveLength(2);
      return files;
    });
    for (const file of files) {
      expect(file.backendId).toBe('media');
      expect(file.path).toBe(join(environment.mediaLocation, file.key));
      await expect(stat(file.path)).resolves.toBeTruthy();
    }

    await expect(api.download(`/assets/${id}/original`)).resolves.toEqual({ status: 200, body: photo });
    await expect(environment.listStaging()).resolves.toEqual([]);
  });
});
