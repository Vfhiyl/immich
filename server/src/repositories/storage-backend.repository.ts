import { Injectable } from '@nestjs/common';
import { load as loadYaml } from 'js-yaml';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { StorageCore, StorageLocation } from 'src/cores/storage.core.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import {
  StorageBackendConfig,
  StorageBackendsConfig,
  StorageBackendsConfigSchema,
} from 'src/dtos/storage-backend-config.dto.js';
import { BuiltinStorageBackend, StorageBackendDriver, StorageBackendRole } from 'src/enum.js';
import { BlobStore } from 'src/repositories/blob-store.js';
import { LocalBlobStore } from 'src/repositories/local-blob-store.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';

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

/**
 * A new file being written: tools write to `path`, then `commit` stores it and returns where. Dispose it with
 * `await using` so that a file that was not committed is removed.
 */
export interface OutputFile extends AsyncDisposable {
  path: string;
  commit(): Promise<StoredFile>;
}

export type StoredFile = StorageLocation & { size: number | null; checksum: Buffer | null };

/** Temporary files for tools that write to a path, kept below the media location */
export const STAGING_FOLDER = '.immich-staging';

/** Delete recorded files by location, and those recorded before storage backends existed by path */
export const toFileDeletion = (files: Array<RecordedFile | null | undefined>) => {
  const deletion = { files: [] as string[], locations: [] as StorageLocation[] };
  for (const file of files) {
    if (!file?.path) {
      continue;
    }

    if (file.backendId === null || file.key === null) {
      deletion.files.push(file.path);
    } else {
      deletion.locations.push({ backendId: file.backendId, key: file.key });
    }
  }
  return deletion;
};

/**
 * Whether a newly stored file was written over a recorded file, which must then be kept rather than deleted. Only a
 * file written to its path can replace a file that is only known by its path.
 */
export const isSameStoredFile = (existing: RecordedFile, stored: StorageLocation & { path: string }) => {
  if (existing.backendId === null || existing.key === null) {
    return isBuiltinStorageBackend(stored.backendId) && existing.path === stored.path;
  }

  return existing.backendId === stored.backendId && existing.key === stored.key;
};

export const toRecordedFile = (path: string, location: StorageLocation | null): RecordedFile => ({
  path,
  backendId: location?.backendId ?? null,
  key: location?.key ?? null,
});

/** Gives access to the blob store of each storage backend */
export const isBuiltinStorageBackend = (backendId: string): backendId is BuiltinStorageBackend =>
  (Object.values(BuiltinStorageBackend) as string[]).includes(backendId);

@Injectable()
export class StorageBackendRepository {
  private media?: { root: string; store: LocalBlobStore };
  private host?: LocalBlobStore;
  private configured = new Map<string, BlobStore>();
  private roles = new Map<StorageBackendRole, string>();

  constructor(
    @InjectKysely() private db: Kysely<DB>,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(StorageBackendRepository.name);
  }

  /** Read and validate the storage backend configuration file */
  async readConfig(path: string): Promise<StorageBackendsConfig> {
    const content = await readFile(path, 'utf8');
    let parsed: unknown;
    try {
      parsed = content.trim() === '' ? {} : loadYaml(content);
    } catch (error) {
      throw new Error(`Invalid storage backend configuration in ${path}: ${error}`, { cause: error });
    }

    const result = StorageBackendsConfigSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues.map(({ path, message }) => `${path.join('.') || '(root)'}: ${message}`);
      throw new Error(`Invalid storage backend configuration in ${path}:\n${issues.join('\n')}`);
    }
    return result.data;
  }

  /** Make the configured storage backends available, replacing any configured before */
  configure(backends: StorageBackendConfig[]) {
    this.configured = new Map(backends.map((backend) => [backend.id, this.createStore(backend)]));
    this.roles = new Map(backends.map(({ id, role }) => [role, id]));
  }

  /** The backend that new files of a kind are written to, or undefined to write them to their path as before */
  getBackendFor(role: StorageBackendRole): string | undefined {
    return this.roles.get(role);
  }

  /**
   * Prepare a new file that will be stored at `path`, or in the backend configured for its role. On a backend the file
   * gets a new random key, and `path` only serves as its logical name (its extension is kept for tools and type checks).
   */
  async createOutput(role: StorageBackendRole, path: string): Promise<OutputFile> {
    const backendId = this.getBackendFor(role);
    if (!backendId) {
      return {
        path,
        commit: () => Promise.resolve({ ...StorageCore.getStorageLocation(path), size: null, checksum: null }),
        [Symbol.asyncDispose]: () => Promise.resolve(),
      };
    }

    const stagingFolder = join(StorageCore.getMediaLocation(), STAGING_FOLDER);
    await mkdir(stagingFolder, { recursive: true });
    const stagingPath = join(stagingFolder, `${randomUUID()}${extname(path)}`);
    const store = this.get(backendId);

    return {
      path: stagingPath,
      commit: async () => {
        const key = randomUUID();
        const { size, sha1 } = await store.put(key, createReadStream(stagingPath));
        await rm(stagingPath, { force: true });
        return { backendId, key, size, checksum: sha1 };
      },
      [Symbol.asyncDispose]: () => rm(stagingPath, { force: true }),
    };
  }

  get(backendId: string): BlobStore {
    const configured = this.configured.get(backendId);
    if (configured) {
      return configured;
    }

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
    if (isBuiltinStorageBackend(location.backendId) && localPath !== resolve(file.path)) {
      this.logger.warn(
        `Storage location ${location.backendId}:${location.key} does not match the path ${file.path}, using the path`,
      );
      return file.path;
    }

    return localPath;
  }

  @GenerateSql()
  getRegistered() {
    return this.db.selectFrom('storage_backend').select(['id', 'driver']).orderBy('id').execute();
  }

  async register(backends: Array<{ id: string; driver: StorageBackendDriver }>) {
    if (backends.length === 0) {
      return;
    }

    await this.db
      .insertInto('storage_backend')
      .values(backends)
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
  }

  /** Whether any file is stored on a backend; uses the (backendId, key) indexes of the file tables */
  @GenerateSql({ params: [DummyValue.STRING] })
  async isInUse(backendId: string): Promise<boolean> {
    const { rows } = await sql<{ inUse: boolean }>`
      select
        exists (select from "asset_file" where "backendId" = ${backendId})
        or exists (select from "asset_original_file" where "backendId" = ${backendId})
        or exists (select from "person_thumbnail_file" where "backendId" = ${backendId})
        or exists (select from "user_profile_image_file" where "backendId" = ${backendId})
        as "inUse"
    `.execute(this.db);
    return rows[0].inUse;
  }

  private createStore(backend: StorageBackendConfig): BlobStore {
    switch (backend.driver) {
      case StorageBackendDriver.Local: {
        return new LocalBlobStore(backend.root);
      }
    }
  }
}
