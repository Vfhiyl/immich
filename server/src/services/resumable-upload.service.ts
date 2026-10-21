import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rm, stat } from 'node:fs/promises';
import { IncomingHttpHeaders } from 'node:http';
import { extname, join } from 'node:path';
import { Readable } from 'node:stream';
import z from 'zod';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnJob } from 'src/decorators.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import {
  AssetVisibility,
  BuiltinStorageBackend,
  JobName,
  JobStatus,
  Permission,
  QueueName,
  StorageBackendRole,
  StorageFolder,
  UploadSessionStatus,
} from 'src/enum.js';
import { BlobStore, BlobUpload, BlobUploadNotFoundError } from 'src/repositories/blob-store.js';
import { STAGING_FOLDER, StoredFile } from 'src/repositories/storage-backend.repository.js';
import { UploadAssetData } from 'src/schema/tables/upload-session.table.js';
import { AssetMediaService } from 'src/services/asset-media.service.js';
import { BaseService } from 'src/services/base.service.js';
import { ResumableSha1 } from 'src/utils/resumable-hash.js';
import {
  LATEST_INTEROP_VERSION,
  ResumableUploadHeaderError,
  completedUploadProblem,
  getDeclaredSha1,
  getInteropVersion,
  getUploadComplete,
  getUploadLength,
  getUploadOffset,
  inconsistentLengthProblem,
  mismatchingOffsetProblem,
  toUploadCompleteHeader,
  toUploadLimitHeader,
} from 'src/utils/resumable-upload.js';

/** Parts are 16 MiB, or larger to fit a large file into the 10,000 parts S3 allows, in steps every service accepts */
const PART_SIZE = 16 * 1024 * 1024;
const PART_SIZE_STEP = 256 * 1024;
const MAX_PARTS = 10_000;
/** For a file of unknown length: up to about 625 GiB */
const UNKNOWN_LENGTH_PART_SIZE = 64 * 1024 * 1024;

/** An upload is kept for this long after its last request; long enough for a phone to come back, fixed in code */
export const UPLOAD_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Header of the creation request that describes the asset, as base64url encoded JSON */
export const UPLOAD_ASSET_DATA_HEADER = 'x-immich-asset-data';

/** How long a new request for an upload waits for the request it replaces to stop */
const REPLACED_REQUEST_TIMEOUT_MS = 30_000;

export const getUploadPartSize = (length?: number) =>
  length === undefined
    ? UNKNOWN_LENGTH_PART_SIZE
    : Math.max(PART_SIZE, Math.ceil(length / MAX_PARTS / PART_SIZE_STEP) * PART_SIZE_STEP);

const AssetDataSchema = z.object({
  filename: z.string().min(1),
  fileCreatedAt: z.iso.datetime({ offset: true }),
  fileModifiedAt: z.iso.datetime({ offset: true }),
  deviceAssetId: z.string().optional(),
  deviceId: z.string().optional(),
  duration: z.int().min(0).optional(),
  isFavorite: z.boolean().optional(),
  visibility: z.enum(AssetVisibility).optional(),
  livePhotoVideoId: z.uuid().optional(),
});

export interface ResumableUploadRequest {
  auth: AuthDto;
  headers: IncomingHttpHeaders;
  body: Readable;
  /** Sends a `104 (Upload Resumption Supported)` interim response, before the content is read */
  sendInterim?: (headers: Record<string, string>) => void;
}

export interface ResumableUploadResponse {
  status: number;
  headers: Record<string, string>;
  body?: unknown;
}

type Session = NonNullable<Awaited<ReturnType<BaseService['uploadSessionRepository']['get']>>>;

const problem = (status: number, body: object, headers: Record<string, string> = {}): ResumableUploadResponse => ({
  status,
  headers: { 'Content-Type': 'application/problem+json', ...headers },
  body,
});

/**
 * Resumable uploads (draft-ietf-httpbis-resumable-upload). The file is written to the storage backend for originals
 * in parts while it arrives, encrypted if the backend is; the offset only moves when a part is written and recorded,
 * so an upload can always be resumed from what was recorded, by any process. The bytes after the last part wait in a
 * staging file. When the upload is complete, the asset is created like any upload.
 */
@Injectable()
export class ResumableUploadService extends BaseService {
  private active = new Map<string, { abort: () => void; done: Promise<void> }>();

  getOptions(): ResumableUploadResponse {
    return {
      status: 204,
      headers: { 'Upload-Limit': this.getUploadLimit(), 'Accept-Patch': 'application/partial-upload' },
    };
  }

