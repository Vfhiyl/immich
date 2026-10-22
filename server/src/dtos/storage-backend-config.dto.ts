import z from 'zod';
import { BuiltinStorageBackend, StorageBackendDriver, StorageBackendRole } from 'src/enum.js';

const builtinIds = new Set<string>(Object.values(BuiltinStorageBackend));

/** The roles whose backends a replica can copy */
export const REPLICATED_ROLES = [StorageBackendRole.Originals, StorageBackendRole.Backup] as const;
export type ReplicatedRole = (typeof REPLICATED_ROLES)[number];

/** For a backend with the role replica: the roles whose backends it holds copies of */
const ReplicaOfSchema = z.array(z.enum(REPLICATED_ROLES)).min(1).optional();

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
    replicaOf: ReplicaOfSchema,
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
    replicaOf: ReplicaOfSchema,
  })
  .strict();

export const StorageBackendConfigSchema = z.discriminatedUnion('driver', [LocalBackendSchema, S3BackendSchema]);

const EncryptionConfigSchema = z
  .object({
    /** Base64 encoded 256-bit master keys, one per line; the first one encrypts new files */
    masterKeyFile: absolutePath.optional(),
    /**
     * A command that prints what a master key file holds, run when Immich starts: so that the keys can come from a key
     * management service or a secret store (e.g. decrypted with its command line tool) and are never written to disk.
     * The program, by its absolute path, and its arguments; no shell.
     */
    masterKeyCommand: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict()
  .refine(({ masterKeyFile, masterKeyCommand }) => !!masterKeyFile !== !!masterKeyCommand, {
    message: 'Set either encryption.masterKeyFile or encryption.masterKeyCommand',
  })
  .refine(({ masterKeyCommand }) => !masterKeyCommand || masterKeyCommand[0].startsWith('/'), {
    message: 'The program of encryption.masterKeyCommand must be an absolute path',
    path: ['masterKeyCommand', 0],
  });

export type EncryptionConfig = z.infer<typeof EncryptionConfigSchema>;

/** Where the master keys come from, for messages */
export const describeKeySource = ({ masterKeyFile, masterKeyCommand }: EncryptionConfig) =>
  masterKeyFile ?? `the output of ${masterKeyCommand![0]}`;

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

      if (roles.has(backend.role) && backend.role !== StorageBackendRole.Replica) {
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

      if (backend.role === StorageBackendRole.Replica && !backend.replicaOf) {
        context.addIssue({
          code: 'custom',
          path: ['backends', index, 'replicaOf'],
          message: 'A replica needs the roles whose backends it copies (replicaOf)',
        });
      }
      if (backend.role !== StorageBackendRole.Replica && backend.replicaOf) {
        context.addIssue({
          code: 'custom',
          path: ['backends', index, 'replicaOf'],
          message: 'Only a storage backend with the role replica copies other backends',
        });
      }

      if (backend.encrypted && !encryption) {
        context.addIssue({
          code: 'custom',
          path: ['backends', index, 'encrypted'],
          message:
            'An encrypted storage backend needs master keys (encryption.masterKeyFile or encryption.masterKeyCommand)',
        });
      }
    }

    // a replica holds the files exactly as they are stored, so that it can take the place of the backend it copies
    for (const [index, backend] of backends.entries()) {
      for (const role of backend.replicaOf ?? []) {
        const source = backends.find((other) => other.role === role);
        if (!source) {
          context.addIssue({
            code: 'custom',
            path: ['backends', index, 'replicaOf'],
            message: `No storage backend has the role ${role}`,
          });
        } else if (backend.encrypted && !source.encrypted) {
          context.addIssue({
            code: 'custom',
            path: ['backends', index, 'encrypted'],
            message:
              `Replicas hold files as they are stored, and storage backend ${source.id} is not encrypted: ` +
              'encrypt it, or set encrypted: false for this replica',
          });
        }
      }
    }
  });

export type StorageBackendConfig = z.infer<typeof StorageBackendConfigSchema>;
export type StorageBackendsConfig = z.infer<typeof StorageBackendsConfigSchema>;
