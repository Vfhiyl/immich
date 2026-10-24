import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  Api,
  FakeMachineLearning,
  ImmichServer,
  TestEnvironment,
  eventually,
  testAssetDir,
} from 'src/storage-backends.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const photoPath = join(testAssetDir, 'formats/jpg/el_torcal_rocks.jpg');
const otherPhotoPath = join(testAssetDir, 'formats/webp/denali.webp');

const byId = (a: string, b: string) => a.localeCompare(b);

type TaskModels = {
  task: string;
  target: { name: string; fingerprint: string | null };
  active: { name: string; fingerprint: string | null } | null;
  rebuild: { finishedAt: string | null; total: number | null; done: number | null } | null;
  replaced: { from: { fingerprint: string }; to: { fingerprint: string } } | null;
};

// a server whose model of smart search changes: its files (downloaded again), then its name in the settings; the
// embeddings are made again in the background and searched only once every photo has one
describe('models of machine learning', () => {
  let environment: TestEnvironment;
  let server: ImmichServer;
  let ml: FakeMachineLearning;
  let api: Api;
  const assetIds: string[] = [];

  const clip = async () => {
    const { body } = await api.json<{ tasks: TaskModels[] }>('/admin/machine-learning/models');
    return body.tasks.find(({ task }) => task === 'clip')!;
  };
  // the server keeps the embeddings of queries: another query is encoded again
  const search = async (query = 'rocks') => {
    const { body } = await api.json<{ assets: { items: Array<{ id: string }> } }>('/search/smart', {
      method: 'POST',
      body: { query },
    });
    return body.assets.items.map(({ id }) => id).toSorted(byId);
  };
  const setModel = async (modelName: string) => {
    const { body } = await api.json<Record<string, Record<string, unknown>>>('/system-config');
    const machineLearning = body.machineLearning as Record<string, Record<string, unknown>>;
    await api.json('/system-config', {
      method: 'PUT',
      body: {
        ...body,
        newVersionCheck: { ...body.newVersionCheck, enabled: false },
        reverseGeocoding: { ...body.reverseGeocoding, enabled: false },
        machineLearning: {
          ...machineLearning,
          enabled: true,
          urls: [ml.url],
          clip: { ...machineLearning.clip, enabled: true, modelName },
          facialRecognition: { ...machineLearning.facialRecognition, enabled: false },
          ocr: { ...machineLearning.ocr, enabled: false },
        },
      },
    });
  };

  beforeAll(async () => {
    ml = await FakeMachineLearning.start();
    environment = await TestEnvironment.create({ configFile: false });
    server = await ImmichServer.start(environment, { backends: false });
    api = await Api.signUpAdmin();
    await setModel('ViT-B-32__openai');
    for (const path of [photoPath, otherPhotoPath]) {
      const { id } = await api.upload(path, await readFile(path));
      assetIds.push(id);
    }
    await eventually(async () => expect(await search()).toEqual(assetIds.toSorted(byId)), { timeout: 60_000 });
  }, 120_000);

  afterEach(({ task }) => {
    if (task.result?.state === 'fail') {
      console.log(`Server output for "${task.name}":\n${server?.logs.split('\n').slice(-80).join('\n')}`);
    }
  });

  afterAll(async () => {
    await server?.stop();
    await ml?.stop();
    await environment?.destroy();
  });

  it('should learn the files of the model from its results, with nothing to make again', async () => {
    await expect(clip()).resolves.toMatchObject({
      target: { name: 'ViT-B-32__openai', fingerprint: 'a'.repeat(64) },
      active: { name: 'ViT-B-32__openai', fingerprint: 'a'.repeat(64) },
      rebuild: null,
    });
  });

  it('should make every embedding again when the files of the model change, and switch to them at once', async () => {
    ml.fingerprint = 'b'.repeat(64);
    // the embedding of a new photo is the first result with the new files
    const { id } = await api.upload(photoPath, Buffer.concat([await readFile(photoPath), Buffer.from('new')]));
    assetIds.push(id);

    const done = await eventually(
      async () => {
        const state = await clip();
        expect(state.rebuild?.finishedAt).toBeTruthy();
        return state;
      },
      { timeout: 150_000 },
    );

    expect(done).toMatchObject({
      target: { fingerprint: 'b'.repeat(64) },
      active: { fingerprint: 'b'.repeat(64) },
      replaced: { from: { fingerprint: 'a'.repeat(64) }, to: { fingerprint: 'b'.repeat(64) } },
    });
    await eventually(async () => expect(await search()).toEqual(assetIds.toSorted(byId)), { timeout: 60_000 });
    const [{ count }] = await environment.query<{ count: string }>('select count(*) from smart_search_rebuild');
    expect(count).toBe('0');
  }, 240_000);

  it('should search with the old model until a model of another dimension has every embedding', async () => {
    ml.requests.length = 0;
    const release = ml.hold('ViT-L-14__openai');
    await setModel('ViT-L-14__openai');

    // meanwhile, searches still use the model whose embeddings are searched
    await eventually(async () => expect(ml.requests).toContain('clip/visual ViT-L-14__openai'));
    await expect(clip()).resolves.toMatchObject({
      target: { name: 'ViT-L-14__openai' },
      active: { name: 'ViT-B-32__openai' },
      rebuild: { finishedAt: null, total: 3 },
    });
    expect(await search('mountains')).toEqual(assetIds.toSorted(byId));
    expect(ml.requests).toContain('clip/textual ViT-B-32__openai');
    release();

    await eventually(
      async () => expect(await clip()).toMatchObject({ active: { name: 'ViT-L-14__openai' }, rebuild: { done: null } }),
      { timeout: 150_000 },
    );
    const [{ dimensions }] = await environment.query<{ dimensions: number }>(
      `select atttypmod as dimensions from pg_attribute where attrelid = 'smart_search'::regclass and attname = 'embedding'`,
    );
    expect(dimensions).toBe(768);
    await eventually(async () => expect(await search('lakes')).toEqual(assetIds.toSorted(byId)), { timeout: 60_000 });
    expect(ml.requests).toContain('clip/textual ViT-L-14__openai');
  }, 240_000);
});
