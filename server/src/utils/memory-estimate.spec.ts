import {
  estimateImageDecode,
  estimateVideoPreview,
  estimateVideoTranscode,
  fitThreads,
} from 'src/utils/memory-estimate.js';

const MB = 1000 * 1000;

// What was measured (cos-design/background-admission.md): the estimates must not be below it, nor far above
const within = (estimate: number, measured: number) => {
  expect(estimate).toBeGreaterThanOrEqual(measured * MB);
  expect(estimate).toBeLessThanOrEqual(measured * MB * 3);
};

describe('estimating the memory of making the files of a photo', () => {
  it('should cover what was measured, and what this process takes to encode the files after', () => {
    // the program (in a process of its own, gone when the files are encoded), or some 50 MB to encode them
    within(estimateImageDecode({ format: 'jpeg', width: 8064, height: 6048 }), 50);
    within(estimateImageDecode({ format: 'jpeg', width: 16_320, height: 12_240 }), 71);
    within(estimateImageDecode({ format: 'png', width: 7000, height: 5000 }), 50);
    within(estimateImageDecode({ format: 'heif', compression: 'hevc', width: 8064, height: 6048 }), 65);
    within(estimateImageDecode({ format: 'heif', compression: 'hevc', width: 16_320, height: 12_240 }), 88);
    within(estimateImageDecode({ format: 'heif', compression: 'hevc', width: 15_360, height: 8640 }), 147);
    within(
      estimateImageDecode({ format: 'heif', compression: 'av1', width: 3681, height: 5594, bitsPerSample: 10 }),
      362,
    );
    within(estimateImageDecode({ format: 'jxl', width: 5667, height: 3685, bitsPerSample: 16 }), 241);
    within(estimateImageDecode({ format: 'dcraw', width: 6240, height: 4160 }), 145);
  });

  it('should cover the full-size image of a RAW file, decoded whole', () => {
    within(estimateImageDecode({ format: 'dcraw', width: 6000, height: 4000, wholeSize: true }), 305);
  });

  it('should take an image of unknown size or format as large', () => {
    expect(estimateImageDecode({})).toBeGreaterThanOrEqual(512 * MB);
    expect(estimateImageDecode({ format: 'tiff', width: 8000, height: 6000 })).toBeGreaterThanOrEqual(768 * MB);
  });
});

describe('estimating the memory of ffmpeg', () => {
  it('should cover what was measured, by threads', () => {
    within(estimateVideoTranscode({ width: 1920, height: 1080, threads: 1 }), 68);
    within(estimateVideoTranscode({ width: 1920, height: 1080, threads: 4 }), 144);
    within(estimateVideoTranscode({ width: 3840, height: 2160, threads: 1 }), 155);
    within(estimateVideoTranscode({ width: 3840, height: 2160, threads: 4 }), 332);
    within(estimateVideoTranscode({ width: 3840, height: 2160, bitDepth: 10, threads: 1 }), 247);
    within(estimateVideoTranscode({ width: 3840, height: 2160, bitDepth: 10, threads: 4 }), 449);
    within(estimateVideoTranscode({ width: 3840, height: 2160, bitDepth: 10, threads: 32 }), 1039);
  });

  it('should cover picking the frame of a preview, with one thread', () => {
    within(estimateVideoPreview({ width: 3840, height: 2160, bitDepth: 10 }), 428);
    within(estimateVideoPreview({ width: 3840, height: 2160 }), 136);
    within(estimateVideoPreview({ width: 1920, height: 1080 }), 65);
  });

  it('should fit the threads in the memory there is, at least one', () => {
    const video = { width: 3840, height: 2160, bitDepth: 10 };

    expect(fitThreads(video, 32, 8000 * MB)).toBe(32);
    expect(fitThreads(video, 32, estimateVideoTranscode({ ...video, threads: 4 }))).toBe(4);
    expect(fitThreads(video, 32, 100 * MB)).toBe(1);
    expect(fitThreads(video, 1, 8000 * MB)).toBe(1);
  });
});
