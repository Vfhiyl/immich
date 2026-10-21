import z from 'zod';
import { BuiltinStorageBackend, StorageBackendDriver, StorageBackendRole } from 'src/enum.js';

const builtinIds = new Set<string>(Object.values(BuiltinStorageBackend));

/** Ids are recorded with every file, so they must stay the same for as long as files use the backend */
const BackendIdSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,62}$/,
    'Must be 1-63 lowercase letters, digits or dashes, starting with a letter or digit',
  )
  .refine((id) => !builtinIds.has(id), { message: 'Is reserved for a built-in storage backend' });

const LocalBackendSchema = z
  .object({
    id: BackendIdSchema,
    driver: z.literal(StorageBackendDriver.Local),
    role: z.enum(StorageBackendRole),
    /** Directory that holds the files of this backend */
    root: z.string().regex(/^\//, 'Must be an absolute path'),
  })
  .strict();

const absolutePath = z.string().regex(/^\//, 'Must be an absolute path');

/** Secrets are read from files (or the standard credential chain), so that the configuration file holds none */
const S3CredentialsSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('static'),
      accessKeyId: z.string().min(1),
      secretAccessKeyFile: absolutePath,
    })
    .strict(),
  z
    .object({
      // environment, shared config and credentials files (including credential_process), container and instance roles
      type: z.literal('chain'),
      profile: z.string().min(1).optional(),
    })
    .strict(),
]);

/** Any service that speaks the S3 protocol; everything that differs between services is a setting here, not code */
const S3BackendSchema = z
  .object({
    id: BackendIdSchema,
    driver: z.literal(StorageBackendDriver.S3),
    role: z.enum(StorageBackendRole),
    endpoint: z.url({ protocol: /^https?$/ }),
    region: z.string().min(1),
    bucket: z.string().min(1),
    /** Keys are stored below this prefix, so that several backends can share a bucket */
    prefix: z
      .string()
      .regex(/^([^/]+\/)*$/, 'Must be empty or end with a slash, without empty segments')
      .default(''),
    addressing: z.enum(['virtual-host', 'path']).default('virtual-host'),
    credentials: S3CredentialsSchema,
  })
  .strict();

export const StorageBackendConfigSchema = z.discriminatedUnion('driver', [LocalBackendSchema, S3BackendSchema]);

export const StorageBackendsConfigSchema = z
  .object({ backends: z.array(StorageBackendConfigSchema) })
  .strict()
  .superRefine(({ backends }, context) => {
    const ids = new Set<string>();
    const roles = new Set<StorageBackendRole>();
    for (const [index, backend] of backends.entries()) {
      if (ids.has(backend.id)) {
        context.addIssue({ code: 'custom', path: ['backends', index, 'id'], message: `Duplicate id ${backend.id}` });
      }
      ids.add(backend.id);

      if (roles.has(backend.role)) {
        context.addIssue({
          code: 'custom',
          path: ['backends', index, 'role'],
          message: `Only one storage backend can have the role ${backend.role}`,
        });
      }
      roles.add(backend.role);
    }
  });

export type StorageBackendConfig = z.infer<typeof StorageBackendConfigSchema>;
export type StorageBackendsConfig = z.infer<typeof StorageBackendsConfigSchema>;
