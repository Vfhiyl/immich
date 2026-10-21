import { createZodDto } from 'nestjs-zod';
import z from 'zod';

const StoredDatabaseBackupSchema = z.object({
  key: z.uuid().describe('Key of the backup on the storage backend for backups'),
  filename: z.string().describe('File name of the backup'),
  size: z.int().nonnegative().describe('Size of the backup in bytes'),
  createdAt: z.string().describe('When the backup was stored'),
});

const StoredDatabaseBackupListResponseSchema = z
  .object({ backups: z.array(StoredDatabaseBackupSchema) })
  .meta({ id: 'StoredDatabaseBackupListResponseDto' });

const StoredDatabaseBackupFetchResponseSchema = z
  .object({ filename: z.string().describe('File name of the backup in the backups folder, ready to restore') })
  .meta({ id: 'StoredDatabaseBackupFetchResponseDto' });

const StoredDatabaseBackupKeyParamSchema = z.object({ key: z.uuid().describe('Key of the stored backup') });

export class StoredDatabaseBackupListResponseDto extends createZodDto(StoredDatabaseBackupListResponseSchema) {}
export class StoredDatabaseBackupFetchResponseDto extends createZodDto(StoredDatabaseBackupFetchResponseSchema) {}
export class StoredDatabaseBackupKeyParamDto extends createZodDto(StoredDatabaseBackupKeyParamSchema) {}
