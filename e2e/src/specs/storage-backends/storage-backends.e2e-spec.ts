import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Api, ImmichServer, S3Service, TestEnvironment, eventually, sha1, testAssetDir } from 'src/storage-backends.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const photoPath = join(testAssetDir, 'formats/jpg/el_torcal_rocks.jpg');
const motionPhotoPath = join(testAssetDir, 'formats/motionphoto/pixel-6-pro.jpg');
const uuid = expect.stringMatching(/^[0-9a-f-]{36}$/);

type OriginalRow = { backendId: string; key: string; size: string; checksum: string; originalPath: string };
type FileRow = { type: string; backendId: string; key: string; size: string; path: string };

const getOriginal = async (environment: TestEnvironment, assetId: string) => {
  const [row] = await environment.query<OriginalRow>(
    `select o."backendId", o.key, o.size, encode(o.checksum, 'hex') as checksum, a."originalPath"
     from asset a join asset_original_file o on o."assetId" = a.id where a.id = $1`,
    [assetId],
  );
  return row;
};

const getFiles = (environment: TestEnvironment, assetId: string) =>
  environment.query<FileRow>(
    `select type, "backendId", key, size, path from asset_file where "assetId" = $1 order by type`,
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

  it('should remove every file of permanently deleted assets from the backends', async () => {
    const assets = await environment.query<{ id: string }>(
      `select id from asset where "livePhotoVideoId" is not null or id = $1`,
      [assetId],
    );
    await api.deleteAssets(assets.map(({ id }) => id));

    await eventually(async () => {
      await expect(environment.query(`select id from asset`)).resolves.toEqual([]);
      await expect(environment.listBackend('originals')).resolves.toEqual([]);
      await expect(environment.listBackend('derived')).resolves.toEqual([]);
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
    ]);
    server = await ImmichServer.start(environment);
    api = await Api.signUpAdmin();

    photo = await readFile(photoPath);
    ({ id: assetId } = await api.upload(photoPath, photo));
  });

  afterAll(async () => {
    await server?.stop();
    s3?.stop();
    await environment?.destroy();
  });

  it('should store an upload as an object and remove the uploaded file', async () => {
    const original = await getOriginal(environment, assetId);

    expect(original).toEqual(expect.objectContaining({ backendId: 'originals', key: uuid, checksum: sha1(photo) }));
    await expect(readFile(join(environment.backendRoot('originals'), original.key))).resolves.toEqual(photo);
    await eventually(() => expect(stat(original.originalPath)).rejects.toThrow('ENOENT'));
  });

  it('should generate thumbnails from the stored original and store them as objects', async () => {
    const files = await eventually(async () => {
      const files = await getFiles(environment, assetId);
      expect(files.map(({ type }) => type)).toEqual(['preview', 'thumbnail']);
      return files;
    });

    for (const file of files) {
      expect(file.backendId).toBe('derived');
      const stored = await stat(join(environment.backendRoot('derived'), file.key));
      expect(String(stored.size)).toBe(file.size);
    }
    await eventually(() => expect(environment.listStaging()).resolves.toEqual([]));
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
    const storedThumbnail = await readFile(join(environment.backendRoot('derived'), thumbnail.key));
    await expect(api.download(`/assets/${assetId}/thumbnail?size=thumbnail`)).resolves.toEqual({
      status: 200,
      body: storedThumbnail,
    });
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

    await eventually(
      async () => {
        await expect(environment.query(`select id from asset`)).resolves.toEqual([]);
        await expect(environment.listBackend('originals')).resolves.toEqual([]);
        await expect(environment.listBackend('derived')).resolves.toEqual([]);
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
