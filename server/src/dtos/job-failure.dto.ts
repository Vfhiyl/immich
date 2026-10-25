import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { TRACKED_JOBS } from 'src/utils/job-failure.js';

const TrackedJobNameSchema = z
  .enum(TRACKED_JOBS)
  .describe('A job for a file: metadata, thumbnails, video, smart search, faces or text recognition')
  .meta({ id: 'TrackedJobName' });

const JobFailureAssetSchema = z
  .object({
    assetId: z.string(),
    originalFileName: z.string(),
    attempts: z.int(),
    error: z.string().nullable().describe('Why the last attempt failed; null when the server stopped while it ran'),
    failedAt: z.string(),
  })
  .meta({ id: 'JobFailureAssetDto' });

const JobFailuresResponseSchema = z
  .object({
    attempts: z.int().describe('Attempts in a row after which a job is no longer queued for a file'),
    jobs: z.array(
      z
        .object({
          jobName: TrackedJobNameSchema,
          count: z.int().describe('The files the job is no longer queued for'),
          assets: z.array(JobFailureAssetSchema).describe('Those that failed last, at most 50'),
        })
        .meta({ id: 'JobFailuresDto' }),
    ),
  })
  .meta({ id: 'JobFailuresResponseDto' });

const JobFailureRetrySchema = z.object({ jobName: TrackedJobNameSchema }).meta({ id: 'JobFailureRetryDto' });

const JobFailureRetryResponseSchema = z
  .object({ count: z.int().describe('The files the job was queued for again') })
  .meta({ id: 'JobFailureRetryResponseDto' });

export class JobFailuresResponseDto extends createZodDto(JobFailuresResponseSchema) {}
export class JobFailureRetryDto extends createZodDto(JobFailureRetrySchema) {}
export class JobFailureRetryResponseDto extends createZodDto(JobFailureRetryResponseSchema) {}
