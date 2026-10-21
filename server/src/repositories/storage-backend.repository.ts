import { Injectable } from '@nestjs/common';
import { resolve } from 'node:path';
import { StorageCore, StorageLocation } from 'src/cores/storage.core.js';
import { BuiltinStorageBackend } from 'src/enum.js';
import { BlobStore } from 'src/repositories/blob-store.js';
import { LocalBlobStore } from 'src/repositories/local-blob-store.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';

/** A file as recorded in the database: its path, and its location once one has been recorded */
export interface RecordedFile {
  path: string;
  backendId: string | null;
  key: string | null;
}

/** A local copy of a file for tools that need one (exiftool, ffmpeg, sharp); release it with `await using` */
export interface LocalFileLease extends AsyncDisposable {
  /** Has the same file extension as the recorded path, since tools and file type checks rely on it */
  path: string;
}

export const toRecordedFile = (path: string, location: StorageLocation | null): RecordedFile => ({
  path,
  backendId: location?.backendId ?? null,
  key: location?.key ?? null,
});

const isBuiltinBackend = (backendId: string): backendId is BuiltinStorageBackend =>
  (Object.values(BuiltinStorageBackend) as string[]).includes(backendId);

/** Gives access to the blob store of each storage backend */
@Injectable()
export class StorageBackendRepository {
  private media?: { root: string; store: LocalBlobStore };
  private host?: LocalBlobStore;

  constructor(private logger: LoggingRepository) {
    this.logger.setContext(StorageBackendRepository.name);
  }

  get(backendId: string): BlobStore {
    switch (backendId) {
      case BuiltinStorageBackend.Media: {
        // the media location is only known once the server has started
        const root = StorageCore.getMediaLocation();
        if (this.media?.root !== root) {
          this.media = { root, store: new LocalBlobStore(root) };
        }
        return this.media.store;
      }

      case BuiltinStorageBackend.Host: {
        this.host ??= new LocalBlobStore('/');
        return this.host;
      }

      default: {
        throw new Error(`Unknown storage backend: ${backendId}`);
      }
    }
  }

  /** Make a recorded file available on the local filesystem; files on local backends are used where they are */
  lease(file: RecordedFile): Promise<LocalFileLease> {
    return Promise.resolve({ path: this.getLocalPath(file), [Symbol.asyncDispose]: () => Promise.resolve() });
  }

  /**
   * The local path to read a recorded file from. On the built-in backends the location and the path name the same
   * file, so a difference means the path was changed without its location; the path is then used, as before storage
   * backends existed, and the difference is logged so it can be fixed.
   */
  getLocalPath(file: RecordedFile): string {
    if (file.backendId === null || file.key === null) {
      // recorded before storage backends existed and not backfilled yet
      return file.path;
    }

    const location: StorageLocation = { backendId: file.backendId, key: file.key };
    const store = this.get(location.backendId);
    if (!store.getLocalPath) {
      throw new Error(`Storage backend ${location.backendId} does not keep files on the local filesystem`);
    }

    const localPath = store.getLocalPath(location.key);
    if (isBuiltinBackend(location.backendId) && localPath !== resolve(file.path)) {
      this.logger.warn(
        `Storage location ${location.backendId}:${location.key} does not match the path ${file.path}, using the path`,
      );
      return file.path;
    }

    return localPath;
  }
}
