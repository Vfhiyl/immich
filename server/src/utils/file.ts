import { NotFoundException, StreamableFile } from '@nestjs/common';
import { NextFunction, Response } from 'express';
import { access, constants } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { CacheControl } from 'src/enum.js';
import { BlobRange } from 'src/repositories/blob-store.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { RemoteBlob } from 'src/repositories/storage-backend.repository.js';
import { ImmichReadStream } from 'src/repositories/storage.repository.js';
import { onRouteError } from 'src/utils/logger.js';

export function getFileNameWithoutExtension(path: string): string {
  return basename(path, getFilenameExtension(path));
}

export function getFilenameExtension(path: string) {
  const extension = extname(path);
  if (!extension && path.startsWith('.') && !path.includes('.', 1)) {
    return path;
  }
  return extension;
}

export function getLivePhotoMotionFilename(stillName: string, motionName: string) {
  return getFileNameWithoutExtension(stillName) + getFilenameExtension(motionName);
}

export class ImmichFileResponse {
  /** The local file to send, or for a blob its logical path */
  public readonly path!: string;
  /** A blob on a backend that does not keep files locally, streamed instead of the path */
  public readonly blob?: RemoteBlob;
  public readonly contentType!: string;
  public readonly cacheControl!: CacheControl;
  public readonly fileName?: string;

  constructor(response: ImmichFileResponse) {
    Object.assign(this, response);
  }
}
type SendFile = Parameters<Response['sendFile']>;
type SendFileOptions = SendFile[1];

const cacheControlHeaders: Record<CacheControl, string | null> = {
  [CacheControl.PrivateWithCache]:
    'private, max-age=86400, no-transform, stale-while-revalidate=2592000, stale-if-error=2592000',
  [CacheControl.PrivateWithoutCache]: 'private, no-cache, no-transform',
  [CacheControl.None]: null, // falsy value to prevent adding Cache-Control header
};

export const sendFile = async (
  res: Response,
  next: NextFunction,
  handler: () => Promise<ImmichFileResponse> | ImmichFileResponse,
  logger: LoggingRepository,
): Promise<void> => {
  // promisified version of 'res.sendFile' for cleaner async handling
  const _sendFile = (path: string, options: SendFileOptions) =>
    promisify<string, SendFileOptions>(res.sendFile).bind(res)(path, options);

  try {
    const file = await handler();

    if (!file.blob) {
      await access(file.path, constants.R_OK);
    }

    const cacheControlHeader = cacheControlHeaders[file.cacheControl];
    if (cacheControlHeader) {
      // set the header to Cache-Control
      res.header('Cache-Control', cacheControlHeader);
    }

    res.header('Content-Type', file.contentType);
    if (file.fileName) {
      res.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
    }

    if (file.blob) {
      return await sendBlob(res, file.blob);
    }

    return await _sendFile(file.path, { dotfiles: 'allow' });
  } catch (error: Error | any) {
    const { canWrite } = onRouteError(undefined, res, error, logger);
    if (canWrite) {
      next(new NotFoundException());
    }
  }
};

/**
 * A single byte range of a `Range` header, like `bytes=0-99`, `bytes=100-` or `bytes=-100`; null when the whole blob is
 * to be sent (no header, or a form that may be ignored, such as several ranges), or 'unsatisfiable'
 */
export const parseRange = (header: string | undefined, size: number): Required<BlobRange> | null | 'unsatisfiable' => {
  const match = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (match[1] === '' && match[2] === '')) {
    return null;
  }

  const [, start, end] = match;
  if (start === '') {
    const suffix = Number(end);
    return suffix === 0 || size === 0 ? 'unsatisfiable' : { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const range = { start: Number(start), end: end === '' ? size - 1 : Math.min(Number(end), size - 1) };
  return range.start >= size || range.end < range.start ? 'unsatisfiable' : range;
};

/**
 * Send a blob like `res.sendFile` sends a file: with ranges, HEAD and conditional requests. Keys never change, so the
 * key is a strong ETag. The read is verified against what was recorded, so a bad blob fails instead of being served.
 */
const sendBlob = async (res: Response, { store, key, expect }: RemoteBlob) => {
  const req = res.req;
  let size = expect?.size;
  if (size === undefined) {
    const stat = await store.head(key);
    size = stat?.size;
  }
  if (size === undefined) {
    throw new NotFoundException();
  }

  const etag = `"${key}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Accept-Ranges', 'bytes');
  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return;
  }

  const range = parseRange(req.headers.range, size);
  if (range === 'unsatisfiable') {
    res.status(416).setHeader('Content-Range', `bytes */${size}`).end();
    return;
  }

  if (range) {
    res.status(206).setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
  }
  res.setHeader('Content-Length', String(range ? range.end - range.start + 1 : size));
  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  const stream = await store.get(key, { range: range ?? undefined, expect });
  await pipeline(stream, res);
};

export const asStreamableFile = ({ stream, type, disposition, length }: ImmichReadStream) => {
  return new StreamableFile(stream, { type, disposition, length });
};
