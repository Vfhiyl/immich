import { createHash, randomBytes } from 'node:crypto';
import { ResumableSha1 } from 'src/utils/resumable-hash.js';

const sha1 = (value: Buffer) => createHash('sha1').update(value).digest();

describe(ResumableSha1.name, () => {
  it('should hash like node', async () => {
    const content = randomBytes(100_000);
    const hash = await ResumableSha1.create();
    expect(hash.update(content).digest()).toEqual(sha1(content));
  });

  it('should continue from a saved state, in another hasher', async () => {
    const content = randomBytes(3 * 1024 * 1024 + 7);
    const first = await ResumableSha1.create();
    first.update(content.subarray(0, 1_000_001));
    const state = first.save();

    const second = await ResumableSha1.create(state);
    second.update(content.subarray(1_000_001, 2_000_000));
    const third = await ResumableSha1.create(second.save());
    third.update(content.subarray(2_000_000));

    expect(third.digest()).toEqual(sha1(content));
  });

  it('should load a state saved by this version of hash-wasm', async () => {
    // saved after hashing "immich", and kept here: a newer hash-wasm that cannot load it would break uploads in progress
    const saved = Buffer.from(
      'a1MMJAEjRWeJq83v/ty6mHZUMhDw4dLDMAAAAAAAAABpbW1pY2gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'base64',
    );
    const fresh = await ResumableSha1.create();
    expect(fresh.update(Buffer.from('immich')).save()).toEqual(saved);

    const hash = await ResumableSha1.create(saved);
    expect(hash.update(Buffer.from(' photos')).digest()).toEqual(sha1(Buffer.from('immich photos')));
  });

  it('should reject a state that is not one', async () => {
    await expect(ResumableSha1.create(Buffer.from('not a state'))).rejects.toThrow();
  });
});
