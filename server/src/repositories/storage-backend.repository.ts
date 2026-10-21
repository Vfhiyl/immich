import { Injectable } from '@nestjs/common';
import { load as loadYaml } from 'js-yaml';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { StorageCore, StorageLocation } from 'src/cores/storage.core.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import {
  StorageBackendConfig,
  StorageBackendsConfig,
  StorageBackendsConfigSchema,
} from 'src/dtos/storage-backend-config.dto.js';
import { BuiltinStorageBackend, StorageBackendDriver, StorageBackendRole } from 'src/enum.js';
import { BlobExpectation, BlobNotFoundError, BlobRange, BlobStore } from 'src/repositories/blob-store.js';
import { EncryptedBlobStore } from 'src/repositories/encrypted-blob-store.js';
import { KeyProvider, MasterKeys } from 'src/repositories/key-provider.js';
import { LocalBlobStore } from 'src/repositories/local-blob-store.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { S3BlobStore, createS3Client } from 'src/repositories/s3-blob-store.js';
import { DB } from 'src/schema/index.js';

/** A file as recorded in the database: its path, and its location once one has been recorded */
export interface RecordedFile {
  path: string;
  backendId: string | null;
  key: string | null;
  /** Size and SHA-1 as recorded when the file was stored, to verify reads with; null if not recorded */
  size?: number | string | null;
  /** A buffer, or hex encoded (as `\\x…`) when it comes from a JSON column */
  checksum?: Buffer | string | null;
  /** For an encrypted file, the header that reading it needs; a buffer, or hex encoded like the checksum */
  encryption?: Buffer | string | null;
}

/** A bytea value, which JSON columns hold as hex text (`\\x…`) */
const toBuffer = (value: Buffer | string | null | undefined) =>
  typeof value === 'string' ? Buffer.from(value.replace(/^\\x/, ''), 'hex') : (value ?? undefined);

/** What a read of a recorded file is verified against, if anything was recorded */
export const toBlobExpectation = ({ size, checksum }: RecordedFile): BlobExpectation | undefined => {
  if (size === null || size === undefined) {
    return undefined;
  }

  return { size: Number(size), sha1: toBuffer(checksum) };
};

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

export type StoredFile = StorageLocation & { size: number | null; checksum: Buffer | null; encryption: Buffer | null };

/** A blob on a backend that does not keep files on the local filesystem */
export interface RemoteBlob {
  store: BlobStore;
  key: string;
  expect?: BlobExpectation;
  /** For an encrypted blob, the header that reading it needs; `store` then decrypts it */
  encryption?: Buffer;
}

/** Read a remote blob, or a range of it, verified against what was recorded and decrypted if it is encrypted */
export const readBlob = ({ store, key, expect, encryption }: RemoteBlob, range?: BlobRange) =>
  store.get(key, { range, expect, encryption });

/** Pauses between reads of a blob that is not readable yet, about 15 seconds in all */
const READ_RETRY_DELAYS = [500, 1000, 2000, 4000, 8000];

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

export const toRecordedFile = (
  path: string,
  location: (StorageLocation & Pick<RecordedFile, 'size' | 'checksum' | 'encryption'>) | null,
): RecordedFile => ({
  path,
  backendId: location?.backendId ?? null,
  key: location?.key ?? null,
  size: location?.size ?? null,
  checksum: location?.checksum ?? null,
  encryption: location?.encryption ?? null,
});

/** Gives access to the blob store of each storage backend */
export const isBuiltinStorageBackend = (backendId: string): backendId is BuiltinStorageBackend =>
  (Object.values(BuiltinStorageBackend) as string[]).includes(backendId);

@Injectable()
export class StorageBackendRepository {
  private media?: { root: string; store: LocalBlobStore };
  private host?: LocalBlobStore;
  private configured = new Map<string, BlobStore>();
  /** Backends whose new files are encrypted */
  private encryptedBackends = new Set<string>();
  private keys?: KeyProvider;
  private decrypting = new Map<string, EncryptedBlobStore>();
  private roles = new Map<StorageBackendRole, string>();
  protected readRetryDelays = READ_RETRY_DELAYS;

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

  /** Master keys from a key file, one base64 key per line */
  readMasterKeys(path: string): KeyProvider {
    return MasterKeys.fromFile(path);
  }

  /**
   * Make the configured storage backends available, replacing any configured before. Master keys are needed to write
   * to encrypted backends, and to read any encrypted file.
   */
  configure(backends: StorageBackendConfig[], keys?: KeyProvider) {
    const encrypted = backends.filter((backend) => backend.encrypted);
    if (encrypted.length > 0 && !keys) {
      throw new Error(`Storage backend ${encrypted[0].id} is encrypted, but no master key is configured`);
    }

    this.configured = new Map(backends.map((backend) => [backend.id, this.createStore(backend)]));
    this.roles = new Map(backends.map(({ id, role }) => [role, id]));
    this.encryptedBackends = new Set(encrypted.map(({ id }) => id));
    this.keys = keys;
    this.decrypting.clear();
  }

  hasConfiguredBackends(): boolean {
    return this.configured.size > 0;
  }

  /** The backend that new files of a kind are written to, or undefined to write them to their path as before */
  getBackendFor(role: StorageBackendRole): string | undefined {
    return this.roles.get(role);
  }

