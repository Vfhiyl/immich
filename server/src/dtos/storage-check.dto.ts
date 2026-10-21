import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { StorageCheckKind, StorageCheckStatus, StorageIssueKind } from 'src/enum.js';

const StorageCheckKindSchema = z
  .enum(StorageCheckKind)
  .describe('Kind of storage check')
  .meta({ id: 'StorageCheckKind' });
const StorageIssueKindSchema = z
  .enum(StorageIssueKind)
  .describe('Kind of problem with a stored file')
  .meta({ id: 'StorageIssueKind' });

const StorageCheckRunSchema = z
  .object({
    id: z.uuid(),
    kind: StorageCheckKindSchema,
    status: z.enum(StorageCheckStatus).describe('Outcome of the run').meta({ id: 'StorageCheckStatus' }),
    startedAt: z.string(),
    finishedAt: z.string().nullable(),
    backends: z.array(z.string()).describe('Storage backends the run checked'),
    checked: z.int().nonnegative().describe('Objects listed, or files read back'),
    bytes: z.int().nonnegative().describe('Bytes listed, or read back'),
    newIssues: z.int().nonnegative().describe('Problems the run reported'),
    openIssues: z.int().nonnegative().describe('Problems open after the run'),
    stoppedBecause: z.string().optional().describe('Why the run did not cover everything'),
  })
  .meta({ id: 'StorageCheckRunDto' });

const StorageCheckRunsQuerySchema = z
  .object({
    kind: StorageCheckKindSchema.optional(),
    before: z.iso.datetime({ offset: true }).optional().describe('Runs started before this time'),
    limit: z.coerce.number().int().positive().max(500).default(50).optional(),
  })
  .meta({ id: 'StorageCheckRunsQueryDto' });

const StorageIssueSchema = z
  .object({
    id: z.uuid(),
    backendId: z.string(),
    key: z.string(),
    kind: StorageIssueKindSchema,
    detail: z.string().nullable(),
    firstSeenAt: z.string(),
    lastSeenAt: z.string(),
    confirmedAt: z.string(),
    resolvedAt: z.string().nullable(),
    acknowledgedAt: z.string().nullable(),
  })
  .meta({ id: 'StorageIssueDto' });

const StorageIssuesQuerySchema = z
  .object({
    status: z.enum(['open', 'resolved', 'all']).default('open').optional(),
    kind: StorageIssueKindSchema.optional(),
    backendId: z.string().optional(),
    cursor: z.string().optional().describe('Cursor for pagination'),
    limit: z.coerce.number().int().positive().max(1000).default(100).optional(),
  })
  .meta({ id: 'StorageIssuesQueryDto' });

const StorageIssuesResponseSchema = z
  .object({ items: z.array(StorageIssueSchema), nextCursor: z.string().optional() })
  .meta({ id: 'StorageIssuesResponseDto' });

const MonthlySummarySchema = z.object({
  month: z.string().describe('As YYYY-MM'),
  runs: z.int().nonnegative(),
  runsWithProblems: z.int().nonnegative(),
  bytesVerified: z.int().nonnegative(),
  issuesReported: z.int().nonnegative(),
  issuesResolved: z.int().nonnegative(),
});

const StorageCheckSummarySchema = z
  .object({
    openIssues: z.record(z.string(), z.int().nonnegative()).describe('Open problems by kind'),
    lastReconcile: StorageCheckRunSchema.nullable(),
    lastVerify: StorageCheckRunSchema.nullable(),
    months: z.array(MonthlySummarySchema).describe('The last 12 months, the oldest first'),
  })
  .meta({ id: 'StorageCheckSummaryResponseDto' });

const StorageCheckStartSchema = z.object({ kind: StorageCheckKindSchema }).meta({ id: 'StorageCheckStartDto' });

export class StorageCheckRunDto extends createZodDto(StorageCheckRunSchema) {}
export class StorageCheckRunsQueryDto extends createZodDto(StorageCheckRunsQuerySchema) {}
export class StorageIssueDto extends createZodDto(StorageIssueSchema) {}
export class StorageIssuesQueryDto extends createZodDto(StorageIssuesQuerySchema) {}
export class StorageIssuesResponseDto extends createZodDto(StorageIssuesResponseSchema) {}
export class StorageCheckSummaryResponseDto extends createZodDto(StorageCheckSummarySchema) {}
export class StorageCheckStartDto extends createZodDto(StorageCheckStartSchema) {}
