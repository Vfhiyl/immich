import { JobFailureCategory, JobHistoryRecorder, classifyJobFailure, getFailureReason } from 'src/utils/job-history.js';

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 2, 10, minutes));

describe('the history of jobs', () => {
  it('should tell the kind of a failure', () => {
    expect(classifyJobFailure(new Error('immich-thumbnail exited with 1: cannot open the photo'), false)).toBe(
      JobFailureCategory.File,
    );
    expect(classifyJobFailure(new Error('ffmpeg made no progress for 10 minutes and was stopped'), false)).toBe(
      JobFailureCategory.Stuck,
    );
    expect(classifyJobFailure(new Error('immich-thumbnail exited with SIGKILL: '), false)).toBe(
      JobFailureCategory.OutOfMemory,
    );
    expect(classifyJobFailure(new Error('failed for all URLs'), true)).toBe(JobFailureCategory.Environment);
  });

  it('should group failures by their error, without what differs from one file to another', () => {
    const a = getFailureReason(
      'immich-thumbnail exited with 1: immich-thumbnail: cannot open the photo: /data/upload/u1/a/b/IMG_1.HEIC: bad seek to 112138',
    );
    const b = getFailureReason(
      'immich-thumbnail exited with 1: immich-thumbnail: cannot open the photo: /tmp/staging/x.heic: bad seek to 7',
    );
    expect(a).toBe(b);
    expect(a).toBe(
      'immich-thumbnail exited with <n>: immich-thumbnail: cannot open the photo: <path>: bad seek to <n>',
    );
    expect(getFailureReason('Asset 0d3c5e8e-1f2a-4b3c-9d4e-5f6a7b8c9d0e not found\nat stack')).toBe(
      'Asset <id> not found',
    );
  });

  it('should count jobs per hour and job, and keep their failures, until drained', () => {
    const recorder = new JobHistoryRecorder();
    recorder.record('thumbnailGeneration', 'AssetGenerateThumbnails', 'succeeded', undefined, at(1));
    recorder.record('thumbnailGeneration', 'AssetGenerateThumbnails', 'succeeded', undefined, at(59));
    recorder.record(
      'thumbnailGeneration',
      'AssetGenerateThumbnails',
      'failed',
      { error: new Error('cannot decode'), category: JobFailureCategory.File, assetId: 'asset-1' },
      at(30),
    );
    recorder.record('smartSearch', 'SmartSearch', 'retried', undefined, at(61));

    const { counts, failures } = recorder.drain();

    expect(counts).toEqual([
      {
        hour: '2026-11-02T10:00:00.000Z',
        jobName: 'AssetGenerateThumbnails',
        queueName: 'thumbnailGeneration',
        succeeded: 2,
        failed: 1,
        retried: 0,
      },
      {
        hour: '2026-11-02T11:00:00.000Z',
        jobName: 'SmartSearch',
        queueName: 'smartSearch',
        succeeded: 0,
        failed: 0,
        retried: 1,
      },
    ]);
    expect(failures).toEqual([
      {
        createdAt: at(30),
        jobName: 'AssetGenerateThumbnails',
        queueName: 'thumbnailGeneration',
        assetId: 'asset-1',
        category: JobFailureCategory.File,
        reason: 'cannot decode',
        error: 'cannot decode',
      },
    ]);
    expect(recorder.drain()).toEqual({ counts: [], failures: [] });
  });

  it('should count a flood of failures, keeping only some of them until written', () => {
    const recorder = new JobHistoryRecorder();
    for (let index = 0; index < 1500; index++) {
      recorder.record('ocr', 'Ocr', 'failed', { error: new Error('x'), category: JobFailureCategory.File });
    }
    const { counts, failures } = recorder.drain();
    expect(counts[0].failed).toBe(1500);
    expect(failures).toHaveLength(1000);
  });
});
