import { existsSync } from 'node:fs';
import { link, mkdir, readdir, rename, rm, stat, statfs, utimes } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { StorageLocation } from 'src/cores/storage.core.js';
import { assertValidBlobKey } from 'src/repositories/blob-store.js';

export interface LocalCopyLimits {
  /** How long a copy is kept at most, since it was kept or, with `refreshOnRead`, last read */
  maxAgeMs: number;
  /** Whether reading a copy makes it count as new, which keeps the copies that are used (least recently used) */
  refreshOnRead: boolean;
  /** Copies take at most this much space, or `maxShare` of the filesystem if that is less */
  maxBytes: number;
  maxShare: number;
  /** No copy is kept when the filesystem would have less than this share free */
  minFreeShare: number;
}

/**
 * Copies of uploads for the processing that follows; removed when processing ends, so the limits only matter when it
 * does not. Fixed rather than configurable: copies are a shortcut, reads work the same without them.
 */
export const LOCAL_COPY_LIMITS: LocalCopyLimits = {
  maxAgeMs: 24 * 60 * 60 * 1000,
  refreshOnRead: false,
  maxBytes: 10 * 1024 ** 3,
  maxShare: 0.1,
  minFreeShare: 0.1,
};

/** A cache of small derived files (thumbnails, previews), which are read again and again */
export const DERIVED_CACHE_LIMITS: LocalCopyLimits = {
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  refreshOnRead: true,
  maxBytes: 5 * 1024 ** 3,
  maxShare: 0.05,
  minFreeShare: 0.1,
};

/** A sweep lists every copy, so it runs once this share of the space has been added since the last one */
const SWEEP_AFTER_SHARE = 0.05;

interface Entry {
  path: string;
  size: number;
  modified: number;
}

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/**
 * Local copies of files stored on backends that do not keep them locally, so that processing right after an upload
 * reads the uploaded file instead of downloading it again. A copy is only a shortcut: it may be gone at any time
 * (removed when processing ends, when it is too old, or to keep space), and readers then read the backend.
 *
 * Copies are shared by the server processes through the filesystem. Readers get a hard link of a copy, so a copy that
 * is removed meanwhile stays readable for them.
 */
export class LocalCopies {
  private addedSinceSweep = 0;

  constructor(
    private root: string,
    private limits = LOCAL_COPY_LIMITS,
    private now = () => Date.now(),
  ) {}

  private pathOf({ backendId, key }: StorageLocation) {
    assertValidBlobKey(backendId);
    assertValidBlobKey(key);
    return join(this.root, backendId, key);
  }

  /**
   * Move a local file into the copies of a stored file. Resolves false, leaving the file where it is, when there is not
   * enough space or the file cannot be moved (e.g. it is on another filesystem).
   */
  async keep(location: StorageLocation, path: string): Promise<boolean> {
    const target = this.pathOf(location);
    try {
      await mkdir(dirname(target), { recursive: true });
      const [{ size }, filesystem] = await Promise.all([stat(path), statfs(this.root)]);
      const freeAfter = (filesystem.bavail * filesystem.bsize - size) / (filesystem.blocks * filesystem.bsize);
      if (freeAfter < this.limits.minFreeShare) {
        return false;
      }
      await rename(path, target);
      // aged from when it was kept, not from when the file was written
      await this.touch(target);
      this.addedSinceSweep += size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
        return false;
      }
      throw error;
    }

    if (this.addedSinceSweep >= this.limits.maxBytes * SWEEP_AFTER_SHARE) {
      await this.sweep();
    }
    return true;
  }

  /** The path of the copy of a stored file, if there is one; it may be removed at any time */
  find(location: StorageLocation): string | undefined {
    const path = this.pathOf(location);
    if (!existsSync(path)) {
      return undefined;
    }
    if (this.limits.refreshOnRead) {
      // not awaited: a copy that is not refreshed is only removed a little earlier
      void this.touch(path).catch(() => {});
    }
    return path;
  }

  /** Link the copy of a stored file to `target`; resolves false when there is no copy */
  async linkTo(location: StorageLocation, target: string): Promise<boolean> {
    try {
      const path = this.pathOf(location);
      await link(path, target);
      if (this.limits.refreshOnRead) {
        await this.touch(path);
      }
      return true;
    } catch (error) {
      if (isMissing(error)) {
        return false;
      }
      throw error;
    }
  }

  drop(location: StorageLocation) {
    return rm(this.pathOf(location), { force: true });
  }

  private touch(path: string) {
    const now = new Date(this.now());
    return utimes(path, now, now);
  }

  /** Remove copies that are too old, then the oldest ones until they fit in their space */
  async sweep() {
    this.addedSinceSweep = 0;
    const entries = await this.list();
    if (entries.length === 0) {
      return;
    }

    const expired = this.now() - this.limits.maxAgeMs;
    const kept: Entry[] = [];
    for (const entry of entries) {
      if (entry.modified < expired) {
        await rm(entry.path, { force: true });
      } else {
        kept.push(entry);
      }
    }

    const filesystem = await statfs(this.root);
    const budget = Math.min(this.limits.maxBytes, filesystem.blocks * filesystem.bsize * this.limits.maxShare);
    let total = kept.reduce((sum, { size }) => sum + size, 0);
    for (const entry of kept.toSorted((a, b) => a.modified - b.modified)) {
      if (total <= budget) {
        break;
      }
      await rm(entry.path, { force: true });
      total -= entry.size;
    }
  }

  private async list(): Promise<Entry[]> {
    let backends: string[];
    try {
      backends = await readdir(this.root);
    } catch (error) {
      if (isMissing(error)) {
        return [];
      }
      throw error;
    }

    const entries: Entry[] = [];
    for (const backend of backends) {
      const folder = join(this.root, backend);
      for (const name of await readdir(folder).catch(() => [])) {
        const path = join(folder, name);
        try {
          const stats = await stat(path);
          if (stats.isFile()) {
            entries.push({ path, size: stats.size, modified: stats.mtimeMs });
          }
        } catch (error) {
          // removed meanwhile by another process
          if (!isMissing(error)) {
            throw error;
          }
        }
      }
    }
    return entries;
  }
}
