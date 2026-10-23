import { createZodDto } from 'nestjs-zod';
import z from 'zod';

const StorageExportStateSchema = z
  .object({
    status: z.enum(['running', 'done', 'failed', 'cancelled']).meta({ id: 'StorageExportStatus' }),
    userIds: z.array(z.uuid()).nullable().describe('The users whose originals are exported; null for every user'),
    startedAt: z.string(),
    finishedAt: z.string().nullable(),
    total: z.int().nonnegative().describe('Originals to export, counted when the export started'),
    exported: z.int().nonnegative().describe('Originals exported'),
    skipped: z.int().nonnegative().describe('Originals already exported before, and unchanged'),
    failed: z.int().nonnegative().describe('Originals that could not be exported'),
    lastError: z.string().nullable(),
  })
  .meta({ id: 'StorageExportStateDto' });

const StorageExportResponseSchema = z
  .object({
    location: z.string().nullable().describe('Where exports go (IMMICH_EXPORT_LOCATION); null when not set'),
    usesStorageTemplate: z.boolean().describe('Whether files are named by the storage template'),
    state: StorageExportStateSchema.nullable().describe('The current or last export'),
  })
  .meta({ id: 'StorageExportResponseDto' });

const StorageExportStartSchema = z
  .object({
    userIds: z.array(z.uuid()).optional().describe('Only export the originals of these users; all by default'),
  })
  .meta({ id: 'StorageExportStartDto' });

export class StorageExportResponseDto extends createZodDto(StorageExportResponseSchema) {}
export class StorageExportStartDto extends createZodDto(StorageExportStartSchema) {}
export type StorageExportStateDto = z.infer<typeof StorageExportStateSchema>;
