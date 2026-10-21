import { IHasher, createSHA1 } from 'hash-wasm';

/**
 * SHA-1 whose state can be saved and loaded again, so that a file received over several requests (and processes) is
 * hashed once while it arrives. Node's own hashes cannot save their state.
 *
 * Saved states are only compatible within a version of hash-wasm, which is why it is pinned; a state also holds up to
 * a block of input bytes, so it is kept like the content it hashes.
 */
export class ResumableSha1 {
  private constructor(private hasher: IHasher) {}

  static async create(state?: Buffer | null) {
    const hasher = await createSHA1();
    hasher.init();
    if (state) {
      hasher.load(state);
    }
    return new ResumableSha1(hasher);
  }

  update(data: Buffer) {
    this.hasher.update(data);
    return this;
  }

  save(): Buffer {
    return Buffer.from(this.hasher.save());
  }

  /** The SHA-1 of everything so far; the hash cannot be updated afterwards */
  digest(): Buffer {
    return Buffer.from(this.hasher.digest('binary'));
  }
}
