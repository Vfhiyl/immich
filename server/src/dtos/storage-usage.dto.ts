import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { StorageUsageCategory } from 'src/enum.js';

const StorageUsageQuerySchema = z
  .object({
    from: z.iso.date().optional().describe('First UTC day (YYYY-MM-DD), by default 29 days before the last'),
    to: z.iso.date().optional().describe('Last UTC day (YYYY-MM-DD), by default today'),
  })
  .meta({ id: 'StorageUsageQueryDto' });

const amount = z.number().nonnegative().meta({ format: 'double' });

const StorageCostSchema = z
  .object({
    currency: z.string().describe('Currency of the prices'),
    storage: amount.describe('Estimated cost of storing'),
    requests: amount.describe('Estimated cost of the requests'),
    egress: amount.describe('Estimated cost of reading from the service'),
    total: amount.describe('Estimated cost in all'),
  })
  .describe('Estimated by the prices in the settings; null without prices for the backend')
  .meta({ id: 'StorageCostDto' });

const StorageRequestCountsSchema = z
  .object({
    write: z.int().nonnegative().describe('Write and list requests (PUT, POST, LIST)'),
    read: z.int().nonnegative().describe('Read requests (GET, HEAD)'),
    delete: z.int().nonnegative().describe('Delete requests'),
  })
  .meta({ id: 'StorageRequestCountsDto' });

const StoredAmountSchema = z
  .object({ objects: z.int().nonnegative(), bytes: z.int().nonnegative() })
  .meta({ id: 'StorageStoredAmountDto' });

const StorageDailyUsageSchema = z
  .object({
    day: z.string().describe('UTC day (YYYY-MM-DD)'),
    storedObjects: z.int().nonnegative().describe('Objects stored, as recorded that night; 0 if not recorded'),
    storedBytes: z.int().nonnegative().describe('Bytes stored, estimated from the records of the files'),
    stored: z.partialRecord(z.enum(StorageUsageCategory), StoredAmountSchema).describe('What is stored, by category'),
    requests: StorageRequestCountsSchema,
    bytesSent: z.int().nonnegative().describe('Bytes sent to the service'),
    bytesReceived: z.int().nonnegative().describe('Bytes read from the service'),
    cost: StorageCostSchema.nullable(),
  })
  .meta({ id: 'StorageDailyUsageDto' });

const StoragePurposeUsageSchema = z
  .object({
    purpose: z.string().describe('The job that made the requests, or api for requests of users'),
    requests: StorageRequestCountsSchema,
    bytesSent: z.int().nonnegative(),
    bytesReceived: z.int().nonnegative(),
    cost: StorageCostSchema.nullable(),
  })
  .meta({ id: 'StoragePurposeUsageDto' });

const StorageBudgetSchema = z
  .object({
    month: z.string().describe('The current calendar month (UTC), as YYYY-MM'),
    currency: z.string(),
    amount: z.number().nonnegative().meta({ format: 'double' }).describe('The budget for the month'),
    monthToDate: z.number().nonnegative().meta({ format: 'double' }).describe('Estimated cost of the month so far'),
    projected: z
      .number()
      .nonnegative()
      .meta({ format: 'double' })
      .describe('Estimated cost of the whole month, at the pace so far'),
  })
  .meta({ id: 'StorageBudgetDto' });

const StorageBackendUsageSchema = z
  .object({
    backendId: z.string(),
    days: z.array(StorageDailyUsageSchema),
    purposes: z.array(StoragePurposeUsageSchema).describe('Requests over the whole range, by what made them'),
    cost: StorageCostSchema.nullable(),
    budget: StorageBudgetSchema.nullable().describe('The budget of the backend for this month; null without one'),
  })
  .meta({ id: 'StorageBackendUsageDto' });

const StorageUsageResponseSchema = z
  .object({
    from: z.string(),
    to: z.string(),
    backends: z.array(StorageBackendUsageSchema),
  })
  .meta({ id: 'StorageUsageResponseDto' });

export class StorageUsageQueryDto extends createZodDto(StorageUsageQuerySchema) {}
export class StorageUsageResponseDto extends createZodDto(StorageUsageResponseSchema) {}
export type StorageCostDto = z.infer<typeof StorageCostSchema>;
export type StorageBackendUsageDto = z.infer<typeof StorageBackendUsageSchema>;
export type StorageBudgetDto = z.infer<typeof StorageBudgetSchema>;