  /**
   * Store a complete local file as a new file of a role. Without a backend for the role the file stays where it is;
   * otherwise it is copied to the backend under a new key, and the caller removes the local file.
   */
  async storeFile(role: StorageBackendRole, path: string): Promise<StoredFile> {
    const backendId = this.getBackendFor(role);
    if (!backendId) {
      return { ...StorageCore.getStorageLocation(path), size: null, checksum: null, encryption: null };
    }

    const key = randomUUID();
    const { size, sha1, encryption } = await this.getWriteStore(backendId).put(key, createReadStream(path));
    return { backendId, key, size, checksum: sha1, encryption: encryption ?? null };
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
        commit: () =>
          Promise.resolve({ ...StorageCore.getStorageLocation(path), size: null, checksum: null, encryption: null }),
        [Symbol.asyncDispose]: () => Promise.resolve(),
      };
    }

    const stagingFolder = join(StorageCore.getMediaLocation(), STAGING_FOLDER);
    await mkdir(stagingFolder, { recursive: true });
    const stagingPath = join(stagingFolder, `${randomUUID()}${extname(path)}`);
    const store = this.getWriteStore(backendId);

    return {
      path: stagingPath,
      commit: async () => {
        const key = randomUUID();
        const { size, sha1, encryption } = await store.put(key, createReadStream(stagingPath));
        await rm(stagingPath, { force: true });
        return { backendId, key, size, checksum: sha1, encryption: encryption ?? null };
      },
      [Symbol.asyncDispose]: () => rm(stagingPath, { force: true }),
    };
  }

  /** The store new files of a backend are written to: one that encrypts them if the backend is encrypted */
  getWriteStore(backendId: string): BlobStore {
    return this.encryptedBackends.has(backendId) ? this.getDecryptingStore(backendId) : this.get(backendId);
  }

  /** The store of a backend as it is, without encryption: for deleting and listing, and for files not encrypted */
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
  async lease(file: RecordedFile): Promise<LocalFileLease> {
    const source = this.resolve(file);
    if ('path' in source) {
      return { path: source.path, [Symbol.asyncDispose]: () => Promise.resolve() };
    }

    // a copy in the staging folder, verified while it is downloaded and removed when the lease ends
    const stagingFolder = join(StorageCore.getMediaLocation(), STAGING_FOLDER);
    await mkdir(stagingFolder, { recursive: true });
    const stagingPath = join(stagingFolder, `${randomUUID()}${extname(file.path)}`);
    try {
      await this.withReadRetries(file, async () => {
        await pipeline(await readBlob(source.blob), createWriteStream(stagingPath));
      });
    } catch (error) {
      await rm(stagingPath, { force: true });
      throw error;
    }

    return { path: stagingPath, [Symbol.asyncDispose]: () => rm(stagingPath, { force: true }) };
  }

  /** What a file response sends: a local file, or a blob together with its logical path */
  toFileSource(file: RecordedFile): { path: string; blob?: RemoteBlob } {
    const source = this.resolve(file);
    return 'path' in source ? { path: source.path } : { path: file.path, blob: source.blob };
  }

  /**
   * Where to read a recorded file from: a local path, or a blob that has to be read through its store (on a backend
   * that does not keep files locally, or encrypted), with what the read is verified against.
   */
  resolve(file: RecordedFile): { path: string } | { blob: RemoteBlob } {
    if (file.backendId === null || file.key === null) {
      return { path: file.path };
    }

    // whether a file is encrypted is recorded with it, so files stay readable when the setting of a backend changes
    const encryption = toBuffer(file.encryption);
    if (encryption) {
      const expect = toBlobExpectation(file);
      if (!expect) {
        throw new Error(`The encrypted file ${file.backendId}:${file.key} has no recorded size`);
      }
      return { blob: { store: this.getDecryptingStore(file.backendId), key: file.key, expect, encryption } };
    }

    const store = this.get(file.backendId);
    if (store.getLocalPath) {
      return { path: this.getLocalPath(file) };
    }

    return { blob: { store, key: file.key, expect: toBlobExpectation(file) } };
  }

  private getDecryptingStore(backendId: string): EncryptedBlobStore {
    let store = this.decrypting.get(backendId);
    if (!store) {
      if (!this.keys) {
        throw new Error(`Files on storage backend ${backendId} are encrypted, but no master key is configured`);
      }
      store = new EncryptedBlobStore(this.get(backendId), this.keys);
      this.decrypting.set(backendId, store);
    }
    return store;
  }

  /**
   * A blob written moments ago may not be readable yet (services only promise eventual consistency), so a missing blob
   * is read again a few times with growing pauses before giving up; never treat it as gone.
   */
  private async withReadRetries<T>(file: RecordedFile, read: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await read();
      } catch (error) {
        if (!(error instanceof BlobNotFoundError) || attempt >= this.readRetryDelays.length) {
          throw error;
        }
        this.logger.debug(`${file.backendId}:${file.key} is not readable yet, retrying`);
        await sleep(this.readRetryDelays[attempt]);
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

      case StorageBackendDriver.S3: {
        return new S3BlobStore(createS3Client(backend), backend.bucket, backend.prefix);
      }
    }
  }
}
