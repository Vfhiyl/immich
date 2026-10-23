import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';

/** Length of master key ids, which identify a key without revealing it */
export const MASTER_KEY_ID_LENGTH = 8;
const MASTER_KEY_LENGTH = 32;
/** A key management service may take a while to answer, but Immich should not hang at startup */
const KEY_COMMAND_TIMEOUT_MS = 60 * 1000;

/**
 * Master keys that wrap the keys of encrypted files. The current key wraps new file keys; older keys stay available
 * to read files written before a key change.
 */
export interface KeyProvider {
  readonly currentKeyId: Buffer;
  getKey(id: Buffer): Buffer;
  hasKey(id: Buffer): boolean;
  /** The keys as a key file holds them, to keep a copy of */
  toKeyFile(): string;
  /** Where the keys come from: a key file, or a command (e.g. of a key management service) */
  readonly source?: MasterKeySource;
}

export type MasterKeySource = 'file' | 'command';

const KEY_FILE_HEADER =
  '# Immich master keys: the first one encrypts new files, the others are needed to read older ones.\n' +
  '# Keep a copy apart from the storage and the database; without it, encrypted files cannot be read.\n';

export const getMasterKeyId = (key: Buffer) =>
  createHash('sha256').update('immich master key id').update(key).digest().subarray(0, MASTER_KEY_ID_LENGTH);

/** A new master key, as the line to put in a key file */
export const generateMasterKey = () => randomBytes(MASTER_KEY_LENGTH).toString('base64');

/** Master keys, the first being the current one */
export class MasterKeys implements KeyProvider {
  readonly currentKeyId: Buffer;
  private keys = new Map<string, Buffer>();

  /**
   * Master keys from a file: one base64 key per line, the first being the current one, and lines starting with `#`
   * ignored. Losing the file means losing every encrypted file, so it must be kept (and backed up) apart from the
   * storage and the database.
   */
  static fromFile(path: string) {
    return MasterKeys.fromText(readFileSync(path, 'utf8'), `The master key file ${path}`, 'file');
  }

  /**
   * Master keys from what a command prints, as a key file holds them: e.g. a key file decrypted by the command line tool
   * of a key management service. The command runs without a shell; what it prints is never written anywhere.
   */
  static fromCommand([program, ...args]: string[]) {
    let output: string;
    try {
      output = execFileSync(program, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: KEY_COMMAND_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      const { stderr, status } = error as { stderr?: string; status?: number | null };
      const detail = stderr?.trim() || (error instanceof Error ? error.message : String(error));
      throw new Error(`The master key command ${program} failed${status ? ` (exit code ${status})` : ''}: ${detail}`, {
        cause: error,
      });
    }
    return MasterKeys.fromText(output, `The output of the master key command ${program}`, 'command');
  }

  private static fromText(text: string, description: string, source: MasterKeySource) {
    const lines = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    if (lines.length === 0) {
      throw new Error(`${description} holds no key`);
    }

    return new MasterKeys(
      lines.map((line) => {
        const key = Buffer.from(line, 'base64');
        if (key.length !== MASTER_KEY_LENGTH || key.toString('base64') !== line) {
          throw new Error(`${description} holds a line that is not a base64 encoded 256-bit key`);
        }
        return key;
      }),
      source,
    );
  }

  constructor(
    keys: Buffer[],
    readonly source?: MasterKeySource,
  ) {
    if (keys.length === 0 || keys.some((key) => key.length !== MASTER_KEY_LENGTH)) {
      throw new Error('Master keys must be 256-bit keys, and there must be at least one');
    }

    for (const key of keys) {
      this.keys.set(getMasterKeyId(key).toString('hex'), key);
    }
    this.currentKeyId = getMasterKeyId(keys[0]);
  }

  hasKey(id: Buffer): boolean {
    return this.keys.has(id.toString('hex'));
  }

  toKeyFile(): string {
    // the current key first, as it was read
    return `${KEY_FILE_HEADER}${this.keys
      .values()
      .map((key) => key.toString('base64'))
      .toArray()
      .join('\n')}\n`;
  }

  getKey(id: Buffer): Buffer {
    const key = this.keys.get(id.toString('hex'));
    if (!key) {
      throw new Error(`Master key ${id.toString('hex')} is not available`);
    }
    return key;
  }
}

/**
 * Write a new master key to a key file, only readable by its owner. A new file gets the key; with `rotate`, an existing
 * file gets it as its first line, so that it encrypts new files, and keeps the keys that older files need. An existing
 * file is never replaced otherwise, since that would make every file encrypted with it unreadable.
 */
export const writeNewMasterKey = async (path: string, { rotate = false } = {}) => {
  const key = generateMasterKey();
  const id = getMasterKeyId(Buffer.from(key, 'base64')).toString('hex');
  const header = KEY_FILE_HEADER;

  if (!rotate) {
    await writeFile(path, `${header}${key}\n`, { flag: 'wx', mode: 0o600 });
    return { id };
  }

  const existing = await readFile(path, 'utf8');
  const keys = existing
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  // validates what is kept, so that a damaged file is not rotated into another damaged file
  MasterKeys.fromFile(path);

  const temporary = `${path}.new`;
  await writeFile(temporary, `${header}${[key, ...keys].join('\n')}\n`, { flag: 'wx', mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  return { id };
};
