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
    /** Whether new files are encrypted; files keep how they were written, whatever this says later */
    encrypted: z.boolean().default(false),
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
    /**
     * Credentials that may delete objects, used only by the cleanup of deleted files; `credentials` then need no delete
     * permission, so that nothing else can delete objects
     */
    deletionCredentials: S3CredentialsSchema.optional(),
    /** Whether new files are encrypted, by default yes, since the files leave the server */
    encrypted: z.boolean().default(true),
  })
  .strict();

export const StorageBackendConfigSchema = z.discriminatedUnion('driver', [LocalBackendSchema, S3BackendSchema]);

const EncryptionConfigSchema = z
  .object({
    /** Base64 encoded 256-bit master keys, one per line; the first one encrypts new files */
    masterKeyFile: absolutePath,
  })
  .strict();

/** The shortest delay: deleted originals must outlive the database backups that still record them */
export const MIN_DELETION_DELAY_DAYS = 30;

const DeletionConfigSchema = z
  .object({
    /**
     * How long deleted originals stay on their backend before they are deleted, so that they can be recovered. A longer
     * delay applies to originals deleted before too; a shorter one only to originals deleted after the change.
     */
    delayDays: z.int().min(MIN_DELETION_DELAY_DAYS).default(360),
  })
  .strict();

const DatabaseBackupsConfigSchema = z
  .object({
    /**
     * How many database backups the backend for backups keeps: a backup is deleted once this many newer ones exist. A
     * larger number applies to backups taken before too; a smaller one only to backups taken after the change.
     */
    keepLast: z.int().min(1).default(14),
  })
  .strict();

export const StorageBackendsConfigSchema = z
  .object({
    backends: z.array(StorageBackendConfigSchema),
    encryption: EncryptionConfigSchema.optional(),
    deletion: DeletionConfigSchema.default({ delayDays: 360 }),
    databaseBackups: DatabaseBackupsConfigSchema.default({ keepLast: 14 }),
  })
  .strict()
  .superRefine(({ backends, encryption }, context) => {
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

      // backups are read when nothing but the backend and the master key are left, so they are always encrypted
      if (backend.role === StorageBackendRole.Backup && !backend.encrypted) {
        context.addIssue({
          code: 'custom',
          path: ['backends', index, 'encrypted'],
          message: 'The storage backend for backups must be encrypted',
        });
      }

      if (backend.encrypted && !encryption) {
        context.addIssue({
          code: 'custom',
          path: ['backends', index, 'encrypted'],
          message: 'An encrypted storage backend needs a master key file (encryption.masterKeyFile)',
        });
      }
    }
  });

export type StorageBackendConfig = z.infer<typeof StorageBackendConfigSchema>;
export type StorageBackendsConfig = z.infer<typeof StorageBackendsConfigSchema>;
