// Compares what the app's decoders (native/region, through ./part) make of images with what libvips makes of them
// through sharp (the server's: rotated by their orientation, colours converted to sRGB from their profile): a part at
// full size in the middle must be the same pixels (HEIC, decoded by FFmpeg and libde265 the same; JPEG within what
// libjpeg-turbo and jpegli differ by), the whole made 8 times smaller is reported (the filters differ).
// Usage: node compare-libvips.mjs PART FILE... (files neither reads, or only libvips, are listed, not failed)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(new URL('../../../server/package.json', import.meta.url));
const sharp = require('sharp');
const [part, ...files] = process.argv.slice(2);
const work = mkdtempSync(join(tmpdir(), 'compare-libvips-'));

const ours = (file, sample, x, y, w, h) => {
  const out = join(work, 'part.raw');
  execFileSync(part, [file, String(sample), String(x), String(y), String(w), String(h), out], { stdio: 'pipe' });
  const buffer = readFileSync(out);
  const [width, height, fullWidth, fullHeight] = new Int32Array(buffer.buffer, buffer.byteOffset, 4);
  return { width, height, fullWidth, fullHeight, data: buffer.subarray(16) };
};

// the differences of the colour channels of pixels opaque in both (transparent ones have no colour to compare)
const differences = (a, b) => {
  const diffs = [];
  for (let i = 0; i < a.length; i += 4) {
    if (a[i + 3] === 255 && b[i + 3] === 255) {
      diffs.push(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
    }
  }
  diffs.sort((p, q) => p - q);
  return {
    mean: diffs.length ? diffs.reduce((s, d) => s + d, 0) / diffs.length : 0,
    p999: diffs.length ? diffs[Math.floor(diffs.length * 0.999)] : 0,
  };
};

let failed = 0;
for (const file of files) {
  const name = file.split('/').slice(-2).join('/');
  let probe;
  try {
    probe = ours(file, 64, 0, 0, 0, 0);
  } catch (error) {
    const theirs = await sharp(file, { unlimited: true, limitInputPixels: false })
      .resize(64)
      .raw()
      .toBuffer()
      .then(
        () => 'libvips reads it',
        () => 'neither reads it',
      );
    console.log(`--   ${name}: ${String(error.stderr).trim()} (${theirs}; the app decodes it with the platform's decoders)`);
    continue;
  }
  const { fullWidth: W, fullHeight: H } = probe;
  const reference = sharp(file, { limitInputPixels: false, unlimited: true }).rotate();
  let ref;
  const w = Math.min(512, W);
  const h = Math.min(512, H);
  const x = Math.floor((W - w) / 2);
  const y = Math.floor((H - h) / 2);
  try {
    ref = await reference.clone().extract({ left: x, top: y, width: w, height: h }).toColourspace('srgb').ensureAlpha().raw().toBuffer();
  } catch (error) {
    console.log(`--   ${name}: libvips cannot read it (${String(error.message).split('\n')[0]})`);
    continue;
  }
  const partOurs = ours(file, 1, x, y, w, h);
  const whole = ours(file, 8, 0, 0, W, H);
  // (libvips may fail on the whole where the part was readable: a damaged file)
  const refWhole = await reference
    .clone()
    .resize(whole.width, whole.height, { fit: 'fill', kernel: 'linear' })
    .toColourspace('srgb')
    .ensureAlpha()
    .raw()
    .toBuffer()
    .catch(() => undefined);
  const meta = await sharp(file, { unlimited: true, limitInputPixels: false }).metadata();
  const full = differences(partOurs.data, ref);
  const smaller = refWhole ? differences(whole.data, refWhole) : undefined;
  // HEIC: the same pixels (rounding); JPEG: libjpeg-turbo and jpegli differ by about half a level on average
  const limit = meta.format === 'heif' ? 0.1 : 1.5;
  const ok = full.mean <= limit && full.p999 <= (meta.format === 'heif' ? 2 : 12);
  failed += ok ? 0 : 1;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${name} ${W}x${H} ${meta.format}${meta.icc ? ' icc' : ''}${meta.bitsPerSample > 8 ? ` ${meta.bitsPerSample} bit` : ''}: ` +
      `full size mean ${full.mean.toFixed(2)}, 99.9% ${full.p999}; ` +
      (smaller ? `8 times smaller mean ${smaller.mean.toFixed(2)}` : 'libvips cannot read it whole'),
  );
}
rmSync(work, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
