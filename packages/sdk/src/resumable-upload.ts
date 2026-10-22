/**
 * Uploads in parts that resume where they stopped (IETF resumable uploads, as the server's `/upload` and the mobile
 * app): an interrupted connection costs at most the part in flight, and an upload of a file that is uploaded again
 * (e.g. after the page was reloaded, or the command run again) goes on where it stopped. How requests are sent and
 * where uploads in progress are kept is up to the client (the web app: XMLHttpRequest for the progress of a part,
 * IndexedDB; the CLI: fetch, a file).
 */

/** The largest part sent, when the server takes larger ones */
export const DEFAULT_PART_SIZE = 32 * 1024 * 1024;
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];

export type TransportResponse = {
  status: number;
  header: (name: string) => string | null;
  body: string;
};

export type TransportRequest = {
  method: 'OPTIONS' | 'POST' | 'HEAD' | 'PATCH';
  url: string;
  headers: Record<string, string>;
  body?: Blob;
  onProgress?: (loaded: number) => void;
  signal?: AbortSignal;
};

/** Sends a request; rejects with a {@link NetworkError} when no answer came */
export type Transport = (
  request: TransportRequest,
) => Promise<TransportResponse>;

export class NetworkError extends Error {}
export class AbortedError extends Error {}

/** Sends with fetch, in browsers and Node (without the progress of a part) */
export const fetchTransport: Transport = async ({
  method,
  url,
  headers,
  body,
  signal,
}) => {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body,
      signal,
      redirect: 'error',
    });
  } catch (error) {
    if (signal?.aborted) {
      throw new AbortedError('cancelled');
    }
    throw new NetworkError(`${method} ${url} failed: ${error}`);
  }
  try {
    return {
      status: response.status,
      header: (name) => response.headers.get(name),
      body: await response.text(),
    };
  } catch (error) {
    throw new NetworkError(`${method} ${url} failed: ${error}`);
  }
};

export type ResumableUploadSession = {
  location: string;
  size: number;
  checksum: string;
};

/** Uploads in progress, by a key of the file */
export interface SessionStore {
  get(key: string): Promise<ResumableUploadSession | undefined>;
  put(key: string, session: ResumableUploadSession): Promise<void>;
  remove(key: string): Promise<void>;
}

export class MemorySessionStore implements SessionStore {
  readonly sessions = new Map<string, ResumableUploadSession>();

  get(key: string) {
    return Promise.resolve(this.sessions.get(key));
  }

  put(key: string, session: ResumableUploadSession) {
    this.sessions.set(key, session);
    return Promise.resolve();
  }

  remove(key: string) {
    this.sessions.delete(key);
    return Promise.resolve();
  }
}

/** What describes the asset, as the server's `X-Immich-Asset-Data` takes it */
export type ResumableAssetData = {
  filename: string;
  fileCreatedAt: string;
  fileModifiedAt: string;
  isFavorite?: boolean;
  visibility?: string;
};

export type ResumableUploadResult = {
  id: string;
  status: 'created' | 'duplicate';
};

/** The upload failed for good: the server rejected it */
export class UploadRejectedError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** The upload stopped and can go on: no answer came after several tries */
export class UploadInterruptedError extends Error {}

class Retry extends Error {}

const toBase64 = (hex: string) => {
  let binary = '';
  for (let i = 0; i < hex.length; i += 2) {
    binary += String.fromCodePoint(Number.parseInt(hex.slice(i, i + 2), 16));
  }
  return btoa(binary);
};

const toBase64Url = (text: string) => {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
};

const messageOf = (response: TransportResponse) => {
  try {
    const json = JSON.parse(response.body) as { message?: unknown };
    if (typeof json.message === 'string') {
      return json.message;
    }
  } catch {
    // not JSON
  }
  return response.body || `The server answered ${response.status}`;
};

const resultOf = (response: TransportResponse): ResumableUploadResult => {
  const json = JSON.parse(response.body) as { id?: unknown; status?: unknown };
  if (typeof json.id !== 'string') {
    throw new UploadRejectedError(
      `The server answered without the uploaded asset: ${response.body}`,
      response.status,
    );
  }
  return {
    id: json.id,
    status: json.status === 'duplicate' ? 'duplicate' : 'created',
  };
};

export class ResumableUploader {
  #options = new Map<string, Promise<{ maxAppendSize?: number } | undefined>>();

  constructor(
    private readonly transport: Transport = fetchTransport,
    private readonly sessions: SessionStore = new MemorySessionStore(),
    private readonly retryDelays: number[] = RETRY_DELAYS_MS,
    private readonly maxPartSize = DEFAULT_PART_SIZE,
  ) {}

  /** Whether the server takes resumable uploads, and the largest part it takes; asked once per server */
  getOptions(baseUrl: string) {
    let options = this.#options.get(baseUrl);
    if (!options) {
      options = this.transport({
        method: 'OPTIONS',
        url: `${baseUrl}/upload`,
        headers: {},
      })
        .then((response) => {
          const limit = response.header('Upload-Limit');
          if (
            response.status < 200 ||
            response.status > 299 ||
            limit === null
          ) {
            return;
          }
          const maxAppendSize = limit
            .split(',')
            .map((member) => member.trim().split('='))
            .find(([name]) => name === 'max-append-size')?.[1];
          return {
            maxAppendSize: maxAppendSize
              ? Number.parseInt(maxAppendSize)
              : undefined,
          };
        })
        .catch(() => {
          // asked again next time
          this.#options.delete(baseUrl);
          return undefined;
        });
      this.#options.set(baseUrl, options);
    }
    return options;
  }

