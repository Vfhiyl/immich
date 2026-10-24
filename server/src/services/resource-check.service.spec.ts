import { ResourceCheckService } from 'src/services/resource-check.service.js';
import { ResourceCheckLevel } from 'src/utils/server-resources.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

vitest.mock('src/utils/server-resources.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('src/utils/server-resources.js')>()),
  readMemoryLimit: () => Promise.resolve({ bytes: 4 * 1024 ** 3, source: 'cgroup' }),
  readCpuLimit: () => Promise.resolve({ cores: 2, source: 'machine' }),
  readDisk: (path: string) => Promise.resolve({ path, free: 500 * 1024 ** 3, total: 1000 * 1024 ** 3 }),
}));

describe(ResourceCheckService.name, () => {
  let sut: ResourceCheckService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(ResourceCheckService));
  });

  it('should tell what the server has against what is needed, and whether machine learning answers', async () => {
    mocks.machineLearning.ping.mockResolvedValue(true);
    mocks.machineLearning.getResources.mockResolvedValue({
      memory: { used: 1, limit: 8 * 1024 ** 3, source: 'cgroup2' },
      pressure: null,
    });

    const check = await sut.getResourceCheck();

    expect(check).toMatchObject({
      memory: { bytes: 4 * 1024 ** 3, level: ResourceCheckLevel.BelowMinimum },
      cpus: { cores: 2, level: ResourceCheckLevel.BelowRecommended },
      disk: { free: 500 * 1024 ** 3, level: ResourceCheckLevel.Ok },
      machineLearning: {
        enabled: true,
        services: [
          {
            url: 'http://immich-machine-learning:3003',
            reachable: true,
            memory: { limit: 8 * 1024 ** 3, source: 'cgroup2' },
          },
        ],
      },
      requirements: { memoryMinimum: 6 * 1024 ** 3, cpusRecommended: 4 },
    });
  });

  it('should tell a machine learning service that does not answer', async () => {
    mocks.machineLearning.ping.mockResolvedValue(false);
    mocks.machineLearning.getResources.mockResolvedValue(null);

    const { machineLearning } = await sut.getResourceCheck();

    expect(machineLearning.services).toEqual([
      { url: 'http://immich-machine-learning:3003', reachable: false, memory: null },
    ]);
  });

  it('should not ask machine learning when it is disabled', async () => {
    mocks.systemMetadata.get.mockResolvedValue({ machineLearning: { enabled: false } });

    await expect(sut.getResourceCheck()).resolves.toMatchObject({ machineLearning: { enabled: false, services: [] } });
    expect(mocks.machineLearning.ping).not.toHaveBeenCalled();
  });
});