  async createUpload({ auth, headers, body, sendInterim }: ResumableUploadRequest): Promise<ResumableUploadResponse> {
    let version: number | undefined;
    let complete: boolean | undefined;
    let length: number | undefined;
    let declaredChecksum: Buffer | undefined;
    let assetData: UploadAssetData;
    try {
      version = getInteropVersion(headers);
      complete = getUploadComplete(headers, version);
      length = getUploadLength(headers);
      declaredChecksum = getDeclaredSha1(headers);
      assetData = this.getAssetData(headers);
    } catch (error) {
      return this.toBadRequest(error);
    }
    if (complete === undefined) {
      return problem(400, { message: 'Not a resumable upload: Upload-Complete is missing' });
    }

    await this.requireAccess({ auth, permission: Permission.AssetUpload, ids: [auth.user.id] });

    // a file the user has already is not uploaded again
    if (declaredChecksum) {
      const duplicateId = await this.assetRepository.getUploadAssetIdByChecksum(auth.user.id, declaredChecksum);
      if (duplicateId) {
        return { status: 200, headers: {}, body: { id: duplicateId, status: 'duplicate' } };
      }
    }
    if (length !== undefined) {
      await this.requireQuotaForUpload(auth, length);
    }

    const backendId = this.storageBackendRepository.getBackendFor(StorageBackendRole.Originals);
    const uuid = randomUUID();
    const path = join(
      StorageCore.getNestedFolder(StorageFolder.Upload, auth.user.id, uuid),
      `${uuid}${extname(assetData.filename).toLowerCase()}`,
    );
    // without a backend for originals, the file is written to its upload path, like an upload has always been
    const key = backendId ? uuid : StorageCore.getStorageLocation(path).key;
    const store = this.getStore(backendId);
    const upload = await store.createUpload(key, { partSize: getUploadPartSize(length) });

    const session = await this.uploadSessionRepository.create({
      ownerId: auth.user.id,
      status: UploadSessionStatus.Receiving,
      assetData: { ...assetData, path } as UploadAssetData,
      interopVersion: version ?? null,
      length: length ?? null,
      declaredChecksum: declaredChecksum ?? null,
      backendId: backendId ?? BuiltinStorageBackend.Media,
      key,
      blobUploadId: upload.uploadId,
      partSize: upload.partSize,
      encryption: upload.encryption ?? null,
      expiresAt: this.getExpiry(),
    });

    const location = `/api/upload/${session.id}`;
    // clients that send no version do not expect an interim response (the draft forbids one)
    if (version !== undefined) {
      sendInterim?.({
        Location: location,
        'Upload-Draft-Interop-Version': String(version),
        'Upload-Limit': this.getUploadLimit(version),
      });
    }

    const response = await this.append(auth, session, body, complete);
    return {
      ...response,
      status: response.status === 204 ? 201 : response.status,
      headers: { Location: location, ...response.headers },
    };
  }

  async appendUpload(id: string, { auth, headers, body }: ResumableUploadRequest): Promise<ResumableUploadResponse> {
    const session = await this.getSession(auth, id);
    const version = session.interopVersion ?? LATEST_INTEROP_VERSION;
    let complete: boolean | undefined;
    let offset: number | undefined;
    try {
      complete = getUploadComplete(headers, version);
      offset = getUploadOffset(headers);
    } catch (error) {
      return this.toBadRequest(error);
    }
    if (complete === undefined || offset === undefined) {
      return problem(400, { message: 'Appending needs Upload-Complete and Upload-Offset' });
    }
    if (session.status === UploadSessionStatus.Completed) {
      return problem(400, completedUploadProblem());
    }

    return this.append(auth, session, body, complete, offset);
  }

  async getUpload(auth: AuthDto, id: string): Promise<ResumableUploadResponse> {
    const session = await this.getSession(auth, id);
    const version = session.interopVersion ?? LATEST_INTEROP_VERSION;
    const isComplete = session.status === UploadSessionStatus.Completed;
    const offset = isComplete ? session.length : await this.getOffset(session);
    return {
      status: 204,
      headers: {
        'Upload-Offset': String(offset),
        ...Object.fromEntries([toUploadCompleteHeader(isComplete, version)]),
        ...(session.length !== null && { 'Upload-Length': String(session.length) }),
        'Upload-Limit': this.getUploadLimit(version, session),
        'Cache-Control': 'no-store',
      },
    };
  }

