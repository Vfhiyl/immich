import { isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import { writeNewMasterKey } from 'src/repositories/key-provider.js';

/**
 * The `immich-encryption` command: master keys and encrypted files, with nothing but the files themselves. It needs no
 * database, no Redis and no running Immich, so that keys can be made before the first start and files recovered after
 * a disaster.
 */
export interface ToolOutput {
  log: (message: string) => void;
  error: (message: string) => void;
}

export const ENCRYPTION_TOOL_USAGE = `Usage: immich-encryption <command>

Commands:
  generate-key <file>           Create a master key file for encrypted storage backends
  generate-key --rotate <file>  Add a new key to a master key file; it encrypts new files, the older keys stay for
                                the files they encrypted`;

const generateKey = async (args: string[], output: ToolOutput) => {
  const { values, positionals } = parseArgs({ args, options: { rotate: { type: 'boolean' } }, allowPositionals: true });
  const [path] = positionals;
  if (positionals.length !== 1 || !isAbsolute(path)) {
    output.error('generate-key needs the absolute path of the master key file');
    return 2;
  }

  const rotate = values.rotate ?? false;
  let id: string;
  try {
    ({ id } = await writeNewMasterKey(path, { rotate }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST' && !rotate) {
      output.error(`${path} already exists; replacing it would lose its keys. Use --rotate to add a new key to it.`);
      return 1;
    }
    throw error;
  }
  output.log(`${rotate ? 'Added' : 'Wrote'} master key ${id} to ${path}`);
  output.log(
    rotate
      ? 'New files are encrypted with it once Immich restarts. Keep the older keys: the files they encrypted need them.'
      : 'Set encryption.masterKeyFile to this path in the storage backend configuration.',
  );
  output.log(
    'Keep a copy of this file apart from the storage and the database: encrypted files cannot be read without it.',
  );
  return 0;
};

/** Run the tool with its arguments, resolving with the exit code */
export const runEncryptionTool = async (args: string[], output: ToolOutput): Promise<number> => {
  const [command, ...rest] = args;
  try {
    switch (command) {
      case 'generate-key': {
        return await generateKey(rest, output);
      }

      default: {
        output.error(ENCRYPTION_TOOL_USAGE);
        return 2;
      }
    }
  } catch (error) {
    output.error(`${command} failed: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
};
