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
