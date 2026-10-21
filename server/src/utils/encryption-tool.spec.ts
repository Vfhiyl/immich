import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mocked } from 'vitest';
import { MasterKeys } from 'src/repositories/key-provider.js';
import { ENCRYPTION_TOOL_USAGE, ToolOutput, runEncryptionTool } from 'src/utils/encryption-tool.js';

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
});
