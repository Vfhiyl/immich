import { IncomingHttpHeaders } from 'node:http';

/**
 * Headers of Resumable Uploads for HTTP (draft-ietf-httpbis-resumable-upload). Clients send the draft version they
 * follow as an interop version; the ones that differ in something the server reads or writes are handled here.
 *
 * - interop 3 (draft 01, iOS 17): `Upload-Incomplete`, the opposite of `Upload-Complete`
 * - interop 4 and later: `Upload-Complete`
 * - before interop 8: the lifetime in `Upload-Limit` is called `expires` rather than `max-age`
 */
export const MIN_INTEROP_VERSION = 3;
export const LATEST_INTEROP_VERSION = 10;

/** The content type of appended parts, which drafts from interop 6 on require */
export const PARTIAL_UPLOAD_CONTENT_TYPE = 'application/partial-upload';

const header = (headers: IncomingHttpHeaders, name: string) => {
  const value = headers[name];
  return Array.isArray(value) ? value.join(', ') : value;
};

/** An sf-integer that is not negative, or undefined when absent; throws for anything else */
const parseNonNegativeInteger = (value: string | undefined, name: string) => {
  if (value === undefined) {
    return;
  }
  if (!/^\d{1,15}$/.test(value.trim())) {
    throw new ResumableUploadHeaderError(`${name} must be a non-negative integer`);
  }
  return Number(value.trim());
};

const parseBoolean = (value: string | undefined, name: string) => {
  switch (value?.trim()) {
    case undefined: {
      return;
    }
    case '?1': {
      return true;
    }
    case '?0': {
      return false;
    }
    default: {
      throw new ResumableUploadHeaderError(`${name} must be ?0 or ?1`);
    }
  }
};

export class ResumableUploadHeaderError extends Error {}

/** The interop version a client follows, if it is one this server supports */
export const getInteropVersion = (headers: IncomingHttpHeaders) => {
  const version = parseNonNegativeInteger(
    header(headers, 'upload-draft-interop-version'),
    'Upload-Draft-Interop-Version',
  );
  if (version === undefined) {
    return;
  }
  if (version < MIN_INTEROP_VERSION || version > LATEST_INTEROP_VERSION) {
    throw new ResumableUploadHeaderError(
      `Upload-Draft-Interop-Version ${version} is not supported (${MIN_INTEROP_VERSION} to ${LATEST_INTEROP_VERSION})`,
    );
  }
  return version;
};

/** Whether the content of a request ends the upload; undefined when the request is not a resumable upload */
export const getUploadComplete = (headers: IncomingHttpHeaders, version = LATEST_INTEROP_VERSION) => {
  if (version <= 3) {
    const incomplete = parseBoolean(header(headers, 'upload-incomplete'), 'Upload-Incomplete');
    return incomplete === undefined ? undefined : !incomplete;
  }
  return parseBoolean(header(headers, 'upload-complete'), 'Upload-Complete');
};

export const getUploadOffset = (headers: IncomingHttpHeaders) =>
  parseNonNegativeInteger(header(headers, 'upload-offset'), 'Upload-Offset');

export const getUploadLength = (headers: IncomingHttpHeaders) =>
  parseNonNegativeInteger(header(headers, 'upload-length'), 'Upload-Length');

/** The SHA-1 a client declares in `Repr-Digest` (RFC 9530), under the `sha` key like the HTTP digest registry names it */
export const getDeclaredSha1 = (headers: IncomingHttpHeaders) => {
  const value = header(headers, 'repr-digest');
  if (!value) {
    return;
  }

  for (const member of value.split(',')) {
    const match = /^\s*sha\s*=\s*:([A-Za-z0-9+/]+={0,2}):\s*$/.exec(member);
    if (match) {
      const digest = Buffer.from(match[1], 'base64');
      if (digest.length !== 20) {
        throw new ResumableUploadHeaderError('Repr-Digest sha must be a 20-byte SHA-1');
      }
      return digest;
    }
  }
  return;
};

/** The header that ends an upload or not, as the client's draft calls it */
export const toUploadCompleteHeader = (complete: boolean, version = LATEST_INTEROP_VERSION): [string, string] =>
  version <= 3 ? ['Upload-Incomplete', complete ? '?0' : '?1'] : ['Upload-Complete', complete ? '?1' : '?0'];

export interface UploadLimits {
  minSize: number;
  maxSize?: number;
  maxAppendSize?: number;
  /** Remaining lifetime of an upload, in seconds */
  maxAge?: number;
}

/** `Upload-Limit`, an sf-dictionary of the limits that apply */
export const toUploadLimitHeader = (
  { minSize, maxSize, maxAppendSize, maxAge }: UploadLimits,
  version = LATEST_INTEROP_VERSION,
) => {
  const members = [`min-size=${minSize}`];
  if (maxSize !== undefined) {
    members.push(`max-size=${maxSize}`);
  }
  if (maxAppendSize !== undefined) {
    members.push(`max-append-size=${maxAppendSize}`);
  }
  if (maxAge !== undefined) {
    members.push(`${version < 8 ? 'expires' : 'max-age'}=${Math.max(0, Math.floor(maxAge))}`);
  }
  return members.join(', ');
};

/** Problem types of the draft, as problem details (RFC 9457) */
const problemType = (name: string) => `https://iana.org/assignments/http-problem-types#${name}`;

export const mismatchingOffsetProblem = (expected: number, provided: number) => ({
  type: problemType('mismatching-upload-offset'),
  title: 'offset from request does not match offset of resource',
  'expected-offset': expected,
  'provided-offset': provided,
});

export const completedUploadProblem = () => ({
  type: problemType('completed-upload'),
  title: 'upload is already completed',
});

export const inconsistentLengthProblem = () => ({
  type: problemType('inconsistent-upload-length'),
  title: 'inconsistent length values for upload',
});
