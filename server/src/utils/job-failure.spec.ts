import { JobName } from 'src/enum.js';
import { JobItem } from 'src/types.js';
import { getTrackedAssetId } from 'src/utils/job-failure.js';

describe(getTrackedAssetId.name, () => {
  it('should give the asset of a job for a file', () => {
    expect(getTrackedAssetId({ name: JobName.AssetGenerateThumbnails, data: { id: 'asset-1' } })).toBe('asset-1');
    expect(getTrackedAssetId({ name: JobName.Ocr, data: { id: 'asset-1', priority: 10 } } as JobItem)).toBe('asset-1');
  });

  it('should not track other jobs', () => {
    expect(getTrackedAssetId({ name: JobName.FacialRecognition, data: { id: 'face-1' } })).toBeUndefined();
    expect(
      getTrackedAssetId({ name: JobName.AssetGenerateThumbnailsQueueAll, data: { force: false } }),
    ).toBeUndefined();
  });
});
