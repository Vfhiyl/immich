import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaults } from 'src/dtos/config.dto.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MachineLearningRepository, ModelTask } from 'src/repositories/machine-learning.repository.js';

const answer = { [ModelTask.SEARCH]: '[0.1]', imageHeight: 1, imageWidth: 1 };

describe(MachineLearningRepository.name, () => {
  let sut: MachineLearningRepository;
  let folder: string;
  let image: string;
  const fetch = vitest.fn();

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'immich-ml-'));
    image = join(folder, 'preview.jpg');
    await writeFile(image, 'jpeg');
    vitest.stubGlobal('fetch', fetch);
    fetch.mockReset();
    fetch.mockImplementation(() => Promise.resolve(Response.json(answer)));
    sut = new MachineLearningRepository({
      setContext: () => {},
      log: () => {},
      warn: () => {},
    } as unknown as LoggingRepository);
    sut.setup({
      ...defaults.machineLearning,
      availabilityChecks: { ...defaults.machineLearning.availabilityChecks, enabled: false },
    });
  });

  afterEach(async () => {
    vitest.unstubAllGlobals();
    await rm(folder, { recursive: true, force: true });
  });

  it('should hold requests for photos until released, and not those for text', async () => {
    sut.hold();

    const photo = sut.encodeImage(image, defaults.machineLearning.clip);
    await expect(sut.encodeText('a dog', { modelName: 'ViT-B-32__openai' })).resolves.toBe('[0.1]');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetch).toHaveBeenCalledTimes(1);

    sut.release();
    await expect(photo).resolves.toMatchObject({ embedding: '[0.1]' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('should tell the resources of a service, and nothing when it has no such route or does not answer', async () => {
    const resources = { memory: { used: 1, limit: 2, source: 'cgroup2' }, pressure: null };
    fetch.mockResolvedValueOnce(Response.json(resources));
    await expect(sut.getResources('http://ml:3003')).resolves.toEqual(resources);

    fetch.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));
    await expect(sut.getResources('http://ml:3003')).resolves.toBeNull();

    fetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(sut.getResources('http://ml:3003')).resolves.toBeNull();
    await expect(sut.ping('http://ml:3003')).resolves.toBe(true);
  });
});
