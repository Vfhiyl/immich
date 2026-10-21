import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { REPLICATED_ROLES } from 'src/dtos/storage-backend-config.dto.js';

const StorageReplicaSchema = z.object({
  id: z.string().describe('Id of the storage backend of the replica'),
  replicaOf: z.array(z.enum(REPLICATED_ROLES)).describe('Roles whose backends the replica copies'),
  sourceFiles: z.int().nonnegative().describe('Originals on the backends the replica copies'),
  copied: z.int().nonnegative().describe('Files copied to the replica'),
  copiedBytes: z.int().nonnegative().describe('Bytes copied to the replica'),
  pending: z.int().nonnegative().describe('Files waiting to be copied'),
  failing: z.int().nonnegative().describe('Files whose copy failed several times, which are tried again later'),
  oldestPendingAt: z
    .string()
    .nullable()
    .describe('Since when the file waiting longest to be copied waits: what losing the backend now would lose'),
});

const StorageReplicaListResponseSchema = z
  .object({
    replicas: z.array(StorageReplicaSchema),
    lastReconcileAt: z.string().nullable().describe('When the replicas were last reconciled'),
  })
  .meta({ id: 'StorageReplicaListResponseDto' });

const StorageReplicaFailingSchema = z.object({
  backendId: z.string().describe('Storage backend of the file'),
  key: z.string().describe('Key of the file'),
  attempts: z.int().nonnegative().describe('Attempts so far'),
  lastError: z.string().nullable().describe('Why the last attempt failed'),
  nextAttemptAt: z.string().describe('When it is tried again'),
  registeredAt: z.string().describe('When the copy was registered'),
});

const StorageReplicaFailingResponseSchema = z
  .object({ items: z.array(StorageReplicaFailingSchema) })
  .meta({ id: 'StorageReplicaFailingResponseDto' });

const StorageReplicaRetryResponseSchema = z
  .object({ count: z.int().nonnegative().describe('Copies that are tried again now') })
  .meta({ id: 'StorageReplicaRetryResponseDto' });

const StorageReplicaParamSchema = z.object({ id: z.string().describe('Id of the storage backend of the replica') });

export class StorageReplicaListResponseDto extends createZodDto(StorageReplicaListResponseSchema) {}
export class StorageReplicaFailingResponseDto extends createZodDto(StorageReplicaFailingResponseSchema) {}
export class StorageReplicaRetryResponseDto extends createZodDto(StorageReplicaRetryResponseSchema) {}
export class StorageReplicaParamDto extends createZodDto(StorageReplicaParamSchema) {}
