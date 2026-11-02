import { Injectable } from '@nestjs/common';
import { ExifDateTime, WriteTags, exiftool } from 'exiftool-vendored';
import ffmpeg, { FfprobeData, FfprobeStream } from 'fluent-ffmpeg';
import { camelCase, upperFirst } from 'lodash-es';
import { Duration } from 'luxon';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';
import sharp, { Sharp } from 'sharp';
import type {
  Bitmap,
  DecodeToBufferOptions,
  GenerateThumbhashOptions,
  GenerateThumbnailOptions,
  ImageDimensions,
  ProbeOptions,
  RawImageInfo,
  ShrinkOptions,
  TranscodeCommand,
  TransformOptions,
  VideoInfo,
  VideoPacketInfo,
  VideoStreamInfo,
} from 'src/types.js';
import { ORIENTATION_TO_SHARP_ROTATION } from 'src/constants.js';
import { Exif } from 'src/database.js';
import { AssetEditActionItem } from 'src/dtos/editing.dto.js';
import {
  AacProfile,
  Av1Profile,
  ColorMatrix,
  ColorPrimaries,
  ColorTransfer,
  Colorspace,
  DvProfile,
  DvSignalCompatibility,
  H264Profile,
  HevcProfile,
  LogLevel,
  RawExtractedFormat,
} from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { getDerivedScale } from 'src/utils/derived-size.js';
import { JobRetryLater, getJobRetryData } from 'src/utils/job-retry.js';
import { AdmissionPriority, AdmissionTimeout, MemoryAdmission } from 'src/utils/memory-admission.js';
import {
  estimateImageDecode,
  estimateVideoPreview,
  estimateVideoTranscode,
  fitThreads,
} from 'src/utils/memory-estimate.js';
import { handlePromiseError } from 'src/utils/misc.js';
import { OutputTail } from 'src/utils/output-tail.js';
import { STALL_MS, watchProgress } from 'src/utils/progress-watchdog.js';
import { readCpuLimit } from 'src/utils/server-resources.js';
import { createAffineMatrix, getOutputDimensions } from 'src/utils/transform.js';

const probe = (input: string, options: string[]): Promise<FfprobeData> =>
  new Promise((resolve, reject) =>
    // eslint-disable-next-line import-x/no-named-as-default-member
    ffmpeg.ffprobe(input, options, (error, data) => (error ? reject(error) : resolve(data))),
  );

const pascalCase = (str: string) => upperFirst(camelCase(str.toLowerCase()));

/** Immich's program that makes the image the preview and the thumbnail are made from (native/thumbnail in the repository) */
const THUMBNAIL_PROGRAM = join(dirname(import.meta.filename), '../../native/bin/immich-thumbnail');
/** An image made smaller larger than this stays in its file, mapped into memory as it is read (a long screenshot) */
const MAPPED_DECODE_BYTES = 16 * 1024 * 1024;
/** https://www.libvips.org/API/current/file-format.html: the pixels follow a header of 64 bytes */
const VIPS_FILE_HEADER_BYTES = 64;

type ProgressEvent = {
  frames: number;
  currentFps: number;
  currentKbps: number;
  targetSize: number;
  timemark: string;
  percent?: number;
};

export type ExtractResult = {
  buffer: Buffer;
  format: RawExtractedFormat;
};

type Matrix2 = [[number, number], [number, number]];

const multiply = (m: Matrix2, n: Matrix2): Matrix2 => [
  [m[0][0] * n[0][0] + m[0][1] * n[1][0], m[0][0] * n[0][1] + m[0][1] * n[1][1]],
  [m[1][0] * n[0][0] + m[1][1] * n[1][0], m[1][0] * n[0][1] + m[1][1] * n[1][1]],
];

/**
 * The turn (clockwise) and mirroring (left to right, done first) that make the matrix of edits, as sharp's affine takes
 * it ([[a, b], [c, d]]: x' = a x + b y, y' = c x + d y). Edits turn by quarters and mirror only
 */
