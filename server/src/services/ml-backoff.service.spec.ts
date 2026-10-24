import { SystemConfig, defaults } from 'src/dtos/config.dto.js';
import { ImmichWorker, QueueName, SystemMetadataKey } from 'src/enum.js';
import { MachineLearningBackoffService } from 'src/services/ml-backoff.service.js';
import { BackoffLevel, ResourceSample } from 'src/utils/ml-backoff.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const GiB = 1024 ** 3;
const sample = (share: number): ResourceSample => ({
  memory: { used: share * 8 * GiB, limit: 8 * GiB, source: 'cgroup2' },
  pressure: { some: 0, full: 0 },
});
const queues = [QueueName.SmartSearch, QueueName.FaceDetection, QueueName.Ocr];

describe(MachineLearningBackoffService.name, () => {
  let sut: MachineLearningBackoffService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(MachineLearningBackoffService));
    mocks.config.getWorker.mockReturnValue(ImmichWorker.Microservices);
  });

  it('should leave the jobs as they are while the memory is free', async () => {
    mocks.machineLearning.getResources.mockResolvedValue(sample(0.5));

    await sut.check();

    expect(mocks.job.setConcurrency).not.toHaveBeenCalled();
    expect(mocks.job.pauseWorker).not.toHaveBeenCalled();
    expect(mocks.systemMetadata.set).toHaveBeenCalledWith(
      SystemMetadataKey.MachineLearningBackoff,
      expect.objectContaining({ level: BackoffLevel.Normal, memory: sample(0.5).memory }),
    );
  });

  it('should run the jobs that send photos to machine learning one at a time, then not at all', async () => {
    mocks.machineLearning.getResources.mockResolvedValue(sample(0.9));
    await sut.check();
    for (const queue of queues) {
      expect(mocks.job.setConcurrency).toHaveBeenCalledWith(queue, 1);
    }
    expect(mocks.job.setConcurrency).not.toHaveBeenCalledWith(QueueName.FacialRecognition, expect.anything());

    mocks.machineLearning.getResources.mockResolvedValue(sample(0.97));
    await sut.check();
    for (const queue of queues) {
      expect(mocks.job.pauseWorker).toHaveBeenCalledWith(queue);
    }
    expect(mocks.machineLearning.hold).toHaveBeenCalled();
    expect(mocks.logger.warn).toHaveBeenLastCalledWith(expect.stringContaining('reduced -> paused'));
  });

  it('should give the jobs back their concurrency once the memory is free again', async () => {
    mocks.machineLearning.getResources.mockResolvedValue(sample(0.9));
    await sut.check();
    mocks.job.setConcurrency.mockClear();
    mocks.machineLearning.getResources.mockResolvedValue(sample(0.5));

    await sut.check();
    await sut.check();
    expect(mocks.job.setConcurrency).toHaveBeenCalledWith(QueueName.SmartSearch, 1);
    mocks.job.setConcurrency.mockClear();
    await sut.check();

    const config = defaults as SystemConfig;
    expect(mocks.job.resumeWorker).toHaveBeenCalledWith(QueueName.SmartSearch);
    expect(mocks.machineLearning.release).toHaveBeenCalled();
    expect(mocks.job.setConcurrency).toHaveBeenCalledWith(QueueName.SmartSearch, config.job.smartSearch.concurrency);
    expect(mocks.job.setConcurrency).toHaveBeenCalledWith(QueueName.Ocr, config.job.ocr.concurrency);
  });

  it('should go by the service that is shortest of memory, and keep the level without an answer', async () => {
    mocks.systemMetadata.get.mockResolvedValue({
      machineLearning: { urls: ['http://a:3003', 'http://b:3003', 'http://c:3003'] },
    });
    mocks.machineLearning.getResources.mockImplementation((url) =>
      Promise.resolve(url.startsWith('http://b') ? sample(0.97) : url.startsWith('http://a') ? sample(0.5) : null),
    );

    await sut.check();
    expect(mocks.job.pauseWorker).toHaveBeenCalledTimes(3);

    mocks.machineLearning.getResources.mockResolvedValue(null);
    await sut.check();
    expect(mocks.job.pauseWorker).toHaveBeenCalledTimes(6);
  });

  it('should do nothing when machine learning is disabled', async () => {
    mocks.systemMetadata.get.mockResolvedValue({ machineLearning: { enabled: false } });

    await sut.check();

    expect(mocks.machineLearning.getResources).not.toHaveBeenCalled();
  });
});
