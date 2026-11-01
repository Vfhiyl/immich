import { MachineLearningUnavailableError, isEnvironmentFailure } from 'src/utils/job-retry.js';

describe(isEnvironmentFailure.name, () => {
  it('should take the failures of where a job runs as such', () => {
    expect(isEnvironmentFailure(new MachineLearningUnavailableError('failed for all URLs'))).toBe(true);
    expect(isEnvironmentFailure(Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }))).toBe(true);
    // fetch: the error of the connection is its cause
    expect(
      isEnvironmentFailure(
        new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) }),
      ),
    ).toBe(true);
    // a storage service that is busy or broken (AWS SDK, Azure SDK)
    expect(isEnvironmentFailure(Object.assign(new Error('SlowDown'), { $metadata: { httpStatusCode: 503 } }))).toBe(
      true,
    );
    expect(isEnvironmentFailure(Object.assign(new Error('Server busy'), { statusCode: 429 }))).toBe(true);
  });

  it('should take the failures of a file as such', () => {
    expect(isEnvironmentFailure(new Error('immich-thumbnail exited with 1: cannot open the photo'))).toBe(false);
    expect(isEnvironmentFailure(Object.assign(new Error('no such file'), { code: 'ENOENT' }))).toBe(false);
    expect(isEnvironmentFailure(Object.assign(new Error('NoSuchKey'), { $metadata: { httpStatusCode: 404 } }))).toBe(
      false,
    );
    expect(isEnvironmentFailure('a string')).toBe(false);
  });
});