const toQuarterTurns = ({ a, b, c, d }: { a: number; b: number; c: number; d: number }) => {
  const target: Matrix2 = [
    [Math.round(a), Math.round(b)],
    [Math.round(c), Math.round(d)],
  ];
  // sharp's rotate(90) is the affine [[0, -1], [1, 0]], its flop [[-1, 0], [0, 1]]
  const quarter: Matrix2 = [
    [0, -1],
    [1, 0],
  ];
  const mirror: Matrix2 = [
    [-1, 0],
    [0, 1],
  ];
  let turn: Matrix2 = [
    [1, 0],
    [0, 1],
  ];
  for (const angle of [0, 90, 180, 270]) {
    for (const flop of [false, true]) {
      const matrix = flop ? multiply(turn, mirror) : turn;
      if (matrix.flat().every((value, index) => value === target.flat()[index])) {
        return { angle, flop };
      }
    }
    turn = multiply(quarter, turn);
  }
  throw new Error(`Not a quarter turn: ${JSON.stringify(target)}`);
};

/** How long a job waits for the memory of its heavy work before it lets the next job of its queue run (see admit) */
const ADMISSION_WAIT_MS = 30 * 1000;
/** When a job put back for memory is taken again */
const ADMISSION_RETRY_DELAY_MS = 60 * 1000;

/** The size of the frames of a video, in bits of a sample (10 for yuv420p10le) */
const videoSize = ({ width, height, pixelFormat }: VideoStreamInfo) => ({
  width,
  height,
  bitDepth: /(9|1\d)(le|be)$/.test(pixelFormat) ? 16 : 8,
});

@Injectable()
export class MediaRepository {
  /** The heavy operations of this process: decoding images, running ffmpeg (see admitImage) */
  private admission = new MemoryAdmission();

  constructor(private logger: LoggingRepository) {
    this.logger.setContext(MediaRepository.name);
    // eslint-disable-next-line import-x/no-named-as-default-member
    sharp.concurrency(0);
    // eslint-disable-next-line import-x/no-named-as-default-member
    sharp.cache({ files: 0 });
  }

  /**
   *
   * @param input file path to the input image
   * @returns ExtractResult if succeeded, or null if failed
   */
  async extract(input: string): Promise<ExtractResult | null> {
    for (const { tag, format } of [
      { tag: 'JpgFromRaw2', format: RawExtractedFormat.Jpeg },
      { tag: 'JpgFromRaw', format: RawExtractedFormat.Jpeg },
      { tag: 'PreviewJXL', format: RawExtractedFormat.Jxl },
      { tag: 'PreviewImage', format: RawExtractedFormat.Jpeg },
    ]) {
      try {
        const buffer = await exiftool.extractBinaryTagToBuffer(tag, input);
        this.logger.debug(`Successfully extracted ${tag} buffer from image`);
        return { buffer, format };
      } catch (error: any) {
        this.logger.debug(`Could not extract ${tag} buffer from image: ${error}`);
      }
    }
    return null;
  }

  async writeExif(tags: Partial<Exif>, output: string): Promise<boolean> {
    try {
      const tagsToWrite: WriteTags = {
        ExifImageWidth: tags.exifImageWidth,
        ExifImageHeight: tags.exifImageHeight,
        DateTimeOriginal: tags.dateTimeOriginal && ExifDateTime.fromMillis(tags.dateTimeOriginal.getTime()),
        ModifyDate: tags.modifyDate && ExifDateTime.fromMillis(tags.modifyDate.getTime()),
        TimeZone: tags.timeZone,
        GPSLatitude: tags.latitude,
        GPSLongitude: tags.longitude,
        ProjectionType: tags.projectionType,
        City: tags.city,
        Country: tags.country,
        Make: tags.make,
        Model: tags.model,
        LensModel: tags.lensModel,
        Fnumber: tags.fNumber?.toFixed(1),
        FocalLength: tags.focalLength?.toFixed(1),
        ISO: tags.iso,
        ExposureTime: tags.exposureTime,
        ProfileDescription: tags.profileDescription,
        ColorSpace: tags.colorspace,
        Rating: tags.rating === null ? 0 : tags.rating,
        // specially convert Orientation to numeric Orientation# for exiftool
        'Orientation#': tags.orientation ? Number(tags.orientation) : undefined,
      };

      await exiftool.write(output, tagsToWrite, {
        ignoreMinorErrors: true,
        writeArgs: ['-overwrite_original'],
      });
      return true;
    } catch (error: any) {
      this.logger.warn(`Could not write exif data to image: ${error.message}`);
      return false;
    }
  }

