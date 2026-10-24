import { Injectable } from '@nestjs/common';
import { OnEvent } from 'src/decorators.js';
import { SystemConfig } from 'src/dtos/config.dto.js';
import { ImmichWorker, SystemMetadataKey } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { handlePromiseError, isMachineLearningEnabled } from 'src/utils/misc.js';
import {
  BACKOFF_QUEUES,
  BackoffLevel,
  BackoffState,
  ResourceSample,
  assessSample,
  nextBackoff,
} from 'src/utils/ml-backoff.js';

/** How often the memory of the machine learning service is looked at */
export const BACKOFF_CHECK_MS = 10_000;
/** How often the state is written for the administration pages while it stays the same */
const WRITE_EVERY_MS = 60_000;

const SEVERITY = { calm: 0, hold: 1, [BackoffLevel.Normal]: 0, [BackoffLevel.Reduced]: 2, [BackoffLevel.Paused]: 3 };

/**
 * Makes the jobs that send photos to machine learning give way when its memory runs short: one at a time, then not
 * at all, and back step by step once the memory is free again (see `nextBackoff`). Each worker of microservices
 * does so for itself; searches, which the API sends, are not held back.
 */
@Injectable()
export class MachineLearningBackoffService extends BaseService {
  private interval?: ReturnType<typeof setInterval>;
  private state: BackoffState = { level: BackoffLevel.Normal, calm: 0 };
  private written = 0;

  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Microservices] })
  onBootstrap() {
    this.interval = setInterval(() => handlePromiseError(this.check(), this.logger), BACKOFF_CHECK_MS);
    this.interval.unref?.();
  }

  @OnEvent({ name: 'AppShutdown', workers: [ImmichWorker.Microservices] })
  onShutdown() {
    clearInterval(this.interval);
  }

  async check() {
    const config = await this.getConfig({ withCache: true });
    if (!isMachineLearningEnabled(config.machineLearning)) {
      return;
    }

    const samples = await Promise.all(
      config.machineLearning.urls.map((url) => this.machineLearningRepository.getResources(url)),
    );
    // the service that is shortest of memory decides, as jobs may go to any of them
    const sample =
      samples
        .filter((sample): sample is ResourceSample => !!sample)
        .toSorted((a, b) => SEVERITY[assessSample(b)] - SEVERITY[assessSample(a)])[0] ?? null;

    const previous = this.state.level;
    this.state = nextBackoff(this.state, sample);
    if (this.state.level !== previous || this.state.level !== BackoffLevel.Normal) {
      await this.apply(this.state.level, config);
    }
    if (this.state.level !== previous) {
      this.logger.warn(`Jobs of machine learning: ${previous} -> ${this.state.level} (${describe(sample)})`);
    }
    if (this.state.level === previous && !(Date.now() - this.written > WRITE_EVERY_MS)) {
      return;
    }

    this.written = Date.now();
    await this.systemMetadataRepository.set(SystemMetadataKey.MachineLearningBackoff, {
      level: this.state.level,
      checkedAt: new Date().toISOString(),
      memory: sample?.memory ?? null,
      pressure: sample?.pressure ?? null,
    });
  }

  private async apply(level: BackoffLevel, config: SystemConfig) {
    // a worker takes one more job when it waited for one as it was paused: that job waits here
    if (level === BackoffLevel.Paused) {
      this.machineLearningRepository.hold();
    } else {
      this.machineLearningRepository.release();
    }
    for (const queue of BACKOFF_QUEUES) {
      if (level === BackoffLevel.Paused) {
        await this.jobRepository.pauseWorker(queue);
        continue;
      }
      this.jobRepository.resumeWorker(queue);
      this.jobRepository.setConcurrency(queue, level === BackoffLevel.Reduced ? 1 : config.job[queue].concurrency);
    }
  }
}

const describe = (sample: ResourceSample | null) => {
  if (!sample) {
    return 'no answer';
  }
  const memory = sample.memory ? `${Math.round((sample.memory.used / sample.memory.limit) * 100)}% of memory` : '';
  const pressure = sample.pressure ? `pressure ${sample.pressure.some}%/${sample.pressure.full}%` : '';
  return [memory, pressure].filter(Boolean).join(', ');
};
