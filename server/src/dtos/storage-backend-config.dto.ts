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

export const StorageBackendConfigSchema = z.discriminatedUnion('driver', [LocalBackendSchema]);

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
