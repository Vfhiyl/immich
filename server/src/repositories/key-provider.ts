import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** Length of master key ids, which identify a key without revealing it */
export const MASTER_KEY_ID_LENGTH = 8;
const MASTER_KEY_LENGTH = 32;

/**
 * Master keys that wrap the keys of encrypted files. The current key wraps new file keys; older keys stay available
 * to read files written before a key change.
 */
export interface KeyProvider {
  readonly currentKeyId: Buffer;
  getKey(id: Buffer): Buffer;
}

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
    const lines = readFileSync(path, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    if (lines.length === 0) {
      throw new Error(`The master key file ${path} holds no key`);
    }

    return new MasterKeys(
      lines.map((line) => {
        const key = Buffer.from(line, 'base64');
        if (key.length !== MASTER_KEY_LENGTH || key.toString('base64') !== line) {
          throw new Error(`The master key file ${path} holds a line that is not a base64 encoded 256-bit key`);
        }
        return key;
      }),
    );
  }

  constructor(keys: Buffer[]) {
    if (keys.length === 0 || keys.some((key) => key.length !== MASTER_KEY_LENGTH)) {
      throw new Error('Master keys must be 256-bit keys, and there must be at least one');
    }

    for (const key of keys) {
      this.keys.set(getMasterKeyId(key).toString('hex'), key);
    }
    this.currentKeyId = getMasterKeyId(keys[0]);
  }

  getKey(id: Buffer): Buffer {
    const key = this.keys.get(id.toString('hex'));
    if (!key) {
      throw new Error(`Master key ${id.toString('hex')} is not available`);
    }
    return key;
  }
}
