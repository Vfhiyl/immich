import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCAL_COPY_LIMITS, LocalCopies } from 'src/repositories/local-copies.js';

const location = (key: string) => ({ backendId: 'originals', key });

describe(LocalCopies.name, () => {
  let folder: string;
  let root: string;
  let now: number;

  const create = (limits = {}) => new LocalCopies(root, { ...LOCAL_COPY_LIMITS, ...limits }, () => now);
  const writeUpload = async (name: string, content: string | Buffer) => {
    const path = join(folder, name);
    await fs.writeFile(path, content);
    return path;
  };
  const copies = async () => {
    const entries = await fs.readdir(join(root, 'originals')).catch(() => []);
    return entries.toSorted((a, b) => a.localeCompare(b));
  };

  beforeEach(async () => {
    folder = await fs.mkdtemp(join(tmpdir(), 'immich-local-copies-'));
    root = join(folder, 'copies');
    now = Date.now();
  });

  afterEach(async () => {
    await fs.rm(folder, { recursive: true, force: true });
  });

  it('should move a file into the copies and link it for readers', async () => {
    const sut = create();
    const upload = await writeUpload('upload.jpg', 'photo');

    await expect(sut.keep(location('a'), upload)).resolves.toBe(true);
    await expect(fs.access(upload)).rejects.toThrow('ENOENT');

    const target = join(folder, 'lease.jpg');
    await expect(sut.linkTo(location('a'), target)).resolves.toBe(true);
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('photo');
  });

  it('should keep a linked file readable when the copy is dropped', async () => {
    const sut = create();
    await sut.keep(location('a'), await writeUpload('upload.jpg', 'photo'));
    const target = join(folder, 'lease.jpg');
    await sut.linkTo(location('a'), target);

    await sut.drop(location('a'));

    await expect(fs.readFile(target, 'utf8')).resolves.toBe('photo');
    await expect(sut.linkTo(location('a'), join(folder, 'other.jpg'))).resolves.toBe(false);
  });

  it('should report a missing copy, and drop one that is gone without failing', async () => {
    const sut = create();
    await expect(sut.linkTo(location('missing'), join(folder, 'lease.jpg'))).resolves.toBe(false);
    await expect(sut.drop(location('missing'))).resolves.toBeUndefined();
  });

  it('should tell whether a copy of a size would be kept', async () => {
    await expect(create({ maxBytes: 100 }).canKeep(100)).resolves.toBe(true);
    await expect(create({ maxBytes: 100 }).canKeep(101)).resolves.toBe(false);
    await expect(create({ minFreeShare: 1 }).canKeep(1)).resolves.toBe(false);
    await expect(create().canKeep(Infinity)).resolves.toBe(false);
  });

  it('should not keep a copy when the filesystem would run short of space', async () => {
    const sut = create({ minFreeShare: 1 });
    const upload = await writeUpload('upload.jpg', 'photo');

    await expect(sut.keep(location('a'), upload)).resolves.toBe(false);
    await expect(fs.readFile(upload, 'utf8')).resolves.toBe('photo');
  });

  it('should reject a location that would leave the copies folder', async () => {
    const sut = create();
    const upload = await writeUpload('upload.jpg', 'photo');

    await expect(sut.keep({ backendId: 'originals', key: '../escape' }, upload)).rejects.toThrow('Invalid blob key');
    await expect(sut.linkTo({ backendId: '..', key: 'a' }, join(folder, 'x'))).rejects.toThrow('Invalid blob key');
  });

  it('should remove copies that are too old', async () => {
    const sut = create();
    await sut.keep(location('old'), await writeUpload('old.jpg', 'old'));
    now += LOCAL_COPY_LIMITS.maxAgeMs + 1000;
    await sut.keep(location('new'), await writeUpload('new.jpg', 'new'));

    await sut.sweep();

    await expect(copies()).resolves.toEqual(['new']);
  });

  it('should sweep by itself once enough was added since the last sweep', async () => {
    const sut = create({ maxBytes: 1000 });
    await sut.keep(location('old'), await writeUpload('old.jpg', 'old'));
    now += LOCAL_COPY_LIMITS.maxAgeMs + 1000;

    // 5% of the space, i.e. 50 bytes, triggers a sweep
    await sut.keep(location('small'), await writeUpload('small.jpg', Buffer.alloc(10)));
    await expect(copies()).resolves.toEqual(['old', 'small']);
    await sut.keep(location('large'), await writeUpload('large.jpg', Buffer.alloc(100)));
    await expect(copies()).resolves.toEqual(['large', 'small']);
  });

  it('should find a copy, refreshing it when reads count as use', async () => {
    const cache = create({ refreshOnRead: true });
    await cache.keep(location('a'), await writeUpload('a.jpg', 'a'));
    now += 60_000;

    expect(cache.find(location('a'))).toBe(join(root, 'originals', 'a'));
    expect(cache.find(location('missing'))).toBeUndefined();

    await vi.waitFor(async () => {
      const { mtimeMs } = await fs.stat(join(root, 'originals', 'a'));
      expect(Math.round(mtimeMs / 1000)).toBe(Math.round(now / 1000));
    });
  });

  it('should keep the copies that were read recently when making space', async () => {
    const cache = create({ refreshOnRead: true, maxBytes: 250 });
    await cache.keep(location('a'), await writeUpload('a.jpg', Buffer.alloc(100)));
    now += 1000;
    await cache.keep(location('b'), await writeUpload('b.jpg', Buffer.alloc(100)));
    now += 1000;
    // a is the oldest, but is read now
    await cache.linkTo(location('a'), join(folder, 'lease.jpg'));
    now += 1000;

    // adding c makes space by removing the least recently used copy
    await cache.keep(location('c'), await writeUpload('c.jpg', Buffer.alloc(100)));

    await expect(copies()).resolves.toEqual(['a', 'c']);
  });

  it('should not refresh copies that are only kept for a while', async () => {
    const sut = create();
    await sut.keep(location('a'), await writeUpload('a.jpg', 'a'));
    const before = await fs.stat(join(root, 'originals', 'a'));
    now += 60_000;

    await sut.linkTo(location('a'), join(folder, 'lease.jpg'));
    expect(sut.find(location('a'))).toBeDefined();

    const after = await fs.stat(join(root, 'originals', 'a'));
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('should remove the oldest copies when they take more than their space', async () => {
    const sut = create({ maxBytes: 250 });
    for (const [index, key] of ['a', 'b', 'c'].entries()) {
      const upload = await writeUpload(`${key}.jpg`, Buffer.alloc(100));
      await sut.keep(location(key), upload);
      // copies are aged by their modification time
      const time = new Date(now - (10 - index) * 1000);
      await fs.utimes(join(root, 'originals', key), time, time);
    }

    await sut.sweep();

    await expect(copies()).resolves.toEqual(['b', 'c']);
  });

  it('should sweep an empty or missing folder', async () => {
    await expect(create().sweep()).resolves.toBeUndefined();
  });
});
