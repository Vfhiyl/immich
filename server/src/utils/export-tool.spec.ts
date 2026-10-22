import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageCore } from 'src/cores/storage.core.js';
import { StorageBackendDriver, StorageBackendRole } from 'src/enum.js';
import { MasterKeys } from 'src/repositories/key-provider.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StorageBackendRepository } from 'src/repositories/storage-backend.repository.js';
import { Exporter, runExportTool, toExportFolder, toSafeName, toXmp } from 'src/utils/export-tool.js';

const output = { log: vi.fn(), error: vi.fn() };

describe('export tool', () => {
  describe(toXmp.name, () => {
    it('should describe the dates, place, description, rating, tags and people', () => {
      const xmp = toXmp({
        localDateTime: new Date('2021-07-04T18:30:00.000Z'),
        exif: {
          latitude: 31.2304,
          longitude: -121.4737,
          description: 'Fish & <chips>',
          rating: 4,
          dateTimeOriginal: null,
          timeZone: null,
          make: null,
          model: null,
          city: null,
          state: null,
          country: null,
        },
        tags: ['Holiday'],
        people: ['Alice', 'Bob'],
      });

      expect(xmp).toContain('<exif:DateTimeOriginal>2021-07-04T18:30:00</exif:DateTimeOriginal>');
      expect(xmp).toContain('<exif:GPSLatitude>31,13.824000N</exif:GPSLatitude>');
      expect(xmp).toContain('<exif:GPSLongitude>121,28.422000W</exif:GPSLongitude>');
      expect(xmp).toContain('<xmp:Rating>4</xmp:Rating>');
      expect(xmp).toContain('<rdf:li xml:lang="x-default">Fish &amp; &lt;chips&gt;</rdf:li>');
      expect(xmp).toContain('<rdf:Bag><rdf:li>Holiday</rdf:li></rdf:Bag>');
      expect(xmp).toContain('<rdf:Bag><rdf:li>Alice</rdf:li><rdf:li>Bob</rdf:li></rdf:Bag>');
    });

    it('should leave out what is not known', () => {
      const xmp = toXmp({ localDateTime: new Date('2021-07-04T18:30:00.000Z'), exif: null, tags: [], people: [] });
      expect(xmp).not.toContain('GPS');
      expect(xmp).not.toContain('Rating');
      expect(xmp).not.toContain('rdf:Bag');
    });
  });

  it('should make names safe as one path segment', () => {
    expect(toSafeName('IMG_0001.jpg')).toBe('IMG_0001.jpg');
    expect(toSafeName('../etc/passwd')).toBe('.._etc_passwd');
    expect(toSafeName('a:b*c?.jpg')).toBe('a_b_c_.jpg');
    expect(toSafeName('..')).toBe('_');
    expect(toSafeName('')).toBe('_');
  });

  it('should put an asset in a folder of its user, year and day', () => {
    expect(toExportFolder('/out', 'alice@example.com', new Date('2021-07-04T18:30:00.000Z'))).toBe(
      '/out/alice@example.com/2021/2021-07-04',
    );
    expect(toExportFolder('/out', 'alice@example.com', null)).toBe('/out/alice@example.com/undated');
  });

  it('should need a storage configuration and an absolute output folder', async () => {
    await expect(runExportTool(['--output', 'relative', '--storage', '/s.yaml'], output)).resolves.toBe(2);
    await expect(runExportTool(['--storage', '/s.yaml'], output)).resolves.toBe(2);
    await expect(runExportTool(['--help'], output)).resolves.toBe(0);
  });

  describe('without a database', () => {
    let root: string;

    beforeEach(async () => {
      root = await fs.mkdtemp(join(tmpdir(), 'immich-export-'));
      StorageCore.setMediaLocation(join(root, 'media'));
    });

    afterEach(async () => {
      StorageCore.setMediaLocation('/data');
      await fs.rm(root, { recursive: true, force: true });
    });

    it('should export the originals by what their encrypted objects describe, once', async () => {
      const backends = new StorageBackendRepository(undefined as never, LoggingRepository.create());
      vi.spyOn(backends, 'registerWrite').mockResolvedValue();
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
      const photo = randomBytes(1000);
      const upload = join(root, 'upload.jpg');
      await fs.writeFile(upload, photo);
      const manifest = { ownerId: 'user-1', originalFileName: 'IMG_0001.jpg' };
      await backends.storeFile(StorageBackendRole.Originals, upload, { manifest });
      await fs.writeFile(join(root, 'upload.xmp'), '<xmp/>');
      await backends.storeFile(StorageBackendRole.Originals, join(root, 'upload.xmp'), { manifest });
      // another photo of the same name
      await backends.storeFile(StorageBackendRole.Originals, upload, { manifest });

      const exporter = new Exporter(backends, output);
      const out = join(root, 'out');
      await expect(exporter.exportFromObjects({ output: out })).resolves.toEqual({
        exported: 3,
        skipped: 0,
        failed: 0,
      });

      const today = new Date().toISOString().slice(0, 10);
      const folder = join(out, 'user-1', today.slice(0, 4), today);
      const files = await fs.readdir(folder);
      expect(files.filter((name) => !name.endsWith('.json')).toSorted()).toEqual([
        'IMG_0001 (2).jpg',
        'IMG_0001.jpg',
        'IMG_0001.jpg.xmp',
      ]);
      await expect(fs.readFile(join(folder, 'IMG_0001.jpg'))).resolves.toEqual(photo);
      await expect(fs.readFile(join(folder, 'IMG_0001.jpg.xmp'), 'utf8')).resolves.toBe('<xmp/>');

      // started again, it keeps what it exported
      await expect(exporter.exportFromObjects({ output: out })).resolves.toEqual({
        exported: 0,
        skipped: 3,
        failed: 0,
      });
    });
  });
});