  async upload({
    baseUrl,
    file,
    checksum,
    assetData,
    sessionKey,
    onProgress,
    signal,
  }: {
    baseUrl: string;
    file: Blob;
    /** SHA-1 of the file, in hex */
    checksum: string;
    assetData: ResumableAssetData;
    sessionKey: string;
    onProgress?: (loaded: number, total: number) => void;
    signal?: AbortSignal;
  }): Promise<ResumableUploadResult> {
    const options = await this.getOptions(baseUrl);
    const partSize = Math.min(
      options?.maxAppendSize ?? this.maxPartSize,
      this.maxPartSize,
    );
    const size = file.size;
    const resolve = (location: string) =>
      new URL(location, new URL(baseUrl, globalThis.location?.href)).href;

    let session = await this.sessions.get(sessionKey);
    if (session && (session.size !== size || session.checksum !== checksum)) {
      // the file changed since: its upload cannot go on
      await this.sessions.remove(sessionKey);
      session = undefined;
    }

    const send = async (request: TransportRequest) => {
      if (signal?.aborted) {
        throw new AbortedError('cancelled');
      }
      try {
        return await this.transport({ ...request, signal });
      } catch (error) {
        if (error instanceof NetworkError) {
          throw new Retry(error.message);
        }
        throw error;
      }
    };

    for (let attempt = 0; ; attempt++) {
      try {
        if (!session) {
          const response = await send({
            method: 'POST',
            url: `${baseUrl}/upload`,
            headers: {
              // the content follows in parts, so that the upload is known before any of it is sent
              'Upload-Complete': '?0',
              'Upload-Length': String(size),
              'Repr-Digest': `sha=:${toBase64(checksum)}:`,
              'X-Immich-Asset-Data': toBase64Url(JSON.stringify(assetData)),
            },
          });
          if (response.status === 200) {
            // the user has this file already
            return resultOf(response);
          }
          const location = response.header('Location');
          if (response.status >= 500) {
            throw new Retry(`the server answered ${response.status}`);
          }
          if (response.status !== 201 || !location) {
            throw new UploadRejectedError(messageOf(response), response.status);
          }
          session = { location, size, checksum };
          await this.sessions.put(sessionKey, session);
        }

        const state = await send({
          method: 'HEAD',
          url: resolve(session.location),
          headers: {},
        });
        if (state.status === 404 || state.status === 410) {
          // the server no longer knows the upload, e.g. it expired: start again
          await this.sessions.remove(sessionKey);
          session = undefined;
          continue;
        }
        let offset = Number.parseInt(state.header('Upload-Offset') ?? '');
        if (state.status < 200 || state.status > 299 || Number.isNaN(offset)) {
          throw new Retry(
            `the server answered ${state.status} when asked how far the upload is`,
          );
        }
        const assetId =
          state.header('Upload-Complete') === '?1'
            ? state.header('X-Immich-Asset-Id')
            : null;
        if (assetId) {
          await this.sessions.remove(sessionKey);
          return { id: assetId, status: 'created' };
        }

        while (true) {
          onProgress?.(offset, size);
          const end = Math.min(offset + partSize, size);
          const isLast = end === size;
          const start = offset;
          const response = await send({
            method: 'PATCH',
            url: resolve(session.location),
            headers: {
              'Content-Type': 'application/partial-upload',
              'Upload-Offset': String(offset),
              'Upload-Complete': isLast ? '?1' : '?0',
            },
            body: file.slice(offset, end),
            onProgress: (loaded) => onProgress?.(start + loaded, size),
          });
          if (isLast && (response.status === 200 || response.status === 201)) {
            await this.sessions.remove(sessionKey);
            return resultOf(response);
          }
          if ([200, 201, 204].includes(response.status)) {
            offset =
              Number.parseInt(response.header('Upload-Offset') ?? '') || end;
            // an answer arrived: the next failure gets the shortest pause again
            attempt = 0;
            continue;
          }
          if ([409, 404, 410].includes(response.status)) {
            // the server has another offset than this page thought, or lost the upload: ask it
            throw new Retry(`the server answered ${response.status}`);
          }
          if (response.status >= 500) {
            throw new Retry(`the server answered ${response.status}`);
          }
          // e.g. the content did not match its SHA-1: the server dropped the upload
          await this.sessions.remove(sessionKey);
          throw new UploadRejectedError(messageOf(response), response.status);
        }
      } catch (error) {
        if (!(error instanceof Retry)) {
          throw error;
        }
        if (attempt >= this.retryDelays.length) {
          throw new UploadInterruptedError(
            `Upload interrupted: ${error.message}`,
          );
        }
        await new Promise((resolve) =>
          setTimeout(resolve, this.retryDelays[attempt]),
        );
      }
    }
  }
}