  async cancelUpload(auth: AuthDto, id: string): Promise<ResumableUploadResponse> {
    const session = await this.getSession(auth, id);
    await this.stopActive(session.id);
    await this.removeSession(session);
    return { status: 204, headers: {} };
  }

  @OnJob({ name: JobName.UploadSessionCleanup, queue: QueueName.BackgroundTask })
  async handleUploadSessionCleanup(): Promise<JobStatus> {
    for (const session of await this.uploadSessionRepository.getExpired(new Date())) {
      try {
        await this.removeSession(session);
      } catch (error) {
        this.logger.warn(`Unable to remove expired upload ${session.id}: ${error}`);
      }
    }
    return JobStatus.Success;
  }

  /**
   * Receive content for an upload at `offset`. Parts are written once more than a part has arrived: the last part of a
   * file is written differently (as the last, and encrypted with the trailer), so a part is only written once it is
   * certain not to be the last one.
   */
  private async append(
    auth: AuthDto,
    initial: Session,
    body: Readable,
    complete: boolean,
    offset = 0,
  ): Promise<ResumableUploadResponse> {
    await this.stopActive(initial.id);
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => (resolveDone = resolve));
    this.active.set(initial.id, { abort: () => body.destroy(new Error('replaced by a newer request')), done });

    try {
      let session = initial;
      const version = session.interopVersion ?? LATEST_INTEROP_VERSION;
      const expected = await this.getOffset(session);
      if (offset !== expected) {
        body.resume();
        return problem(409, mismatchingOffsetProblem(expected, offset), { 'Upload-Offset': String(expected) });
      }

      const store = this.getStore(this.toBackendId(session));
      const upload = this.toBlobUpload(session);
      const hash = await ResumableSha1.create(session.hashState);
      let tail = await this.openTail(session);

      try {
        for await (const value of body as AsyncIterable<Buffer>) {
          await tail.write(value);
          while (tail.length > session.partSize) {
            ({ session, tail } = await this.commitPart(session, store, upload, hash, tail));
          }
        }
      } catch (error) {
        await tail.close();
        if (error instanceof BlobUploadNotFoundError) {
          return this.restart(session, version);
        }
        // the client went away, or a newer request replaced this one: what arrived is kept for resuming
        const received = await this.getOffset(session);
        this.logger.debug(`Upload ${session.id} was interrupted at ${received}: ${error}`);
        return problem(400, { message: 'The upload was interrupted' }, { 'Upload-Offset': String(received) });
      }
      await tail.close();

      const received = Number(session.committedOffset) + tail.length;
      if (session.length !== null && received > session.length) {
        return problem(400, inconsistentLengthProblem());
      }
      if (!complete) {
        await this.uploadSessionRepository.update(session.id, { expiresAt: this.getExpiry() });
        return {
          status: 204,
          headers: {
            'Upload-Offset': String(received),
            ...Object.fromEntries([toUploadCompleteHeader(false, version)]),
            'Upload-Limit': this.getUploadLimit(version, session),
          },
        };
      }
      if (session.length !== null && received !== session.length) {
        return problem(400, inconsistentLengthProblem());
      }

      try {
        return await this.complete(auth, session, store, upload, hash, version);
      } catch (error) {
        if (error instanceof BlobUploadNotFoundError) {
          return this.restart(session, version);
        }
        throw error;
      }
    } finally {
      this.active.delete(initial.id);
      resolveDone();
    }
  }

  /** Write the first part of the staged bytes to the backend and record it; the rest moves to a new staging file */
  private async commitPart(session: Session, store: BlobStore, upload: BlobUpload, hash: ResumableSha1, tail: Tail) {
    const data = await tail.read(0, session.partSize);
    const number = session.parts.length + 1;
    const part = await store.uploadPart(session.key, upload, { number, data });

    const offset = Number(session.committedOffset) + data.length;
    hash.update(data);
    // the rest is in place before the offset moves, so a crash in between loses nothing
    const next = await this.createTail(session.id, offset, await tail.read(data.length, tail.length - data.length));
    const updated = await this.uploadSessionRepository.update(session.id, {
      parts: [...session.parts, part],
      committedOffset: offset,
      hashState: hash.save(),
      expiresAt: this.getExpiry(),
    });
    await tail.close();
    await rm(tail.path, { force: true });
    return { session: updated, tail: next };
  }

  private async complete(
    auth: AuthDto,
    session: Session,
    store: BlobStore,
    upload: BlobUpload,
    hash: ResumableSha1,
    version: number,
  ): Promise<ResumableUploadResponse> {
    const path = this.tailPath(session.id, Number(session.committedOffset));
    const data = await readFile(path).catch(() => Buffer.alloc(0));
    const size = Number(session.committedOffset) + data.length;
    const checksum = hash.update(data).digest();
    const assetData = session.assetData as UploadAssetData & { path: string };

    if (session.declaredChecksum && !session.declaredChecksum.equals(checksum)) {
      await this.removeSession(session);
      return problem(400, { message: 'The uploaded file does not match its declared SHA-1 (Repr-Digest)' });
    }

    const manifest = { path: assetData.path, ownerId: session.ownerId, originalFileName: assetData.filename };
    const last = await store.uploadPart(session.key, upload, {
      number: session.parts.length + 1,
      data,
      last: { size, sha1: checksum, manifest },
    });
    await store.completeUpload(session.key, upload, [...session.parts, last]);
    await rm(path, { force: true });

    // on a backend the original is stored already; without one it is at its upload path, as an upload always was
    const stored: StoredFile | undefined = this.isBuiltin(session)
      ? undefined
      : { backendId: session.backendId, key: session.key, size, checksum, encryption: session.encryption };
    const owner = await this.userRepository.get(session.ownerId, { withDeleted: false });
    if (!owner) {
      throw new NotFoundException('The owner of the upload no longer exists');
    }
    const result = await BaseService.create(AssetMediaService, this).uploadAsset(
      { ...auth, user: { ...auth.user, quotaUsageInBytes: owner.quotaUsageInBytes } },
      {
        filename: assetData.filename,
        fileCreatedAt: new Date(assetData.fileCreatedAt),
        fileModifiedAt: new Date(assetData.fileModifiedAt),
        duration: assetData.duration,
        isFavorite: assetData.isFavorite,
        visibility: assetData.visibility as AssetVisibility | undefined,
        livePhotoVideoId: assetData.livePhotoVideoId,
      },
      { uuid: session.key, checksum, originalPath: assetData.path, originalName: assetData.filename, size },
      undefined,
      { stored },
    );

    await this.uploadSessionRepository.update(session.id, {
      status: UploadSessionStatus.Completed,
      length: size,
      assetId: result.id,
      hashState: null,
      expiresAt: this.getExpiry(),
    });
    return {
      status: 200,
      headers: { 'Upload-Offset': String(size), ...Object.fromEntries([toUploadCompleteHeader(true, version)]) },
      body: result,
    };
  }

  /**
   * The backend dropped the upload (services do not promise to keep unfinished uploads): start again with a new one,
   * and tell the client to send the file from the beginning
   */
  private async restart(session: Session, version: number): Promise<ResumableUploadResponse> {
    this.logger.warn(`The storage backend dropped upload ${session.id}; it starts again from the beginning`);
    const store = this.getStore(this.toBackendId(session));
    const upload = await store.createUpload(session.key, { partSize: session.partSize });
    await this.removeTails(session.id);
    await this.uploadSessionRepository.update(session.id, {
      blobUploadId: upload.uploadId,
      encryption: upload.encryption ?? null,
      parts: [],
      committedOffset: 0,
      hashState: null,
      expiresAt: this.getExpiry(),
    });
    return problem(409, mismatchingOffsetProblem(0, Number(session.committedOffset)), {
      'Upload-Offset': '0',
      ...Object.fromEntries([toUploadCompleteHeader(false, version)]),
    });
  }

  /** What was recorded, and the bytes after it that wait in the staging file */
  private async getOffset(session: Session) {
    const offset = Number(session.committedOffset);
    const tail = await stat(this.tailPath(session.id, offset)).catch(() => null);
    return offset + (tail?.size ?? 0);
  }

  private async getSession(auth: AuthDto, id: string) {
    const session = await this.uploadSessionRepository.get(id);
    if (!session || session.ownerId !== auth.user.id) {
      throw new NotFoundException('Upload not found');
    }
    return session;
  }

  private async removeSession(session: Session) {
    if (session.status === UploadSessionStatus.Receiving) {
      await this.getStore(this.toBackendId(session)).abortUpload(session.key, this.toBlobUpload(session));
    }
    await this.removeTails(session.id);
    await this.uploadSessionRepository.delete(session.id);
  }

  /** Stop a request that is still receiving content for an upload, which a newer request replaces */
  private async stopActive(id: string) {
    const active = this.active.get(id);
    if (!active) {
      return;
    }
    active.abort();
    await Promise.race([active.done, new Promise((resolve) => setTimeout(resolve, REPLACED_REQUEST_TIMEOUT_MS))]);
  }

  private async requireQuotaForUpload(auth: AuthDto, length: number) {
    const owner = await this.userRepository.get(auth.user.id, { withDeleted: false });
    const quota = owner?.quotaSizeInBytes ?? null;
    if (quota === null) {
      return;
    }
    // uploads still being received have their declared length set aside
    const reserved = await this.uploadSessionRepository.getReservedBytes(auth.user.id);
    if (quota < (owner?.quotaUsageInBytes ?? 0) + reserved + length) {
      throw new BadRequestException('Quota has been exceeded!');
    }
  }

  private getAssetData(headers: IncomingHttpHeaders): UploadAssetData {
    const value = headers[UPLOAD_ASSET_DATA_HEADER];
    if (typeof value !== 'string') {
      throw new ResumableUploadHeaderError(`${UPLOAD_ASSET_DATA_HEADER} is missing`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    } catch {
      throw new ResumableUploadHeaderError(`${UPLOAD_ASSET_DATA_HEADER} must be base64url encoded JSON`);
    }
    const result = AssetDataSchema.safeParse(parsed);
    if (!result.success) {
      throw new ResumableUploadHeaderError(
        `Invalid ${UPLOAD_ASSET_DATA_HEADER}: ${result.error.issues.map(({ path, message }) => `${path.join('.')}: ${message}`).join(', ')}`,
      );
    }
    return result.data;
  }

  private getUploadLimit(version = LATEST_INTEROP_VERSION, session?: Session) {
    const { uploadMaxAppendSize } = this.configRepository.getEnv().storage;
    const maxAge = session
      ? (new Date(session.expiresAt).getTime() - Date.now()) / 1000
      : UPLOAD_SESSION_MAX_AGE_MS / 1000;
    return toUploadLimitHeader({ minSize: 0, maxAppendSize: uploadMaxAppendSize, maxAge }, version);
  }

  private getExpiry() {
    return new Date(Date.now() + UPLOAD_SESSION_MAX_AGE_MS);
  }

  private isBuiltin(session: Session) {
    return session.backendId === BuiltinStorageBackend.Media;
  }

  private toBackendId(session: Session) {
    return this.isBuiltin(session) ? undefined : session.backendId;
  }

  private getStore(backendId?: string): BlobStore {
    return backendId
      ? this.storageBackendRepository.getWriteStore(backendId)
      : this.storageBackendRepository.get(BuiltinStorageBackend.Media);
  }

  private toBlobUpload(session: Session): BlobUpload {
    return {
      uploadId: session.blobUploadId,
      partSize: session.partSize,
      ...(session.encryption && { encryption: session.encryption }),
    };
  }

  private toBadRequest(error: unknown) {
    if (error instanceof ResumableUploadHeaderError) {
      return problem(400, { message: error.message });
    }
    throw error;
  }

  // staging files: the bytes after the committed offset, named with the offset they start at

  private get tailFolder() {
    return join(StorageCore.getMediaLocation(), STAGING_FOLDER, 'uploads');
  }

  private tailPath(id: string, offset: number) {
    return join(this.tailFolder, `${id}.${offset}`);
  }

  private async openTail(session: Session): Promise<Tail> {
    await mkdir(this.tailFolder, { recursive: true });
    return Tail.open(this.tailPath(session.id, Number(session.committedOffset)));
  }

  private async createTail(id: string, offset: number, data: Buffer) {
    const tail = await Tail.open(this.tailPath(id, offset));
    await tail.write(data);
    return tail;
  }

  private async removeTails(id: string) {
    const names = await readdir(this.tailFolder).catch(() => [] as string[]);
    for (const name of names) {
      if (name.startsWith(`${id}.`)) {
        await rm(join(this.tailFolder, name), { force: true });
      }
    }
  }
}

/** A staging file that content is appended to */
class Tail {
  private constructor(
    readonly path: string,
    private file: Awaited<ReturnType<typeof open>>,
    public length: number,
  ) {}

  static async open(path: string) {
    const file = await open(path, 'a+');
    const { size } = await file.stat();
    return new Tail(path, file, size);
  }

  async write(data: Buffer) {
    await this.file.write(data, 0, data.length, null);
    this.length += data.length;
  }

  async read(position: number, length: number) {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await this.file.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead);
  }

  close() {
    return this.file.close().catch(() => {});
  }
}
