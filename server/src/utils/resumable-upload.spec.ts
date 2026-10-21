import {
  ResumableUploadHeaderError,
  getDeclaredSha1,
  getInteropVersion,
  getUploadComplete,
  getUploadLength,
  getUploadOffset,
  mismatchingOffsetProblem,
  toUploadCompleteHeader,
  toUploadLimitHeader,
} from 'src/utils/resumable-upload.js';

describe('resumable upload headers', () => {
  describe(getInteropVersion.name, () => {
    it('should read a supported version', () => {
      expect(getInteropVersion({ 'upload-draft-interop-version': '6' })).toBe(6);
      expect(getInteropVersion({ 'upload-draft-interop-version': '10' })).toBe(10);
      expect(getInteropVersion({})).toBeUndefined();
    });

    it('should reject versions it does not support, and nonsense', () => {
      expect(() => getInteropVersion({ 'upload-draft-interop-version': '2' })).toThrow(ResumableUploadHeaderError);
      expect(() => getInteropVersion({ 'upload-draft-interop-version': '11' })).toThrow('not supported');
      expect(() => getInteropVersion({ 'upload-draft-interop-version': 'six' })).toThrow('non-negative integer');
    });
  });

  describe(getUploadComplete.name, () => {
    it('should read Upload-Complete', () => {
      expect(getUploadComplete({ 'upload-complete': '?1' })).toBe(true);
      expect(getUploadComplete({ 'upload-complete': '?0' }, 6)).toBe(false);
      expect(getUploadComplete({})).toBeUndefined();
    });

    it('should read the opposite Upload-Incomplete of interop 3', () => {
      expect(getUploadComplete({ 'upload-incomplete': '?1' }, 3)).toBe(false);
      expect(getUploadComplete({ 'upload-incomplete': '?0' }, 3)).toBe(true);
      // interop 3 does not know Upload-Complete
      expect(getUploadComplete({ 'upload-complete': '?1' }, 3)).toBeUndefined();
    });

    it('should reject a value that is not a boolean', () => {
      expect(() => getUploadComplete({ 'upload-complete': 'true' })).toThrow('must be ?0 or ?1');
    });
  });

  it('should read offsets and lengths', () => {
    expect(getUploadOffset({ 'upload-offset': '1048576' })).toBe(1_048_576);
    expect(getUploadLength({ 'upload-length': '0' })).toBe(0);
    expect(getUploadOffset({})).toBeUndefined();
    expect(() => getUploadOffset({ 'upload-offset': '-1' })).toThrow(ResumableUploadHeaderError);
    expect(() => getUploadLength({ 'upload-length': '12.5' })).toThrow(ResumableUploadHeaderError);
  });

  describe(getDeclaredSha1.name, () => {
    const sha1 = Buffer.from('0123456789abcdef0123456789abcdef01234567', 'hex');

    it('should read the SHA-1 among other digests', () => {
      expect(getDeclaredSha1({ 'repr-digest': `sha=:${sha1.toString('base64')}:` })).toEqual(sha1);
      expect(
        getDeclaredSha1({
          'repr-digest': `sha-256=:${Buffer.alloc(32).toString('base64')}:, sha=:${sha1.toString('base64')}:`,
        }),
      ).toEqual(sha1);
      expect(getDeclaredSha1({ 'repr-digest': `sha-256=:${Buffer.alloc(32).toString('base64')}:` })).toBeUndefined();
      expect(getDeclaredSha1({})).toBeUndefined();
    });

    it('should reject a digest that is not a SHA-1', () => {
      expect(() => getDeclaredSha1({ 'repr-digest': `sha=:${Buffer.alloc(19).toString('base64')}:` })).toThrow(
        '20-byte SHA-1',
      );
    });
  });

  it('should write Upload-Complete as the client knows it', () => {
    expect(toUploadCompleteHeader(true)).toEqual(['Upload-Complete', '?1']);
    expect(toUploadCompleteHeader(false, 6)).toEqual(['Upload-Complete', '?0']);
    expect(toUploadCompleteHeader(false, 3)).toEqual(['Upload-Incomplete', '?1']);
  });

  it('should write the limits, with the lifetime named as the client knows it', () => {
    expect(toUploadLimitHeader({ minSize: 0 })).toBe('min-size=0');
    expect(toUploadLimitHeader({ minSize: 0, maxAppendSize: 100, maxAge: 86_399.7 })).toBe(
      'min-size=0, max-append-size=100, max-age=86399',
    );
    expect(toUploadLimitHeader({ minSize: 0, maxAge: 60 }, 6)).toBe('min-size=0, expires=60');
  });

  it('should describe a mismatching offset', () => {
    expect(mismatchingOffsetProblem(10, 5)).toEqual({
      type: 'https://iana.org/assignments/http-problem-types#mismatching-upload-offset',
      title: expect.any(String),
      'expected-offset': 10,
      'provided-offset': 5,
    });
  });
});
