import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Mocked } from 'vitest';
import { EncryptedBlobStore } from 'src/repositories/encrypted-blob-store.js';
import { MasterKeys, writeNewMasterKey } from 'src/repositories/key-provider.js';
import { LocalBlobStore } from 'src/repositories/local-blob-store.js';
import { ENCRYPTION_TOOL_USAGE, ToolOutput, runEncryptionTool } from 'src/utils/encryption-tool.js';

// the fixed object of the encrypted blob store tests: master key 32 × 0x07
const VECTOR = {
  blob:
    '7AFxHw82EvUbw7zoNU/EEj/0YE12fgm0E5kmR28PZgkDVMv/zWoEnpeMgo03SU1NRU5DMDEBARABAgMEBQYH5TO9IiAhERwLjVcItr+lW96QX0' +
    'EWrhr6E0m1c3yBc+7Zd3D1xrsoLGN0iTk6mbiXTCCyaRaH3VzxZgH1fNl0oBF0pB2uu50hSZP34KrADYFwUEYiL2Qwn8+MI5LsQ3OCKEk8Q2e7T4' +
    'z35SO0RI3/uxCmWYmZKn7rIACFlicdbwUNqRmg/2ARBoF46kxgmTPRFQAAAKM=',
};

describe(runEncryptionTool.name, () => {
  let folder: string;
  let output: Mocked<ToolOutput>;

  const logged = () => output.log.mock.calls.map(([message]) => message).join('\n');

  beforeEach(async () => {
    folder = await fs.mkdtemp(join(tmpdir(), 'immich-encryption-tool-'));
    output = { log: vi.fn(), error: vi.fn() };
  });

  afterEach(async () => {
    await fs.rm(folder, { recursive: true, force: true });
  });

  it('should print the usage for an unknown command', async () => {
    await expect(runEncryptionTool([], output)).resolves.toBe(2);
    await expect(runEncryptionTool(['unknown'], output)).resolves.toBe(2);
    expect(output.error).toHaveBeenCalledWith(ENCRYPTION_TOOL_USAGE);
  });

  describe('generate-key', () => {
    it('should create a master key file and print the id of the key', async () => {
      const path = join(folder, 'master.key');

      await expect(runEncryptionTool(['generate-key', path], output)).resolves.toBe(0);

      const id = MasterKeys.fromFile(path).currentKeyId.toString('hex');
      expect(logged()).toContain(`Wrote master key ${id} to ${path}`);
      expect(logged()).toContain('encryption.masterKeyFile');
    });

    it('should refuse to replace an existing file and point to --rotate', async () => {
      const path = join(folder, 'master.key');
      await runEncryptionTool(['generate-key', path], output);
      const before = await fs.readFile(path, 'utf8');

      await expect(runEncryptionTool(['generate-key', path], output)).resolves.toBe(1);

      expect(output.error).toHaveBeenCalledWith(expect.stringContaining('Use --rotate'));
      await expect(fs.readFile(path, 'utf8')).resolves.toBe(before);
    });

    it('should add a new current key with --rotate, keeping the older one', async () => {
      const path = join(folder, 'master.key');
      await runEncryptionTool(['generate-key', path], output);
      const old = MasterKeys.fromFile(path).currentKeyId;

      await expect(runEncryptionTool(['generate-key', '--rotate', path], output)).resolves.toBe(0);

      const keys = MasterKeys.fromFile(path);
      expect(keys.currentKeyId.equals(old)).toBe(false);
      expect(keys.hasKey(old)).toBe(true);
      expect(logged()).toContain(`Added master key ${keys.currentKeyId.toString('hex')}`);
    });

    it.each([[[]], [['master.key']], [['/a', '/b']]])('should need one absolute path, not %j', async (args) => {
      await expect(runEncryptionTool(['generate-key', ...args], output)).resolves.toBe(2);
      expect(output.error).toHaveBeenCalledWith('generate-key needs the absolute path of the master key file');
    });

    it('should report other failures', async () => {
      await expect(runEncryptionTool(['generate-key', '--rotate', join(folder, 'missing.key')], output)).resolves.toBe(
        1,
      );
      expect(output.error).toHaveBeenCalledWith(expect.stringMatching(/^generate-key failed: ENOENT/));
    });
  });

  describe('inspect and decrypt', () => {
    let keyFile: string;
    let store: EncryptedBlobStore;
    let inner: LocalBlobStore;

    /** An object as it is stored, copied somewhere else under another name, like a copy taken from a bucket */
    const storeObject = async (content: Buffer, manifest?: Record<string, unknown>) => {
      const key = randomUUID();
      await store.put(key, Readable.from([content]), { manifest });
      const copy = join(folder, `copy-of-${key}`);
      await fs.copyFile(join(folder, 'bucket', key), copy);
      return copy;
    };

    beforeEach(async () => {
      keyFile = join(folder, 'master.key');
      await writeNewMasterKey(keyFile);
      inner = new LocalBlobStore(join(folder, 'bucket'));
      store = new EncryptedBlobStore(inner, MasterKeys.fromFile(keyFile));
    });

    it('should show how an object is encrypted without a key', async () => {
      const object = await storeObject(randomBytes(100));

      await expect(runEncryptionTool(['inspect', object], output)).resolves.toBe(0);

      const id = MasterKeys.fromFile(keyFile).currentKeyId.toString('hex');
      expect(logged()).toContain('AES-256-GCM');
      expect(logged()).toContain(`Master key:      ${id}`);
      expect(logged()).toContain('Encrypted data:  116 bytes');
    });

    it.each([0, 1, 64 * 1024, 3 * 64 * 1024 + 7])('should decrypt an object of %i bytes', async (size) => {
      const content = randomBytes(size);
      const object = await storeObject(content, { assetId: 'asset-1', type: 'original' });
      const target = join(folder, 'decrypted');

      await expect(runEncryptionTool(['decrypt', '--keys', keyFile, object, target], output)).resolves.toBe(0);

      await expect(fs.readFile(target)).resolves.toEqual(content);
      expect(logged()).toContain(`${size} bytes, SHA-1 ${createHash('sha1').update(content).digest('hex')}`);
      expect(logged()).toContain('  assetId: asset-1');
    });

    it('should decrypt an object with a key file that was rotated since', async () => {
      const content = randomBytes(1000);
      const object = await storeObject(content);
      await writeNewMasterKey(keyFile, { rotate: true });

      await expect(
        runEncryptionTool(['decrypt', '--keys', keyFile, object, join(folder, 'out')], output),
      ).resolves.toBe(0);
      await expect(fs.readFile(join(folder, 'out'))).resolves.toEqual(content);
    });

    it('should decrypt the fixed object of the first format version', async () => {
      const object = join(folder, 'vector');
      await fs.writeFile(object, Buffer.from(VECTOR.blob, 'base64'));
      const vectorKeys = join(folder, 'vector.key');
      await fs.writeFile(vectorKeys, `${Buffer.alloc(32, 7).toString('base64')}\n`);

      await expect(
        runEncryptionTool(['decrypt', '--keys', vectorKeys, object, join(folder, 'out')], output),
      ).resolves.toBe(0);
      await expect(fs.readFile(join(folder, 'out'), 'utf8')).resolves.toBe('immich encryption test vector');
      expect(logged()).toContain('stored as vector/blob');
    });

    it('should not overwrite an existing file', async () => {
      const object = await storeObject(randomBytes(10));
      const target = join(folder, 'existing');
      await fs.writeFile(target, 'keep me');

      await expect(runEncryptionTool(['decrypt', '--keys', keyFile, object, target], output)).resolves.toBe(1);
      await expect(fs.readFile(target, 'utf8')).resolves.toBe('keep me');
    });

    it('should name the master key that is missing', async () => {
      const object = await storeObject(randomBytes(10));
      const id = MasterKeys.fromFile(keyFile).currentKeyId.toString('hex');
      const otherKeys = join(folder, 'other.key');
      await writeNewMasterKey(otherKeys);

      await expect(
        runEncryptionTool(['decrypt', '--keys', otherKeys, object, join(folder, 'out')], output),
      ).resolves.toBe(1);
      expect(output.error).toHaveBeenCalledWith(
        expect.stringContaining(`encrypted with master key ${id}, which is not in`),
      );
      await expect(fs.access(join(folder, 'out'))).rejects.toThrow('ENOENT');
    });

    it.each([
      [
        'a changed byte of the data',
        (blob: Buffer) => Object.assign(blob, { 10: blob[10] ^ 1 }),
        'chunk 0 failed authentication',
      ],
      [
        'a changed byte of the manifest',
        (blob: Buffer) => Object.assign(blob, { [blob.length - 10]: blob.at(-10)! ^ 1 }),
        'manifest of the blob failed authentication',
      ],
      [
        'missing data',
        (blob: Buffer) => Buffer.concat([blob.subarray(0, 64 * 1024), blob.subarray(64 * 1024 + 16)]),
        'its manifest describes',
      ],
      [
        'a damaged trailer length',
        (blob: Buffer) => Object.assign(blob, { [blob.length - 4]: 0xff }),
        'does not end with the trailer',
      ],
    ])('should fail for an object with %s, without leaving a file', async (_, damage, message) => {
      const object = await storeObject(randomBytes(3 * 64 * 1024));
      await fs.writeFile(object, damage(await fs.readFile(object)));
      const target = join(folder, 'out');

      await expect(runEncryptionTool(['decrypt', '--keys', keyFile, object, target], output)).resolves.toBe(1);
      expect(output.error).toHaveBeenCalledWith(expect.stringContaining(message));
      await expect(fs.access(target)).rejects.toThrow('ENOENT');
    });

    it('should fail for a file that is not an encrypted object', async () => {
      const path = join(folder, 'photo.jpg');
      await fs.writeFile(path, randomBytes(1000));

      await expect(runEncryptionTool(['inspect', path], output)).resolves.toBe(1);
      await expect(runEncryptionTool(['decrypt', '--keys', keyFile, path, join(folder, 'out')], output)).resolves.toBe(
        1,
      );
    });

    it('should need its arguments', async () => {
      await expect(runEncryptionTool(['inspect'], output)).resolves.toBe(2);
      await expect(runEncryptionTool(['decrypt', 'a', 'b'], output)).resolves.toBe(2);
      await expect(runEncryptionTool(['decrypt', '--keys', keyFile, 'a'], output)).resolves.toBe(2);
    });
  });
});