  async copyTagGroup(tagGroup: string, source: string, target: string): Promise<boolean> {
    try {
      await exiftool.write(
        target,
        {},
        {
          ignoreMinorErrors: true,
          writeArgs: ['-TagsFromFile', source, `-${tagGroup}:all>${tagGroup}:all`, '-overwrite_original'],
        },
      );
      return true;
    } catch (error: any) {
      this.logger.warn(`Could not copy tag data to image: ${error.message}`);
      return false;
    }
  }

  async decodeImage(input: string | Buffer, options: DecodeToBufferOptions): Promise<Bitmap> {
    // a photo, made smaller or as large as it is, upright as its orientation tag says, is read in one pass, with the
    // memory of a few hundred of its lines, by a program of its own: as sharp would, but without decoding it whole first
    const { size, orientation } = options;
    if (typeof input === 'string' && orientation === undefined) {
      return this.decodeByProgram(input, size || 0, options);
    }
    const decoded = await this.getImageDecodingPipeline(input, options).raw().toBuffer({ resolveWithObject: true });
    return await this.transform(decoded, { size, fit: options.shortSide ? 'outside' : 'derived' });
  }

  /**
   * The photo with `size` as its shorter side (no larger than it is), or as large as it is (0), made by immich-thumbnail
   * in a process of its own, into a file of the system's temporary directory. A large one (the preview of a long
   * screenshot is up to 16 MP, a full-size image up to 200 MP) stays there, its pixels mapped into memory when read
   * rather than copied, until `releaseImage` removes it
   */
  private async decodeByProgram(
    input: string,
    size: number,
    { colorspace, processInvalidImages, shortSide }: DecodeToBufferOptions,
  ) {
    const directory = await fs.mkdtemp(join(tmpdir(), 'immich-thumbnail-'));
    const file = join(directory, 'image.v');
    const args = [input, String(size), colorspace === Colorspace.Srgb ? 'srgb' : 'p3', '--output', file];
    if (processInvalidImages) {
      args.push('--process-invalid');
    }
    if (shortSide) {
      args.push('--short-side');
    }
    try {
      const info = await new Promise<RawImageInfo>((resolve, reject) => {
        const child = spawn(THUMBNAIL_PROGRAM, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        const stdout: Buffer[] = [];
        const stderr = new OutputTail();
        // stopped when it makes no progress for a while (see watchProgress)
        let stalled = false;
        const watch = watchProgress(child.pid, () => {
          stalled = true;
          child.kill('SIGKILL');
        });
        child.stdout.on('data', (chunk: Buffer) => void stdout.push(chunk));
        child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
        child.on('error', (error) => {
          watch.stop();
          reject(error);
        });
        child.on('close', (code, signal) => {
          watch.stop();
          if (stalled) {
            return reject(
              new Error(`immich-thumbnail made no progress for ${STALL_MS / 60_000} minutes and was stopped`),
            );
          }
          if (code !== 0) {
            return reject(new Error(`immich-thumbnail exited with ${code ?? signal}: ${stderr.toString().trim()}`));
          }
          // a line of JSON: the size of the image in the file
          resolve(JSON.parse(Buffer.concat(stdout).toString()) as RawImageInfo);
        });
      });
      const length = info.width * info.height * info.channels;
      if (length > MAPPED_DECODE_BYTES) {
        return { data: Buffer.alloc(0), info, file } satisfies Bitmap;
      }
      // small: read into memory (each of the files made from it would open the file again, which takes more)
      const data = Buffer.alloc(length);
      await using handle = await fs.open(file);
      // a file of libvips: a header of 64 bytes, then the pixels
      await handle.read(data, 0, length, VIPS_FILE_HEADER_BYTES);
      await fs.rm(directory, { recursive: true, force: true });
      return { data, info } satisfies Bitmap;
    } catch (error) {
      await fs.rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  /**
   * Waits until there is the memory of making the files of the photo `input` (decoding it, and encoding its files),
   * estimated by its format and size (a header read only), beside the other heavy operations of this process; the
   * memory is given back when the result is disposed. `wholeSize`: decoded as large as it is (a full-size image)
   */
  async admitImage(
    input: string | Buffer,
    { wholeSize = false, size, priority }: { wholeSize?: boolean; size?: number; priority: AdmissionPriority },
  ): Promise<AsyncDisposable> {
    const metadata = await sharp(input, { limitInputPixels: false, unlimited: true })
      .metadata()
      .catch(() => null);
    const bytes = estimateImageDecode({
      format: metadata?.format,
      compression: metadata?.compression,
      width: metadata?.width,
      height: metadata?.height,
      bitsPerSample: metadata?.depth === 'uchar' || metadata?.depth === 'char' ? 8 : 16,
      wholeSize,
      size,
    });
    return this.admit(bytes, priority);
  }

  /**
   * Waits until there is the memory of ffmpeg decoding and encoding `video` with `threads` threads (see admitImage).
   * With `threads` 0 (as many as there are cores), `fitThreads` first
   */
  admitVideo(video: VideoStreamInfo, threads: number, priority: AdmissionPriority): Promise<AsyncDisposable> {
    return this.admit(estimateVideoTranscode({ ...videoSize(video), threads }), priority);
  }

  /** Waits until there is the memory of ffmpeg picking the frame of `video` its preview is made from (see admitImage) */
  admitVideoPreview(video: VideoStreamInfo, priority: AdmissionPriority): Promise<AsyncDisposable> {
    return this.admit(estimateVideoPreview(videoSize(video)), priority);
  }

  /** The threads ffmpeg may use for `video` within the memory there is now (its threads setting 0: automatic) */
  async fitThreads(video: VideoStreamInfo): Promise<number> {
    const [{ cores }, bytes] = await Promise.all([readCpuLimit(), this.admission.capacity()]);
    return fitThreads(videoSize(video), Math.floor(cores), bytes);
  }

  /**
   * In a job, waits for the memory up to ADMISSION_WAIT_MS, then puts the job back in its queue (JobRetryLater), so
   * that the next job of its queue runs meanwhile; it keeps when it began to wait, and once it waited long enough, the
   * memory is kept for it (see MemoryAdmission). Outside of a job (the api) it waits until admitted
   */
  private async admit(bytes: number, priority: AdmissionPriority): Promise<AsyncDisposable> {
    const job = getJobRetryData();
    const since = job?.admissionWaitingSince ?? Date.now();
    let release: () => void;
    try {
      release = await this.admission.acquire(bytes, priority, job ? { since, waitLimitMs: ADMISSION_WAIT_MS } : {});
    } catch (error) {
      if (error instanceof AdmissionTimeout) {
        throw new JobRetryLater('Waiting for memory', ADMISSION_RETRY_DELAY_MS, { admissionWaitingSince: since });
      }
      throw error;
    }
    return { [Symbol.asyncDispose]: () => Promise.resolve(release()) };
  }

  /** Frees what an image decoded by decodeImage holds beyond its memory: the file of its pixels */
  async releaseImage(image: Bitmap): Promise<void> {
    if (image.file) {
      await fs.rm(dirname(image.file), { recursive: true, force: true });
    }
  }

  /**
   * The image edited and made the size of a preview (getDerivedScale), the image the preview, the thumbnail and the
   * thumbhash of a photo are made from. Of an image kept in a file (a photo as large as it is), by immich-thumbnail from
   * the file: sharp would resize it in linear light with the memory of hundreds of its lines (190 MB for a width of
   * 16320, 60 MB in the program). Release it with `releaseImage`
   */
  async shrinkImage(image: Bitmap, { size, colorspace, edits = [] }: ShrinkOptions): Promise<Bitmap> {
    if (!image.file) {
      return this.transform(image, { size, edits });
    }
    if (edits.length === 0) {
      return this.decodeByProgram(image.file, size, { colorspace, processInvalidImages: false });
    }
    // the edits (a crop, quarter turns and mirroring: no pixel is made anew) as a file of its own
    const directory = await fs.mkdtemp(join(tmpdir(), 'immich-edited-'));
    try {
      const edited = join(directory, 'image.v');
      await this.edit(this.raw(image), edits).toFile(edited);
      return await this.decodeByProgram(edited, size, { colorspace, processInvalidImages: false });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }

  private edit(pipeline: Sharp, edits: AssetEditActionItem[]): Sharp {
    const crop = edits.find((edit) => edit.action === 'crop');
    if (crop) {
      pipeline = pipeline.extract({
        left: Math.round(crop.parameters.x),
        top: Math.round(crop.parameters.y),
        width: Math.round(crop.parameters.width),
        height: Math.round(crop.parameters.height),
      });
    }

    const affineEditOperations = edits.filter((edit) => edit.action !== 'crop');
    if (affineEditOperations.length > 0) {
      // quarter turns and mirroring, as sharp's exact operations: its affine moves the image by a pixel, losing a row
      // or column of it and leaving a black one at the other edge
      const { angle, flop } = toQuarterTurns(createAffineMatrix(affineEditOperations));
      // (sharp mirrors before it turns, whatever the order of the calls)
      if (flop) {
        pipeline = pipeline.flop();
      }
      if (angle !== 0) {
        pipeline = pipeline.rotate(angle);
      }
    }

    return pipeline;
  }

  async generateThumbnail(image: Bitmap, options: GenerateThumbnailOptions, output: string): Promise<void> {
    const transformed = await this.transform(image, options);
    await this.tag(transformed, options.colorspace)
      .toFormat(options.format, {
        quality: options.quality,
        // this is default in libvips (except the threshold is 90), but we need to set it manually in sharp
        chromaSubsampling: options.quality >= 80 ? '4:4:4' : '4:2:0',
        progressive: options.progressive,
      })
      .toFile(output);
  }

  private getImageDecodingPipeline(input: string | Buffer, options: DecodeToBufferOptions) {
    // some invalid images can still be processed by sharp, but we want to fail on them by default to avoid crashes
    let pipeline = this.encoded(input, options.processInvalidImages ? 'none' : 'error')
      .pipelineColorspace(this.getPipelineColorspace(options.colorspace))
      .withIccProfile(options.colorspace);

    const { angle, flip, flop } = options.orientation ? ORIENTATION_TO_SHARP_ROTATION[options.orientation] : {};
    pipeline = pipeline.rotate(angle);
    if (flip) {
      pipeline = pipeline.flip();
    }

    if (flop) {
      pipeline = pipeline.flop();
    }

    return pipeline;
  }

  private getPipelineColorspace(colorspace: string) {
    return colorspace === Colorspace.Srgb ? 'srgb' : 'rgb16';
  }

  /* Resamples in linear light; averaging gamma-encoded values darkens the result and loses detail. `colorspace`
   * always has a sRGB transfer function and scRGB applies no primaries matrix, so linearising as sRGB is exact. */
  private transform(image: Bitmap, { size, fit = 'derived', edits = [] }: TransformOptions): Promise<Bitmap> {
    if (!size && edits.length === 0) {
      return Promise.resolve(image);
    }

    let pipeline = this.edit(this.raw(image).pipelineColorspace('scrgb'), edits);
    if (size && fit === 'derived') {
      // the size of a preview or thumbnail (see getDerivedScale), with one scale for both sides
      const edited = getOutputDimensions(edits, image.info);
      const short = Math.min(edited.width, edited.height);
      const long = Math.max(edited.width, edited.height);
      const scale = getDerivedScale(edited, size);
      if (scale >= size / short && short > size) {
        pipeline = pipeline.resize(size, size, { fit: 'outside', withoutEnlargement: true });
      } else if (scale < size / short && Math.round(long * scale) < long - 1) {
        const target = Math.round(long * scale);
        pipeline = pipeline.resize(target, target, { fit: 'inside', withoutEnlargement: true });
      } else if (edits.length === 0) {
        // already that size (the preview made by immich-thumbnail): the same pixels, not a copy of them
        return Promise.resolve(image);
      }
    } else if (size && fit !== 'derived') {
      pipeline = pipeline.resize(size, size, { fit, withoutEnlargement: true });
    }
    return pipeline.raw().toBuffer({ resolveWithObject: true });
  }

  private raw({ data, info: raw, file }: Bitmap) {
    if (file) {
      return sharp(file, { limitInputChannels: false, limitInputPixels: false, unlimited: true });
    }
    return sharp(data, { raw, limitInputChannels: false, limitInputPixels: false, unlimited: true });
  }

  private encoded(image: string | Buffer, failOn: 'none' | 'error') {
    return sharp(image, { failOn, limitInputChannels: false, limitInputPixels: false, unlimited: true });
  }

  /** Re-attaches the profile, converting nothing: the pixels are already in that colourspace. */
  private tag(image: Bitmap, colorspace: string): Sharp {
    return this.raw(image).pipelineColorspace(this.getPipelineColorspace(colorspace)).withIccProfile(colorspace);
  }

  async generateThumbhash(image: Bitmap, options: GenerateThumbhashOptions): Promise<Buffer> {
    const { rgbaToThumbHash } = await import('thumbhash');

    const transformed = await this.transform(image, { edits: options.edits, fit: 'inside', size: 100 });

    const { data, info } = await sharp(transformed.data, { raw: transformed.info })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    return Buffer.from(rgbaToThumbHash(info.width, info.height, data));
  }

  async probe(input: string, options?: ProbeOptions): Promise<VideoInfo> {
    const results = await probe(input, options?.countFrames ? ['-count_packets'] : []); // gets frame count quickly: https://stackoverflow.com/a/28376817
    return {
      format: {
        formatName: results.format.format_name,
        formatLongName: results.format.format_long_name,
        duration: this.parseFloat(results.format.duration),
        bitrate: this.parseInt(results.format.bit_rate),
      },
      videoStreams: results.streams
        .filter((stream) => stream.codec_type === 'video' && !stream.disposition?.attached_pic)
        .sort((a, b) => this.compareStreams(a, b))
        .map((stream) => {
          const height = this.parseInt(stream.height);
          const dar = this.getDar(stream.display_aspect_ratio);
          return {
            index: stream.index,
            height,
            width: dar ? Math.round(height * dar) : this.parseInt(stream.width),
            codecName: stream.codec_name === 'h265' ? 'hevc' : (stream.codec_name ?? null),
            profile: this.parseVideoProfile(stream.codec_name, stream.profile as string | undefined) ?? null,
            level: this.parseOptionalInt(stream.level),
            frameCount: this.parseInt(options?.countFrames ? stream.nb_read_packets : stream.nb_frames),
            frameRate: this.parseFrameRate(stream.avg_frame_rate ?? stream.r_frame_rate),
            timeBase: this.parseRational(stream.time_base)?.den ?? null,
            rotation: this.parseInt(stream.rotation),
            bitrate: this.parseInt(stream.bit_rate),
            pixelFormat: stream.pix_fmt || 'yuv420p',
            colorPrimaries: this.parseEnum(ColorPrimaries, stream.color_primaries) ?? ColorPrimaries.Unknown,
            colorMatrix: this.parseEnum(ColorMatrix, stream.color_space) ?? ColorMatrix.Unknown,
            colorTransfer: this.parseEnum(ColorTransfer, stream.color_transfer) ?? ColorTransfer.Unknown,
            dvProfile: this.parseOptionalInt(stream.dv_profile) as DvProfile | null,
            dvLevel: this.parseOptionalInt(stream.dv_level),
            dvBlSignalCompatibilityId: this.parseOptionalInt(
              stream.dv_bl_signal_compatibility_id,
            ) as DvSignalCompatibility | null,
          };
        }),
      audioStreams: results.streams
        .filter((stream) => stream.codec_type === 'audio' && stream.codec_name !== 'unknown')
        .sort((a, b) => this.compareStreams(a, b))
        .map((stream) => ({
          index: stream.index,
          codecName: stream.codec_name ?? null,
          profile:
            stream.codec_name === 'aac' ? this.parseEnum(AacProfile, stream.profile as string | undefined) : null,
          bitrate: this.parseInt(stream.bit_rate),
        })),
    };
  }

  /**
   * Needed for accurate segments, especially when remuxing, seeking and/or VFR is involved.
   * Scanning packets for keyframes in JS is much faster than -skip_frame nokey since it avoids decoding the video.
   */
  probePackets(input: string, streamIndex: number): Promise<VideoPacketInfo | null> {
    const ffprobe = spawn(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        String(streamIndex),
        '-show_entries',
        'packet=pts,duration,flags',
        '-of',
        'csv=p=0',
        input,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let totalDuration = 0;
    const keyframePts: number[] = [];
    const keyframeAccDuration: number[] = [];
    const keyframeOwnDuration: number[] = [];
    const postDiscard: { pts: number; duration: number }[] = [];
    const parseLine = (line: string) => {
      if (!line) {
        return;
      }
      const [ptsStr, durationStr, flags] = line.split(',', 3);
      const pts = Number.parseInt(ptsStr);
      const duration = Number.parseInt(durationStr);
      if (Number.isNaN(pts) || Number.isNaN(duration) || !flags) {
        return;
      }
      // Discarded packets don't contribute to packet count, but still contribute to video duration
      totalDuration += duration;
      if (flags[1] !== 'D') {
        postDiscard.push({ pts, duration });
      }

      if (flags[0] !== 'K') {
        return;
      }

      keyframePts.push(pts);
      keyframeAccDuration.push(totalDuration);
      // VFR content can have variable duration keyframes,
      // so we need to track their duration separately for accurate segment boundaries.
      // Non-keyframes are accounted for in totalDuration.
      keyframeOwnDuration.push(duration);
    };

    const stderr = new OutputTail();
    let remainder = '';
    ffprobe.stderr.setEncoding('utf8');
    ffprobe.stderr.on('data', (chunk: string) => stderr.push(chunk));
    ffprobe.stdout.setEncoding('utf8');
    ffprobe.stdout.on('data', (chunk: string) => {
      const lines = chunk.split('\n');
      lines[0] = remainder + lines[0];
      remainder = lines.pop() as string;
      for (const line of lines) {
        parseLine(line);
      }
    });

    return new Promise<VideoPacketInfo | null>((resolve, reject) => {
      ffprobe.on('error', reject);
      ffprobe.on('close', (code) => {
        if (code !== 0) {
          return reject(new Error(`ffprobe exited with code ${code}: ${stderr.toString().trim()}`));
        }
        parseLine(remainder);
        if (postDiscard.length === 0) {
          return resolve(null);
        }

        resolve({
          totalDuration,
          packetCount: postDiscard.length,
          outputFrames: this.cfrOutputFrames(postDiscard, postDiscard.length / totalDuration),
          keyframePts,
          keyframeAccDuration,
          keyframeOwnDuration,
        });
      });
    });
  }

  transcode(input: string, output: string | Writable, options: TranscodeCommand): Promise<void> {
    if (!options.twoPass) {
      return new Promise((resolve, reject) => {
        this.configureFfmpegCall(input, output, options)
          .on('error', reject)
          .on('end', () => resolve())
          .run();
      });
    }

    if (typeof output !== 'string') {
      throw new TypeError('Two-pass transcoding does not support writing to a stream');
    }

    // two-pass allows for precise control of bitrate at the cost of running twice
    // recommended for vp9 for better quality and compression
    return new Promise((resolve, reject) => {
      // first pass output is not saved as only the .log file is needed
      this.configureFfmpegCall(input, '/dev/null', options)
        .addOptions('-pass', '1')
        .addOptions('-passlogfile', output)
        .addOptions('-f null')
        .on('error', reject)
        .on('end', () => {
          // second pass
          this.configureFfmpegCall(input, output, options)
            .addOptions('-pass', '2')
            .addOptions('-passlogfile', output)
            .on('error', reject)
            .on('end', () => handlePromiseError(fs.unlink(`${output}-0.log`), this.logger))
            .on('end', () => handlePromiseError(fs.rm(`${output}-0.log.mbtree`, { force: true }), this.logger))
            .on('end', () => resolve())
            .run();
        })
        .run();
    });
  }

  async getImageMetadata(input: string | Buffer): Promise<ImageDimensions & { isTransparent: boolean }> {
    const { width = 0, height = 0, hasAlpha = false } = await sharp(input, { unlimited: true }).metadata();
    return { width, height, isTransparent: hasAlpha };
  }

  private configureFfmpegCall(input: string, output: string | Writable, options: TranscodeCommand) {
    const ffmpegCall = ffmpeg(input, { niceness: 10 })
      .inputOptions(options.inputOptions)
      .outputOptions(options.outputOptions)
      .output(output)
      .on('start', (command: string) => this.logger.debug(command))
      .on('error', (error, _, stderr) => this.logger.error(stderr || error));

    // stopped when it makes no progress (reads, writes, reports) for a while, however long it takes (see watchProgress)
    let watch: ReturnType<typeof watchProgress> | undefined;
    ffmpegCall
      .on('start', () => {
        const { pid } = (ffmpegCall as unknown as { ffmpegProc?: { pid?: number } }).ffmpegProc ?? {};
        watch = watchProgress(pid, () => {
          ffmpegCall.emit(
            'error',
            new Error(`ffmpeg made no progress for ${STALL_MS / 60_000} minutes and was stopped`),
          );
          ffmpegCall.kill('SIGKILL');
        });
      })
      .on('progress', () => watch?.beat())
      .on('end', () => watch?.stop())
      .on('error', () => watch?.stop());

    const { frameCount, percentInterval } = options.progress;
    const frameInterval = Math.ceil(frameCount / (100 / percentInterval));
    if (this.logger.isLevelEnabled(LogLevel.Debug) && frameCount && frameInterval) {
      let lastProgressFrame: number = 0;
      ffmpegCall.on('progress', (progress: ProgressEvent) => {
        if (progress.frames - lastProgressFrame < frameInterval) {
          return;
        }

        lastProgressFrame = progress.frames;
        const percent = ((progress.frames / frameCount) * 100).toFixed(2);
        const ms = progress.currentFps ? Math.floor((frameCount - progress.frames) / progress.currentFps) * 1000 : 0;
        const duration = ms ? Duration.fromMillis(ms).rescale().toHuman({ unitDisplay: 'narrow' }) : '';
        const outputText = output instanceof Writable ? 'stream' : output.split('/').pop();
        this.logger.debug(
          `Transcoding ${percent}% done${duration ? `, estimated ${duration} remaining` : ''} for output ${outputText}`,
        );
      });
    }

    return ffmpegCall;
  }

  private parseInt(value: string | number | undefined): number {
    return Number.parseInt(value as string) || 0;
  }

  private parseFloat(value: string | number | undefined): number {
    // eslint-disable-next-line unicorn/prefer-number-coercion
    return Number.parseFloat(value as string) || 0;
  }

  private parseOptionalInt(value: string | number | undefined): number | null {
    const parsed = Number.parseInt(value as string);
    return Number.isNaN(parsed) ? null : parsed;
  }

  private parseEnum<E extends Record<string, number | string>>(enumObj: E, value?: string) {
    return value && typeof value === 'string'
      ? ((enumObj[pascalCase(value)] as Extract<E[keyof E], number> | undefined) ?? null)
      : null;
  }

  /** Parse a rational like "60000/1001" or "1/600" into `{ num, den }`. */
  private parseRational(value: string | undefined): { num: number; den: number } | null {
    if (value) {
      const [num, den = 1] = value.split('/').map(Number);
      if (num && den) {
        return { num, den };
      }
    }
    return null;
  }

  private parseFrameRate(value: string | undefined): number | null {
    const r = this.parseRational(value);
    return r ? r.num / r.den : null;
  }

  private getDar(dar: string | undefined): number {
    if (dar) {
      const [darW, darH] = dar.split(':').map(Number);
      if (darW && darH) {
        return darW / darH;
      }
    }

    return 0;
  }

  private parseVideoProfile(codec?: string, profile?: string) {
    switch (codec) {
      case 'h264': {
        return this.parseEnum(H264Profile, profile);
      }
      case 'h265':
      case 'hevc': {
        return this.parseEnum(HevcProfile, profile);
      }
      case 'av1': {
        return this.parseEnum(Av1Profile, profile);
      }
      default: {
        return null;
      }
    }
  }

  private compareStreams(a: FfprobeStream, b: FfprobeStream): number {
    const d = (b.disposition?.default ?? 0) - (a.disposition?.default ?? 0);
    if (d !== 0) {
      return d;
    }
    return this.parseInt(b.bit_rate) - this.parseInt(a.bit_rate);
  }

  /* Ported from https://code.ffmpeg.org/FFmpeg/FFmpeg/src/commit/5c44245878e235ae64fe87fb9877644856d33d1d/fftools/ffmpeg_filter.c
   * SPDX-License-Identifier: LGPL-2.1-or-later
   * Copyright (c) FFmpeg authors and contributors — https://ffmpeg.org/
   * Modifications: TS port operating on probe-derived packet metadata rather than decoded AVFrames. */
  private cfrOutputFrames(packets: { pts: number; duration: number }[], slotsPerTick: number) {
    packets.sort((a, b) => a.pts - b.pts);
    const firstPts = packets[0].pts;
    let outputFrames = 0;
    let nextPts = 0;
    const history = [0, 0, 0];
    for (const pkt of packets) {
      const syncIpts = (pkt.pts - firstPts) * slotsPerTick;
      const duration = pkt.duration * slotsPerTick;
      let delta0 = syncIpts - nextPts;
      const delta = delta0 + duration;

      if (delta0 < 0 && delta > 0) {
        delta0 = 0;
      }

      let nb = 1;
      let nbPrev = 0;
      if (delta < -1.1) {
        nb = 0;
      } else if (delta > 1.1) {
        nb = Math.round(delta);
        if (delta0 > 1.1) {
          nbPrev = Math.round(delta0 - 0.6);
        }
      }
      outputFrames += nb;
      nextPts += nb;
      history[2] = history[1];
      history[1] = history[0];
      history[0] = nbPrev;
    }
    const median = history.sort((a, b) => a - b)[1];
    return outputFrames + median;
  }
}
