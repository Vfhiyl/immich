import { Injectable } from '@nestjs/common';
import { chunk } from 'lodash-es';
import { serverVersion } from 'src/constants.js';
import { JobFailureRetryDto, JobFailureRetryResponseDto, JobFailuresResponseDto } from 'src/dtos/job-failure.dto.js';
import { JOB_FAILURE_ATTEMPTS } from 'src/repositories/job-failure.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { JobItem } from 'src/types.js';

/** How many of the files a job is held back from are listed */
const LISTED_ASSETS = 50;

const RETRY_BATCH = 1000;

/** The files that jobs failed on again and again, for an admin to look at and retry */
@Injectable()
export class JobFailureService extends BaseService {
  async getFailures(): Promise<JobFailuresResponseDto> {
    const version = serverVersion.toString();
    const counts = await this.jobFailureRepository.getCounts(version);
    const jobs = [];
    for (const { jobName, count } of counts) {
      const assets = await this.jobFailureRepository.getHeldBackAssets(jobName, version, LISTED_ASSETS);
      jobs.push({
        jobName,
        count,
        assets: assets.map(({ failedAt, ...asset }) => ({ ...asset, failedAt: failedAt.toISOString() })),
      });
    }
    return { attempts: JOB_FAILURE_ATTEMPTS, jobs };
  }

  /** Queues the job again for the files it was held back from, as after the cause was fixed */
  async retry({ jobName }: JobFailureRetryDto): Promise<JobFailureRetryResponseDto> {
    const assetIds = await this.jobFailureRepository.release(jobName, serverVersion.toString());
    for (const ids of chunk(assetIds, RETRY_BATCH)) {
      await this.jobRepository.queueAll(ids.map((id) => ({ name: jobName, data: { id } }) as JobItem));
    }
    this.logger.log(`Queued ${jobName} again for ${assetIds.length} files it failed on`);
    return { count: assetIds.length };
  }
}
