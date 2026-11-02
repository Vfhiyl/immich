// estimate.mjs image FILE [whole] | video FILE THREADS | preview FILE: what the server estimates the memory of decoding
// FILE to be (server/src/utils/memory-estimate.ts, from the built server), in MB
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const root = new URL('../../server/', import.meta.url).pathname;
const { estimateImageDecode, estimateVideoTranscode, estimateVideoPreview } = await import(
  `${root}dist/utils/memory-estimate.js`
);
const sharp = createRequire(`${root}package.json`)('sharp');
const [kind, file, extra] = process.argv.slice(2);
const MB = 1000 * 1000;

if (kind === 'image') {
  const metadata = await sharp(file, { limitInputPixels: false, unlimited: true }).metadata();
  const bytes = estimateImageDecode({
    format: metadata.format,
    compression: metadata.compression,
    width: metadata.width,
    height: metadata.height,
    bitsPerSample: metadata.depth === 'uchar' ? 8 : 16,
    wholeSize: extra === 'whole',
  });
  console.log(Math.round(bytes / MB));
} else {
  const [stream] = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,pix_fmt', '-of', 'json', file]),
  ).streams;
  const video = { width: stream.width, height: stream.height, bitDepth: /(9|1\d)(le|be)$/.test(stream.pix_fmt) ? 16 : 8 };
  const bytes = kind === 'preview' ? estimateVideoPreview(video) : estimateVideoTranscode({ ...video, threads: Number(extra) });
  console.log(Math.round(bytes / MB));
}
