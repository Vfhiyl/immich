import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSessionStore, getSessionsPath } from 'src/resumable.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe(FileSessionStore.name, () => {
  const session = { location: '/api/upload/1', size: 10, checksum: 'abc' };
  let directory: string;
  let path: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'immich-cli-'));
    path = getSessionsPath(join(directory, 'config'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('keeps uploads in progress for the next run of the command', async () => {
    const store = new FileSessionStore(path);
    expect(await store.get('a')).toBeUndefined();
    await store.put('a', session);
    await store.put('b', session);

    const next = new FileSessionStore(path);
    expect(await next.get('a')).toEqual(session);
    await next.remove('a');
    await next.remove('a');
    expect(await new FileSessionStore(path).get('a')).toBeUndefined();
    expect(await new FileSessionStore(path).get('b')).toEqual(session);
  });

  it('keeps every upload when many change at once', async () => {
    const store = new FileSessionStore(path);
    await Promise.all(Array.from({ length: 50 }, (_, i) => store.put(String(i), session)));

    const next = new FileSessionStore(path);
    for (let i = 0; i < 50; i++) {
      expect(await next.get(String(i))).toEqual(session);
    }
  });

  it('is readable only by the user, as the key next to it', async () => {
    await new FileSessionStore(path).put('a', session);

    const { mode } = await stat(path);
    expect(mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ a: session });
  });

  it('forgets what it cannot read', async () => {
    await new FileSessionStore(path).put('a', session);
    await writeFile(path, 'not json');

    expect(await new FileSessionStore(path).get('a')).toBeUndefined();
  });
});
