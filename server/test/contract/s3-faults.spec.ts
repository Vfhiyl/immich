import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { BlobIntegrityError, BlobNotFoundError } from 'src/repositories/blob-store.js';
import { S3BlobStore, S3_PART_SIZE } from 'src/repositories/s3-blob-store.js';
import {
  FaultProxy,
  isCompleteMultipartUpload,
  isGetObject,
  isPutObject,
  isUploadPart,
} from 'test/contract/fault-proxy.js';
import { S3Target, toClient } from 'test/contract/servers.js';

/**
 * The S3 blob store must cope with every way the minimum common contract allows a service to behave. A proxy in front
 * of a real service injects those behaviors.
 */
const sha1 = (value: Buffer) => createHash('sha1').update(value).digest();
const toStream = (value: Buffer) => Readable.from([value]);

const [target]: S3Target[] = JSON.parse(process.env.CONTRACT_S3_TARGETS ?? '[]');

describe('S3 blob store against a misbehaving service', () => {
  let proxy: FaultProxy;
  let store: S3BlobStore;
  let direct: S3BlobStore;

  beforeAll(async () => {
    proxy = await FaultProxy.start(target.endpoint);
  });

  afterAll(async () => {
    await proxy.stop();
  });

  beforeEach(() => {
    proxy.reset();
    const prefix = `faults-${randomUUID()}/`;
    const proxied = { ...target, endpoint: proxy.endpoint };
    // short timeouts and backoff, so that retries happen quickly
    store = new S3BlobStore(
      toClient(proxied, { requestHandler: { socketTimeout: 1000, connectionTimeout: 2000 }, maxAttempts: 4 }),
      target.bucket,
      prefix,
    );
    direct = new S3BlobStore(toClient(target), target.bucket, prefix);
  });

  it('should retry when the service is throttling', async () => {
    proxy.inject(isPutObject, { kind: 'error', status: 503, code: 'SlowDown' }, 2);

    const content = randomBytes(100);
    await expect(store.put('throttled', toStream(content))).resolves.toEqual({ size: 100, sha1: sha1(content) });
    await expect(buffer(await direct.get('throttled'))).resolves.toEqual(content);
  });

  it('should fail a read that is cut off before the announced length', async () => {
    const content = randomBytes(1000);
    await direct.put('cut-off', toStream(content));
    proxy.inject(isGetObject, { kind: 'truncate', keepContentLength: true }, 10);

    await expect(store.get('cut-off').then((stream) => buffer(stream))).rejects.toThrow();
  });

  it('should fail a read that is shorter than the recorded size, even if the service claims it is complete', async () => {
    const content = randomBytes(1000);
    await direct.put('short', toStream(content));
    proxy.inject(isGetObject, { kind: 'truncate', keepContentLength: false });

    await expect(store.get('short', { expect: { size: 1000 } })).rejects.toThrow(BlobIntegrityError);
  });

  it('should fail a read whose content does not match the recorded checksum', async () => {
    const content = randomBytes(1000);
    await direct.put('corrupt', toStream(content));

    const stream = await store.get('corrupt', { expect: { size: 1000, sha1: sha1(randomBytes(1000)) } });
    await expect(buffer(stream)).rejects.toThrow('checksum mismatch');
  });

  it('should not return the whole blob for a range the service ignored', async () => {
    await direct.put('ranged', toStream(Buffer.from('0123456789')));
    proxy.inject(isGetObject, { kind: 'ignore-range' });

    await expect(store.get('ranged', { range: { start: 2, end: 5 } })).rejects.toThrow(BlobIntegrityError);
  });

  it('should report a blob that is not readable yet after it was written as missing, not as an error', async () => {
    await store.put('just-written', toStream(Buffer.from('new')));
    proxy.inject(isGetObject, { kind: 'error', status: 404, code: 'NoSuchKey' });

    await expect(store.get('just-written')).rejects.toThrow(BlobNotFoundError);
    await expect(buffer(await store.get('just-written'))).resolves.toEqual(Buffer.from('new'));
  });

  it('should fail and abort an upload whose completion answers 200 with an error', async () => {
    proxy.inject(isCompleteMultipartUpload, { kind: 'ok-with-error', code: 'InternalError' }, 10);

    await expect(store.put('complete-error', toStream(randomBytes(S3_PART_SIZE + 10)))).rejects.toThrow();

    await expect(direct.head('complete-error')).resolves.toBeNull();
    expect(proxy.requests.filter(({ method, query }) => method === 'DELETE' && query.has('uploadId'))).toHaveLength(1);
  });

  it('should fail an upload that expired while its parts were sent', async () => {
    proxy.inject((request) => isUploadPart(request) && request.query.get('partNumber') === '2', {
      kind: 'error',
      status: 404,
      code: 'NoSuchUpload',
    });

    await expect(store.put('expired', toStream(randomBytes(S3_PART_SIZE + 10)))).rejects.toThrow();
    await expect(direct.head('expired')).resolves.toBeNull();
  });

  it('should accept an upload whose completion timed out but succeeded', async () => {
    // the first completion reaches the service but its answer arrives too late; the retry finds no upload left
    proxy.inject(isCompleteMultipartUpload, { kind: 'delay', ms: 3000 });
    const content = randomBytes(S3_PART_SIZE + 10);

    await expect(store.put('slow-complete', toStream(content))).resolves.toEqual({
      size: content.length,
      sha1: sha1(content),
    });
    expect(proxy.requests.filter(isCompleteMultipartUpload).length).toBeGreaterThan(1);
    const read = await buffer(await direct.get('slow-complete'));
    expect(read.equals(content)).toBe(true);
  });
});
