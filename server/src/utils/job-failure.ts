import { JobName } from 'src/enum.js';
import { JobItem } from 'src/types.js';

/**
 * The jobs for a file (whose `data.id` is the asset) that can fail on it again and again: they are tracked per asset, and
 * held back from it after a few attempts (see `JobFailureRepository`)
 */
export const TRACKED_JOBS = [
  JobName.AssetExtractMetadata,
  JobName.AssetGenerateThumbnails,
  JobName.AssetEncodeVideo,
  JobName.SmartSearch,
  JobName.AssetDetectFaces,
  JobName.Ocr,
] as const;

export type TrackedJobName = (typeof TRACKED_JOBS)[number];

const tracked = new Set<JobName>(TRACKED_JOBS);

/** The asset of a job that is tracked per asset */
export const getTrackedAssetId = (item: JobItem): string | undefined => {
  if (!tracked.has(item.name)) {
    return;
  }
  const id = (item as { data?: { id?: unknown } }).data?.id;
  return typeof id === 'string' ? id : undefined;
};
