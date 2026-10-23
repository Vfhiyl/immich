import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MasterKeys, generateMasterKey, getMasterKeyId, writeNewMasterKey } from 'src/repositories/key-provider.js';

describe(MasterKeys.name, () => {
  let folder: string;

  const writeKeyFile = async (content: string) => {
    const path = join(folder, 'master.key');
    await fs.writeFile(path, content);
    return path;
  };

  beforeEach(async () => {
    folder = await fs.mkdtemp(join(tmpdir(), 'immich-master-keys-'));
  });

  afterEach(async () => {
    await fs.rm(folder, { recursive: true, force: true });
  });

  describe('getMasterKeyId', () => {
    it('should derive an 8-byte id per key', () => {
      expect(getMasterKeyId(Buffer.alloc(32))).toHaveLength(8);
      expect(getMasterKeyId(Buffer.alloc(32)).equals(getMasterKeyId(Buffer.alloc(32, 1)))).toBe(false);
    });

    it('should keep the id of a known key, since ids are stored with every encrypted file', () => {
      expect(getMasterKeyId(Buffer.alloc(32)).toString('hex')).toBe('496fe1b62991657e');
    });
  });

  describe('generateMasterKey', () => {
    it('should generate a random base64 256-bit key', () => {
      const key = generateMasterKey();
      expect(Buffer.from(key, 'base64')).toHaveLength(32);
      expect(generateMasterKey()).not.toBe(key);
    });
  });

  describe('constructor', () => {
    it('should use the first key as the current one and keep the others for reading', () => {
      const current = Buffer.alloc(32, 1);
      const previous = Buffer.alloc(32, 2);
      const sut = new MasterKeys([current, previous]);

      expect(sut.currentKeyId).toEqual(getMasterKeyId(current));
      expect(sut.getKey(getMasterKeyId(current))).toEqual(current);
      expect(sut.getKey(getMasterKeyId(previous))).toEqual(previous);
    });

    it('should reject an unknown key id', () => {
      const sut = new MasterKeys([Buffer.alloc(32, 1)]);
      expect(() => sut.getKey(getMasterKeyId(Buffer.alloc(32, 2)))).toThrow('is not available');
    });

    it('should reject keys of the wrong length, and no keys at all', () => {
      expect(() => new MasterKeys([])).toThrow();
      expect(() => new MasterKeys([Buffer.alloc(16)])).toThrow();
    });
  });

  describe('fromFile', () => {
    it('should read one key per line, ignoring comments and blank lines', async () => {
      const current = generateMasterKey();
      const previous = generateMasterKey();
      const sut = MasterKeys.fromFile(await writeKeyFile(`# master keys\n\n${current}\n  ${previous}  \n`));

      expect(sut.currentKeyId).toEqual(getMasterKeyId(Buffer.from(current, 'base64')));
      expect(sut.getKey(getMasterKeyId(Buffer.from(previous, 'base64')))).toEqual(Buffer.from(previous, 'base64'));
    });

    it('should reject a file without keys', async () => {
      expect(() => MasterKeys.fromFile(join(folder, 'missing'))).toThrow();
      const path = await writeKeyFile('# nothing here\n');
      expect(() => MasterKeys.fromFile(path)).toThrow('holds no key');
    });

    it('should reject a line that is not a base64 256-bit key', async () => {
      const short = await writeKeyFile(Buffer.alloc(16).toString('base64'));
      expect(() => MasterKeys.fromFile(short)).toThrow('not a base64 encoded 256-bit key');
      const invalid = await writeKeyFile(`${generateMasterKey()}\nnot a key!\n`);
      expect(() => MasterKeys.fromFile(invalid)).toThrow('not a base64 encoded 256-bit key');
    });

    it('should not reveal key material in errors', async () => {
      const path = await writeKeyFile(`${generateMasterKey()}x\n`);
      expect(() => MasterKeys.fromFile(path)).toThrow(/^The master key file .* holds a line that is not/);
    });
  });

  describe('toKeyFile', () => {
    it('should write the keys as a key file holds them, the current one first, to read back the same', async () => {
      const current = generateMasterKey();
      const previous = generateMasterKey();
      const sut = MasterKeys.fromFile(await writeKeyFile(`${current}\n${previous}\n`));

      const text = sut.toKeyFile();
      expect(text.split('\n').filter((line) => line && !line.startsWith('#'))).toEqual([current, previous]);
      const copy = MasterKeys.fromFile(await writeKeyFile(text));
      expect(copy.currentKeyId).toEqual(sut.currentKeyId);
      expect(copy.getKey(getMasterKeyId(Buffer.from(previous, 'base64')))).toEqual(Buffer.from(previous, 'base64'));
    });
  });

  describe('writeNewMasterKey', () => {
    it('should create a key file that only its owner can read', async () => {
      const path = join(folder, 'master.key');
      const { id } = await writeNewMasterKey(path);

      expect(MasterKeys.fromFile(path).currentKeyId.toString('hex')).toBe(id);
      const { mode } = await fs.stat(path);
      expect(mode & 0o777).toBe(0o600);
    });

    it('should never replace an existing key file', async () => {
      const path = await writeKeyFile(`${generateMasterKey()}\n`);
      const before = await fs.readFile(path, 'utf8');

      await expect(writeNewMasterKey(path)).rejects.toThrow('EEXIST');
      await expect(fs.readFile(path, 'utf8')).resolves.toBe(before);
    });

    it('should add a new current key and keep the older ones when rotating', async () => {
      const old = Buffer.from(generateMasterKey(), 'base64');
      const path = await writeKeyFile(`${old.toString('base64')}\n`);

      const { id } = await writeNewMasterKey(path, { rotate: true });

      const keys = MasterKeys.fromFile(path);
      expect(keys.currentKeyId.toString('hex')).toBe(id);
      expect(keys.hasKey(getMasterKeyId(old))).toBe(true);
      const { mode } = await fs.stat(path);
      expect(mode & 0o777).toBe(0o600);
      await expect(fs.readdir(folder)).resolves.toEqual(['master.key']);
    });

    it('should not rotate a damaged key file', async () => {
      const path = await writeKeyFile('not a key\n');

      await expect(writeNewMasterKey(path, { rotate: true })).rejects.toThrow('not a base64 encoded 256-bit key');
      await expect(fs.readFile(path, 'utf8')).resolves.toBe('not a key\n');
    });

    it('should not rotate a key file that does not exist', async () => {
      await expect(writeNewMasterKey(join(folder, 'missing'), { rotate: true })).rejects.toThrow('ENOENT');
    });
  });
});
