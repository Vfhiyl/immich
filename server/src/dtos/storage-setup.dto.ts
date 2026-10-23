import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { StorageBackendRoleSchema } from 'src/dtos/storage-backend.dto.js';
import { StorageSetupProblemKind } from 'src/enum.js';

const StorageSetupProblemSchema = z.object({
  kind: z
    .enum(StorageSetupProblemKind)
    .describe('What is wrong, each with what to do about it')
    .meta({ id: 'StorageSetupProblemKind' }),
  path: z.string().optional().describe('The file it is about, inside the container'),
  backendId: z.string().optional().describe('The storage backend it is about'),
  keyId: z.string().optional().describe('The master key it is about'),
  message: z.string().describe('What went wrong, as the server saw it'),
});

const StorageSetupResponseSchema = z
  .object({
    configFile: z
      .string()
      .nullable()
      .describe(
        'The storage configuration file (IMMICH_STORAGE_BACKENDS), null if files are kept in the media location',
      ),
    masterKeyFile: z.string().nullable().describe('The master key file of the configuration'),
    masterKeyCommand: z.string().nullable().describe('The program of the master key command of the configuration'),
    masterKeyId: z.string().nullable().describe('The current master key, when the keys could be read'),
    backends: z.array(
      z.object({
        id: z.string(),
        role: StorageBackendRoleSchema,
        driver: z.string(),
        encrypted: z.boolean(),
        ok: z.boolean().describe('Whether the backend passed its check'),
      }),
    ),
    problems: z.array(StorageSetupProblemSchema),
    hasOriginals: z.boolean().describe('Whether the backend for originals holds files already'),
    databaseBackups: z
      .array(
        z.object({
          key: z.string(),
          filename: z.string(),
          size: z.int(),
          createdAt: z.string(),
        }),
      )
      .describe('The database backups on the backend for backups, the newest first'),
  })
  .meta({ id: 'StorageSetupResponseDto' });

export class StorageSetupResponseDto extends createZodDto(StorageSetupResponseSchema) {}
