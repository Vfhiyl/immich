import { Injectable } from '@nestjs/common';
import { load as loadYaml } from 'js-yaml';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { link, mkdir, readFile, rm } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { StorageCore, StorageLocation } from 'src/cores/storage.core.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import {
  ReplicatedRole,
  StorageBackendConfig,
  StorageBackendsConfig,
  StorageBackendsConfigSchema,
} from 'src/dtos/storage-backend-config.dto.js';
import { BuiltinStorageBackend, StorageBackendDriver, StorageBackendRole } from 'src/enum.js';
import { BlobExpectation, BlobNotFoundError, BlobRange, BlobStore } from 'src/repositories/blob-store.js';
import { EncryptedBlobStore } from 'src/repositories/encrypted-blob-store.js';
import { KeyProvider, MasterKeys } from 'src/repositories/key-provider.js';
import { LocalBlobStore } from 'src/repositories/local-blob-store.js';
import { DERIVED_CACHE_LIMITS, LOCAL_COPY_LIMITS, LocalCopies } from 'src/repositories/local-copies.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { S3BlobStore, createS3Client, meterS3Client } from 'src/repositories/s3-blob-store.js';
import { DB } from 'src/schema/index.js';
import { StorageMeter } from 'src/utils/storage-metering.js';

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
export const toBuffer = (value: Buffer | string | null | undefined) =>
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

/** Where the startup check writes its probe, on every backend */
export const STORAGE_PROBE_PREFIX = '.immich-probe';

export const DEFAULT_DELETION_DELAY_DAYS = 360;
export const DEFAULT_DATABASE_BACKUPS_KEEP_LAST = 14;

/**
 * A file is registered for deletion before it is written, for in case it is never recorded (e.g. the process is killed
 * in between); a day later the cleanup deletes it unless it was recorded, which writing and recording take far less than
 */
export const WRITE_REGISTRATION_DELAY_MS = 24 * 60 * 60 * 1000;

/** Derived files can be generated again, but are kept as long as the database backups that may still record them */
export const DERIVED_DELETION_DELAY_DAYS = 30;

/** Local copies of stored files for processing, on the same filesystem as the staging folder so they can be linked */
export const LOCAL_COPIES_FOLDER = '.immich-copies';

/** Cached derived files, like local copies but kept while they are used */
export const DERIVED_CACHE_FOLDER = '.immich-cache';

/** Derived files read from a backend are cached up to this size; encoded videos are larger and read in ranges */
const DERIVED_CACHE_MAX_FILE_SIZE = 16 * 1024 * 1024;

