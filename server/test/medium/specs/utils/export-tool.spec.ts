import { Kysely } from 'kysely';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageCore } from 'src/cores/storage.core.js';
import { StorageBackendDriver, StorageBackendRole } from 'src/enum.js';
import { MasterKeys } from 'src/repositories/key-provider.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StorageBackendRepository } from 'src/repositories/storage-backend.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { Exporter } from 'src/utils/export-tool.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

describe(Exporter.name, () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'immich-export-'));
    StorageCore.setMediaLocation(join(root, 'media'));
  });

  afterEach(async () => {
    StorageCore.setMediaLocation('/data');
    await fs.rm(root, { recursive: true, force: true });
  });

  const setup = async () => {
    const db: Kysely<DB> = await getKyselyDB();
    const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
    const backends = new StorageBackendRepository(db, LoggingRepository.create());
    await backends.register([{ id: 'originals', driver: StorageBackendDriver.Local }]);
    backends.configure(
      [
        {
          id: 'originals',
          driver: StorageBackendDriver.Local,
          role: StorageBackendRole.Originals,
          root: join(root, 'bucket'),
          encrypted: true,
        },
      ],
      new MasterKeys([randomBytes(32)]),
    );
    const { user } = await ctx.newUser({ email: 'alice@example.com' });

    const original = async (originalFileName: string, localDateTime: string, content: Buffer) => {
      const upload = join(root, 'upload');
      await fs.writeFile(upload, content);
      const stored = await backends.storeFile(StorageBackendRole.Originals, upload);
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        originalFileName,
        localDateTime,
        originalFile: stored,
      });
      return asset;
    };
    const out = join(root, 'out');
    return {
      ctx,
      db,
      user,
      backends,
      original,
      out,
      exporter: new Exporter(backends, { log: vi.fn(), error: vi.fn() }),
    };
  };

  it('should export every original decrypted, with its metadata, into folders by user and day', async () => {
    const { ctx, db, user, original, out, exporter } = await setup();
    const photo = randomBytes(2000);
    const asset = await original('IMG_0001.jpg', '2021-07-04T18:30:00.000Z', photo);
    await ctx.newExif({ assetId: asset.id, latitude: 31.2304, longitude: 121.4737, description: 'Lunch', rating: 5 });
    await ctx.newAlbum({ ownerId: user.id, albumName: 'Holiday' }, [asset.id]);
    const { tag } = await ctx.newTag({ userId: user.id, value: 'Food' });
    await ctx.newTagAsset({ tagIds: [tag.id!], assetIds: [asset.id] });
    const { person } = await ctx.newPerson({ ownerId: user.id, name: 'Bob' });
    await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });
    // another photo of the same name on the same day
    await original('IMG_0001.jpg', '2021-07-04T20:00:00.000Z', randomBytes(10));

    await expect(exporter.exportFromDatabase(db, { output: out })).resolves.toEqual({
      exported: 2,
      skipped: 0,
      failed: 0,
    });

    const folder = join(out, 'alice@example.com', '2021', '2021-07-04');
    const names = await fs.readdir(folder);
    expect(names.toSorted((a, b) => a.localeCompare(b))).toEqual([
      'IMG_0001 (2).jpg',
      'IMG_0001 (2).jpg.json',
      'IMG_0001 (2).jpg.xmp',
      'IMG_0001.jpg',
      'IMG_0001.jpg.json',
      'IMG_0001.jpg.xmp',
    ]);
    await expect(fs.readFile(join(folder, 'IMG_0001.jpg'))).resolves.toEqual(photo);
    const json = JSON.parse(await fs.readFile(join(folder, 'IMG_0001.jpg.json'), 'utf8'));
    expect(json).toMatchObject({
      id: asset.id,
      owner: 'alice@example.com',
      localDateTime: '2021-07-04T18:30:00',
      exif: { latitude: 31.2304, description: 'Lunch', rating: 5 },
      albums: ['Holiday'],
      tags: ['Food'],
      people: ['Bob'],
    });
    const xmp = await fs.readFile(join(folder, 'IMG_0001.jpg.xmp'), 'utf8');
    expect(xmp).toContain('<xmp:Rating>5</xmp:Rating>');
    expect(xmp).toContain('<rdf:li>Bob</rdf:li>');

    // started again, it keeps what it exported and finds the same names
    await expect(exporter.exportFromDatabase(db, { output: out })).resolves.toEqual({
      exported: 0,
      skipped: 2,
      failed: 0,
    });
  });

  it('should report an original that is damaged, and export the others', async () => {
    const { db, original, out, exporter } = await setup();
    const damaged = await original('damaged.jpg', '2021-07-04T18:30:00.000Z', randomBytes(100));
    await original('fine.jpg', '2021-07-04T18:30:00.000Z', randomBytes(100));
    const [{ key }] = await db
      .selectFrom('asset_original_file')
      .select('key')
      .where('assetId', '=', damaged.id)
      .execute();
    const stored = await fs.readFile(join(root, 'bucket', key));
    stored[80] ^= 1;
    await fs.writeFile(join(root, 'bucket', key), stored);

    await expect(exporter.exportFromDatabase(db, { output: out })).resolves.toEqual({
      exported: 1,
      skipped: 0,
      failed: 1,
    });
    const folder = join(out, 'alice@example.com', '2021', '2021-07-04');
    const names = await fs.readdir(folder);
    expect(names).toContain('fine.jpg');
    expect(names).not.toContain('damaged.jpg');
    expect(names.some((name) => name.endsWith('.part'))).toBe(false);
  });

  it('should only export the originals of the given users, and leave out the trash unless asked', async () => {
    const { ctx, db, original, out, exporter } = await setup();
    const trashed = await original('trashed.jpg', '2021-07-04T18:30:00.000Z', randomBytes(10));
    await db.updateTable('asset').set({ deletedAt: new Date() }).where('id', '=', trashed.id).execute();
    const { user: other } = await ctx.newUser({ email: 'bob@example.com' });
    await ctx.newAsset({ ownerId: other.id });

    await expect(exporter.exportFromDatabase(db, { output: out, users: ['alice@example.com'] })).resolves.toEqual({
      exported: 0,
      skipped: 0,
      failed: 0,
    });
    await expect(
      exporter.exportFromDatabase(db, { output: out, users: ['alice@example.com'], includeTrashed: true }),
    ).resolves.toMatchObject({ exported: 1 });
  });
});
