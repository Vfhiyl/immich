import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { REPLICATED_ROLES } from 'src/dtos/storage-backend-config.dto.js';
import { StorageBackendDriver, StorageBackendRole } from 'src/enum.js';

export const StorageBackendRoleSchema = z
  .enum(StorageBackendRole)
  .describe('What a storage backend holds')
  .meta({ id: 'StorageBackendRole' });
export const ReplicatedRoleSchema = z
  .enum(REPLICATED_ROLES)
  .describe('A role whose backends replicas can copy')
  .meta({ id: 'StorageReplicatedRole' });

const StorageBackendSchema = z.object({
  id: z.string().describe('Id of the storage backend'),
  role: StorageBackendRoleSchema,
  driver: z.enum(StorageBackendDriver).describe('How files are stored').meta({ id: 'StorageBackendDriver' }),
  encrypted: z.boolean().describe('Whether new files are encrypted'),
  replicaOf: z.array(ReplicatedRoleSchema).nullable().describe('For a replica, the roles whose backends it copies'),
  location: z.string().describe('Where files are: the endpoint, bucket and prefix, or the folder'),
  hasDeletionCredentials: z.boolean().describe('Whether only separate credentials may delete files'),
});

const StorageConfigurationResponseSchema = z
  .object({
    backends: z.array(StorageBackendSchema),
    masterKeyId: z.string().nullable().describe('Id of the master key that encrypts new files'),
    deletionDelayDays: z.int().describe('How long deleted originals are kept before they are deleted'),
    databaseBackupsKeepLast: z.int().describe('How many database backups the backend for backups keeps'),
    syncDeleteRetentionDays: z.int().nullable().describe('How long records of deletions are kept, null for forever'),
  })
  .meta({ id: 'StorageConfigurationResponseDto' });

export class StorageConfigurationResponseDto extends createZodDto(StorageConfigurationResponseSchema) {}
