import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { JobFailureCategory } from 'src/utils/job-history.js';

const JobFailureCategorySchema = z
  .enum(JobFailureCategory)
  .describe(
    "What kind of failure: the file's, a program stopped as it made no progress, killed as memory ran out, or the environment's (the machine learning service, the disk, a storage service)",
  )
  .meta({ id: 'JobFailureCategory' });

const JobHistoryQuerySchema = z
  .object({ since: z.iso.datetime().optional().describe('From when (ISO 8601); all that is kept without') })
  .meta({ id: 'JobHistoryQueryDto' });

const JobRunsSchema = z.object({
  succeeded: z.int().describe('Succeeded, or had nothing to do'),
  failed: z.int(),
  retried: z.int().describe('Put back for later as their environment failed (not failed)'),
});

const JobHistoryResponseSchema = z
  .object({
    unit: z.enum(['hour', 'day', 'month']).describe('Of the series: UTC hours, days or months'),
    totals: JobRunsSchema,
    jobs: z.array(
      JobRunsSchema.extend({ jobName: z.string(), queueName: z.string() }).meta({ id: 'JobHistoryJobDto' }),
    ),
    series: z.array(JobRunsSchema.extend({ start: z.string() }).meta({ id: 'JobHistoryBucketDto' })),
    reasons: z
      .array(
        z
          .object({
            jobName: z.string(),
            category: JobFailureCategorySchema,
            reason: z.string().describe('The error, ids, paths and numbers left out'),
            count: z.int(),
            lastAt: z.string(),
          })
          .meta({ id: 'JobFailureReasonDto' }),
      )
      .describe('Why jobs failed, the most frequent first, at most 50'),
    alerts: z
      .array(
        z
          .object({
            jobName: z.string(),
            runs: z.int().describe('In the last 24 hours'),
            failed: z.int(),
            usualRate: z
              .number()
              .meta({ format: 'double' })
              .nullable()
              .describe('The share that failed in the 30 days before; null without runs'),
          })
          .meta({ id: 'JobHistoryAlertDto' }),
      )
      .describe('Jobs that failed far more often than usual in the last 24 hours'),
  })
  .meta({ id: 'JobHistoryResponseDto' });

const JobFailureListQuerySchema = z
  .object({
    since: z.iso.datetime().optional(),
    jobName: z.string().optional(),
    category: JobFailureCategorySchema.optional(),
    reason: z.string().optional(),
    page: z.coerce.number().int().positive().default(1).optional(),
    size: z.coerce.number().int().positive().max(200).default(50).optional(),
  })
  .meta({ id: 'JobFailureListQueryDto' });

const JobFailureListResponseSchema = z
  .object({
    total: z.int(),
    items: z.array(
      z
        .object({
          id: z.string(),
          createdAt: z.string(),
          jobName: z.string(),
          category: JobFailureCategorySchema,
          reason: z.string(),
          error: z.string(),
          assetId: z.string().nullable(),
          originalFileName: z.string().nullable().describe('Of the asset, if the job was for one that is still there'),
        })
        .meta({ id: 'JobFailureLogDto' }),
    ),
  })
  .meta({ id: 'JobFailureListResponseDto' });

export class JobHistoryQueryDto extends createZodDto(JobHistoryQuerySchema) {}
export class JobHistoryResponseDto extends createZodDto(JobHistoryResponseSchema) {}
export class JobFailureListQueryDto extends createZodDto(JobFailureListQuerySchema) {}
export class JobFailureListResponseDto extends createZodDto(JobFailureListResponseSchema) {}