export interface StoreOptions {
  /** Describes the file in an encrypted object, besides its path */
  manifest?: Record<string, unknown>;
}

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
  private copies?: { root: string; copies: LocalCopies; cache: LocalCopies };
  private host?: LocalBlobStore;
  private configured = new Map<string, BlobStore>();
  /** Backends whose new files are encrypted */
  private encryptedBackends = new Set<string>();
  private keys?: KeyProvider;
  private decrypting = new Map<string, EncryptedBlobStore>();
  private configs = new Map<string, StorageBackendConfig>();
  private deletionStores = new Map<string, BlobStore>();
  /** The folders replicas keep the copies of each backend in, to write and to delete with */
  private replicaStores = new Map<string, { write: BlobStore; deletion: BlobStore }>();
  private originalsDeletionDelayDays = DEFAULT_DELETION_DELAY_DAYS;
  private databaseBackupsKeepLast = DEFAULT_DATABASE_BACKUPS_KEEP_LAST;
  private roles = new Map<StorageBackendRole, string>();
  protected readRetryDelays = READ_RETRY_DELAYS;
  private meter = new StorageMeter();

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
  configure(
    backends: StorageBackendConfig[],
    keys?: KeyProvider,
    { delayDays = DEFAULT_DELETION_DELAY_DAYS }: Partial<StorageBackendsConfig['deletion']> = {},
    { keepLast = DEFAULT_DATABASE_BACKUPS_KEEP_LAST }: Partial<StorageBackendsConfig['databaseBackups']> = {},
  ) {
    const encrypted = backends.filter((backend) => backend.encrypted);
    if (encrypted.length > 0 && !keys) {
      throw new Error(`Storage backend ${encrypted[0].id} is encrypted, but no master key is configured`);
    }

    this.configured = new Map(backends.map((backend) => [backend.id, this.createStore(backend)]));
    this.roles = new Map(backends.map(({ id, role }) => [role, id]));
    this.encryptedBackends = new Set(encrypted.map(({ id }) => id));
    this.keys = keys;
    this.decrypting.clear();
    this.configs = new Map(backends.map((backend) => [backend.id, backend]));
    this.deletionStores.clear();
    this.replicaStores.clear();
    this.originalsDeletionDelayDays = delayDays;
    this.databaseBackupsKeepLast = keepLast;
  }

  /** How many database backups the backend for backups keeps, at the least */
  getDatabaseBackupsKeepLast() {
    return this.databaseBackupsKeepLast;
  }

  /**
   * How long a file deleted from a backend is kept before it is deleted: originals (all files but those on the backend
   * for derived files, which can be generated again) for the configured delay, derived files for a fixed one
   */
  getDeletionDelay(backendId: string): { days: number; isOriginal: boolean } {
    const isOriginal = backendId !== this.getBackendFor(StorageBackendRole.Derived);
    return { days: isOriginal ? this.originalsDeletionDelayDays : DERIVED_DELETION_DELAY_DAYS, isOriginal };
  }

  getOriginalsDeletionDelayDays() {
    return this.originalsDeletionDelayDays;
  }

  /** The store that deletes from a backend: with the deletion credentials of the backend, if it has its own */
  getDeletionStore(backendId: string): BlobStore {
    const config = this.configs.get(backendId);
    if (config?.driver !== StorageBackendDriver.S3 || !config.deletionCredentials) {
      return this.get(backendId);
    }

    let store = this.deletionStores.get(backendId);
    if (!store) {
      const client = this.createS3Client(backendId, { ...config, credentials: config.deletionCredentials });
      store = new S3BlobStore(client, config.bucket, config.prefix);
      this.deletionStores.set(backendId, store);
    }
    return store;
  }

  /** Which backend each replica copies, for every role it copies */
  getReplicaSources(): Array<{ replicaBackendId: string; sourceBackendId: string; role: ReplicatedRole }> {
    const sources = [];
    for (const { id, replicaOf } of this.configs.values()) {
      for (const role of replicaOf ?? []) {
        const sourceBackendId = this.getBackendFor(role);
        if (sourceBackendId) {
          sources.push({ replicaBackendId: id, sourceBackendId, role });
        }
      }
    }
    return sources;
  }

  /**
   * The folder of a replica that holds the copies of a backend, named after it: copies have the keys of their files
   * there, so the replica can take the place of the backend by configuring the backend with that folder. `deletion`
   * gives the store with the deletion credentials of the replica, if it has its own.
   */
  getReplicaStore(replicaBackendId: string, sourceBackendId: string, { deletion = false } = {}): BlobStore {
    const id = `${replicaBackendId}/${sourceBackendId}`;
    let stores = this.replicaStores.get(id);
    if (!stores) {
      const config = this.configs.get(replicaBackendId);
      if (config?.role !== StorageBackendRole.Replica) {
        throw new Error(`Storage backend ${replicaBackendId} is not a replica`);
      }
      stores = this.createReplicaStores(config, sourceBackendId);
      this.replicaStores.set(id, stores);
    }
    return deletion ? stores.deletion : stores.write;
  }

  /** The folder of a replica that holds the copies of an encrypted backend, which reads what copies describe themselves with */
  getEncryptedReplicaStore(replicaBackendId: string, sourceBackendId: string): EncryptedBlobStore {
    if (!this.keys) {
      throw new Error(`Files on storage backend ${sourceBackendId} are encrypted, but no master key is configured`);
    }
    return new EncryptedBlobStore(this.getReplicaStore(replicaBackendId, sourceBackendId), this.keys);
  }

  private createReplicaStores(config: StorageBackendConfig, sourceBackendId: string) {
    switch (config.driver) {
      case StorageBackendDriver.Local: {
        const store = new LocalBlobStore(join(config.root, sourceBackendId));
        return { write: store, deletion: store };
      }

      case StorageBackendDriver.S3: {
        const prefix = `${config.prefix}${sourceBackendId}/`;
        const write = new S3BlobStore(this.createS3Client(config.id, config), config.bucket, prefix);
        const deletion = config.deletionCredentials
          ? new S3BlobStore(
              this.createS3Client(config.id, { ...config, credentials: config.deletionCredentials }),
              config.bucket,
              prefix,
            )
          : write;
        return { write, deletion };
      }
    }
  }

  /** The configured backends, with their role */
  getConfiguredBackends(): Array<{ id: string; role: StorageBackendRole }> {
    return this.configs
      .values()
      .map(({ id, role }) => ({ id, role }))
      .toArray();
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
   * otherwise it is copied to the backend under a new key, and the caller removes the local file. An encrypted copy
   * describes itself with its path and `manifest`, for when it has to be recovered without the database.
   */
  async storeFile(role: StorageBackendRole, path: string, { manifest }: StoreOptions = {}): Promise<StoredFile> {
    const backendId = this.getBackendFor(role);
    if (!backendId) {
      return { ...StorageCore.getStorageLocation(path), size: null, checksum: null, encryption: null };
    }

    const key = randomUUID();
    await this.registerWrite(backendId, key);
    const { size, sha1, encryption } = await this.getWriteStore(backendId).put(key, createReadStream(path), {
      manifest: { path, ...manifest },
    });
    return { backendId, key, size, checksum: sha1, encryption: encryption ?? null };
  }

  /**
   * Prepare a new file that will be stored at `path`, or in the backend configured for its role. On a backend the file
   * gets a new random key, and `path` only serves as its logical name (its extension is kept for tools and type checks).
   * With `keepLocalCopy`, the written file is kept as a local copy for processing that follows; with `cache`, in the
   * cache of derived files, for small files that are read often.
   */
  async createOutput(
    role: StorageBackendRole,
    path: string,
    {
      manifest,
      keepLocalCopy = false,
      cache = false,
    }: StoreOptions & { keepLocalCopy?: boolean; cache?: boolean } = {},
  ): Promise<OutputFile> {
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
        await this.registerWrite(backendId, key);
        const { size, sha1, encryption } = await store.put(key, createReadStream(stagingPath), {
          manifest: { path, ...manifest },
        });
        const stored = { backendId, key, size, checksum: sha1, encryption: encryption ?? null };
        const isKept =
          (keepLocalCopy && (await this.keepLocalCopy(stored, stagingPath))) ||
          (cache && this.isReadThroughStore(stored) && (await this.getDerivedCache().keep(stored, stagingPath)));
        if (!isKept) {
          await rm(stagingPath, { force: true });
        }
        return stored;
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

  /**
   * Keep a local file as a copy of a stored file, for the processing that follows; the caller must not use or remove
   * it afterwards. Resolves false, leaving the file to the caller, when no copy is needed (the stored file can be read
   * where it is) or none can be kept.
   */
  async keepLocalCopy(stored: StoredFile, path: string): Promise<boolean> {
    if (!this.isReadThroughStore(stored)) {
      return false;
    }
    return this.getLocalCopies().keep(stored, path);
  }

  /** Remove the local copy of a stored file once nothing is going to read it soon, if there is one */
  async dropLocalCopy(file: Pick<RecordedFile, 'backendId' | 'key'> | null | undefined) {
    if (!(file?.backendId && file.key) || isBuiltinStorageBackend(file.backendId)) {
      return;
    }

    const location = { backendId: file.backendId, key: file.key };
    await this.getLocalCopies().drop(location);
    await this.getDerivedCache().drop(location);
  }

  /** Remove what cut-off writes left on the configured local backends, replicas included */
  async sweepTemporaryFiles(before: Date) {
    let removed = 0;
    for (const config of this.configs.values()) {
      if (config.driver === StorageBackendDriver.Local) {
        removed += await new LocalBlobStore(config.root).sweepTemporaryFiles(before);
      }
    }
    return removed;
  }

  /** Remove local copies and cached files that are too old or take too much space */
  async sweepLocalCopies() {
    await this.getLocalCopies().sweep();
    await this.getDerivedCache().sweep();
  }

  // methods rather than getters: tools that inspect repositories read every property
  private getLocalCopies() {
    return this.getCopyFolders().copies;
  }

  private getDerivedCache() {
    return this.getCopyFolders().cache;
  }

  private getCopyFolders() {
    const root = StorageCore.getMediaLocation();
    if (this.copies?.root !== root) {
      this.copies = {
        root,
        copies: new LocalCopies(join(root, LOCAL_COPIES_FOLDER), LOCAL_COPY_LIMITS),
        cache: new LocalCopies(join(root, DERIVED_CACHE_FOLDER), DERIVED_CACHE_LIMITS),
      };
    }
    return this.copies;
  }

  private isReadThroughStore(file: StoredFile) {
    return file.backendId !== null && file.key !== null && 'blob' in this.resolve({ path: '', ...file });
  }

  /** Make a recorded file available on the local filesystem; files on local backends are used where they are */
  async lease(file: RecordedFile): Promise<LocalFileLease> {
    const source = this.resolve(file);
    if ('path' in source) {
      return { path: source.path, [Symbol.asyncDispose]: () => Promise.resolve() };
    }

    // a file in the staging folder, removed when the lease ends: a link to the local copy if there is one, otherwise
    // downloaded and verified while it is
    const stagingFolder = join(StorageCore.getMediaLocation(), STAGING_FOLDER);
    await mkdir(stagingFolder, { recursive: true });
    const stagingPath = join(stagingFolder, `${randomUUID()}${extname(file.path)}`);
    const location = { backendId: file.backendId!, key: file.key! };
    const release = () => rm(stagingPath, { force: true });
    if (
      (await this.getLocalCopies().linkTo(location, stagingPath)) ||
      (await this.getDerivedCache().linkTo(location, stagingPath))
    ) {
      return { path: stagingPath, [Symbol.asyncDispose]: release };
    }

    try {
      await this.withReadRetries(file, async () => {
        await pipeline(await readBlob(source.blob), createWriteStream(stagingPath));
      });
    } catch (error) {
      await rm(stagingPath, { force: true });
      throw error;
    }

    // small derived files are read again (by several jobs, and when served), so a verified download is cached
    if (this.isCachedDerivedFile(file)) {
      const cached = join(stagingFolder, `${randomUUID()}${extname(file.path)}`);
      await link(stagingPath, cached);
      if (!(await this.getDerivedCache().keep(location, cached))) {
        await rm(cached, { force: true });
      }
    }

    return { path: stagingPath, [Symbol.asyncDispose]: () => rm(stagingPath, { force: true }) };
  }

  /** What a file response sends: a local file (also a cached one), or a blob together with its logical path */
  toFileSource(file: RecordedFile): { path: string; blob?: RemoteBlob } {
    const source = this.resolve(file);
    if ('path' in source) {
      return { path: source.path };
    }

    const cached = this.getDerivedCache().find({ backendId: file.backendId!, key: file.key! });
    return cached ? { path: cached } : { path: file.path, blob: source.blob };
  }

  private isCachedDerivedFile(file: RecordedFile) {
    const size = toBlobExpectation(file)?.size;
    return (
      file.backendId === this.getBackendFor(StorageBackendRole.Derived) &&
      size !== undefined &&
      size <= DERIVED_CACHE_MAX_FILE_SIZE
    );
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

  /** The encrypted store of a backend, which also reads what blobs describe themselves with */
  getEncryptedStore(backendId: string): EncryptedBlobStore {
    return this.getDecryptingStore(backendId);
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

  /**
   * Register a file about to be written to a backend for deletion, unless it is recorded by `notBefore`: the cleanup
   * drops the registration of a file that is recorded, and deletes one that is not
   */
  @GenerateSql({ params: [DummyValue.STRING, DummyValue.STRING, DummyValue.DATE] })
  async registerWrite(backendId: string, key: string, notBefore = new Date(Date.now() + WRITE_REGISTRATION_DELAY_MS)) {
    await this.db
      .insertInto('storage_deletion')
      .values({ backendId, key, notBefore, isOriginal: false, isWrite: true })
      .onConflict((oc) => oc.columns(['backendId', 'key']).doNothing())
      .execute();
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

  /** Ids of the master keys that have encrypted files */
  @GenerateSql()
  async getMasterKeyIds(): Promise<Buffer[]> {
    const rows = await this.db.selectFrom('storage_master_key').select('id').orderBy('createdAt').execute();
    return rows.map(({ id }) => id);
  }

  @GenerateSql({ params: [DummyValue.BUFFER] })
  async registerMasterKey(id: Buffer) {
    await this.db
      .insertInto('storage_master_key')
      .values({ id })
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

  /** A client whose requests are counted for the backend */
  private createS3Client(backendId: string, config: Parameters<typeof createS3Client>[0]) {
    return meterS3Client(createS3Client(config), (request) => this.meter.record(backendId, request));
  }

  /** The requests to storage services counted since the last call, to be written to the database */
  drainRequestUsage() {
    return this.meter.drain();
  }

  private createStore(backend: StorageBackendConfig): BlobStore {
    switch (backend.driver) {
      case StorageBackendDriver.Local: {
        return new LocalBlobStore(backend.root);
      }

      case StorageBackendDriver.S3: {
        return new S3BlobStore(this.createS3Client(backend.id, backend), backend.bucket, backend.prefix);
      }
    }
  }
}
