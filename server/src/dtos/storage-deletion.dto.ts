import { createZodDto } from 'nestjs-zod';
import z from 'zod';

const StorageDeletionStatusResponseSchema = z
  .object({
    isPaused: z.boolean().describe('Whether deleting files from storage is paused because of an unusual amount'),
    pausedAt: z.string().optional().describe('When deleting was paused'),
    dueOriginals: z.int().nonnegative().optional().describe('Deleted originals that were due when deleting was paused'),
    limit: z.int().nonnegative().optional().describe('How many due originals are deleted without asking'),
    pendingOriginals: z.int().nonnegative().describe('Deleted originals waiting for their deletion delay'),
    pendingFiles: z.int().nonnegative().describe('All files waiting for their deletion delay, originals included'),
    delayDays: z.int().nonnegative().describe('How long deleted originals are kept (from the configuration file)'),
  })
  .meta({ id: 'StorageDeletionStatusResponseDto' });

const StorageDeletionOriginalsQuerySchema = z
  .object({
    ownerId: z.uuid().optional().describe('Only originals of this user'),
    cursor: z.string().optional().describe('Cursor for pagination'),
    limit: z.coerce.number().int().positive().max(1000).default(100).optional().describe('Number of items per page'),
  })
  .meta({ id: 'StorageDeletionOriginalsQueryDto' });

const StorageDeletionOriginalSchema = z.object({
  id: z.uuid().describe('Id of the pending deletion'),
  ownerId: z.uuid().nullable().describe('Who owned the photo'),
  originalFileName: z.string().nullable().describe('Original file name'),
  fileCreatedAt: z.string().nullable().describe('When the photo was taken'),
  size: z.int().nonnegative().nullable().describe('Size in bytes'),
  deletedAt: z.string().describe('When the photo was deleted'),
  deleteAfter: z.string().describe('When the original will be deleted from storage at the earliest'),
});

const StorageDeletionOriginalsResponseSchema = z
  .object({
    items: z.array(StorageDeletionOriginalSchema),
    nextCursor: z.string().optional(),
  })
  .meta({ id: 'StorageDeletionOriginalsResponseDto' });

const StorageDeletionImportSchema = z
  .object({
    userId: z.uuid().optional().describe('Who gets the photo; by default its owner'),
  })
  .meta({ id: 'StorageDeletionImportDto' });

const StorageDeletionPurgeSchema = z
  .object({
    password: z.string().min(1).describe('Password of the administrator, to confirm'),
  })
  .meta({ id: 'StorageDeletionPurgeDto' });

export class StorageDeletionStatusResponseDto extends createZodDto(StorageDeletionStatusResponseSchema) {}
export class StorageDeletionOriginalsQueryDto extends createZodDto(StorageDeletionOriginalsQuerySchema) {}
export class StorageDeletionOriginalsResponseDto extends createZodDto(StorageDeletionOriginalsResponseSchema) {}
export class StorageDeletionImportDto extends createZodDto(StorageDeletionImportSchema) {}
export class StorageDeletionPurgeDto extends createZodDto(StorageDeletionPurgeSchema) {}
