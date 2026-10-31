const MiB = 1024 * 1024;

/**
 * The peak memory (bytes) of making the image the files of a photo are made from (immich-thumbnail, a process of its
 * own) and of encoding them (sharp, in this process), by what libvips calls its loader and the photo's size. Measured
 * (cos-design/background-admission.md, tmp/measure): the photos of phones are read from top to bottom with the
 * memory of a few hundred lines; some formats are decoded whole (AVIF, JPEG XL, WebP, RAW as large as it is, and those
 * of ImageMagick), about as many bytes a pixel as below. Unknown: decoded whole, 16 bytes a pixel
 */
export const estimateImageDecode = ({
  format,
  width,
  height,
  bitsPerSample = 8,
  compression,
  wholeSize = false,
}: {
  format?: string;
  /** Of a HEIF: hevc or av1 */
  compression?: string;
  width?: number;
  height?: number;
  bitsPerSample?: number;
  /** Not made smaller: a full-size image */
  wholeSize?: boolean;
}) => {
  if (!width || !height) {
    return 576 * MiB;
  }
  const pixels = width * height;
  // what this process takes to encode the files: 25-50 MB, and of a full-size image about half a byte a pixel
  // (200 MP 200 MB)
  const encode = 64 * MiB + (wholeSize ? pixels * 0.5 : 0);
  const deep = bitsPerSample > 8;
  let decode: number;
  switch (format) {
    case 'jpeg':
    case 'png': {
      decode = 48 * MiB + pixels * 0.25;
      break;
    }
    case 'heif': {
      if (compression === 'av1') {
        // AVIF: a single image, decoded whole (17 bytes a pixel at 10 bits)
        decode = 64 * MiB + pixels * (deep ? 18 : 9);
      } else {
        // HEIC: the photos of phones are grids of tiles, decoded a row of them at a time (patches/libvips/0003): it
        // grows with the width (48 MP 65 MB, 200 MP 88 MB, 15360 wide 147 MB)
        decode = 64 * MiB + width * 8 * 1024;
      }
      break;
    }
    case 'dcraw': {
      // half its size (patches/libvips/0005) unless as large as it is (patches/libvips/0006: 13 bytes a pixel)
      decode = 48 * MiB + pixels * (wholeSize ? 14 : 4);
      break;
    }
    case 'jxl':
    case 'webp': {
      decode = 32 * MiB + pixels * (deep ? 12 : 6);
      break;
    }
    default: {
      decode = 64 * MiB + pixels * 16;
    }
  }
  return Math.max(decode, encode);
};

/**
 * The peak memory (bytes) of ffmpeg decoding a video of `width` x `height` and encoding it with `threads` threads
 * (0: as many as cores, `cores`). Measured (cos-design/background-admission.md): about 9 frames of the input, and for
 * each thread beyond the first some 30 MB and 3 frames, up to 8 more threads (beyond, ffmpeg's frame threads do not
 * grow): a 4K HEVC video of 10 bits 247 MB with one thread, 449 MB with 4, 1 GB with 32
 */
export const estimateVideoTranscode = ({
  width,
  height,
  bitDepth = 8,
  threads,
}: {
  width: number;
  height: number;
  bitDepth?: number;
  threads: number;
}) => {
  const frame = width * height * 1.5 * (bitDepth > 8 ? 2 : 1);
  const extra = Math.min(Math.max(threads - 1, 0), 8);
  return 48 * MiB + frame * 9 + extra * (30 * MiB + frame * 3);
};

/**
 * The peak memory (bytes) of ffmpeg picking the frame of a video its preview is made from (decoding with one thread):
 * the thumbnail filter keeps 12 frames to compare them (a 4K HEVC video of 10 bits 428 MB, of 8 bits 120-140 MB)
 */
export const estimateVideoPreview = ({
  width,
  height,
  bitDepth = 8,
}: {
  width: number;
  height: number;
  bitDepth?: number;
}) => 48 * MiB + width * height * 1.5 * (bitDepth > 8 ? 2 : 1) * 17;

/** The threads ffmpeg may use for a video within `bytes` (at least 1, at most `cores`): for its `threads` setting 0 */
export const fitThreads = (
  video: { width: number; height: number; bitDepth?: number },
  cores: number,
  bytes: number,
) => {
  let threads = Math.max(1, cores);
  while (threads > 1 && estimateVideoTranscode({ ...video, threads }) > bytes) {
    threads--;
  }
  return threads;
};
