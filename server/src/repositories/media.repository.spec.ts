import { existsSync, mkdtempDisposableSync, readdirSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import sharp, { OutputInfo } from 'sharp';
import { AssetEditAction, AssetEditActionItem, MirrorAxis } from 'src/dtos/editing.dto.js';
import { Colorspace, ExifOrientation, ImageFormat } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { Bitmap } from 'src/types.js';
import { getDerivedDimensions } from 'src/utils/derived-size.js';
import { automock } from 'test/utils.js';

const testAssets = join(dirname(import.meta.filename), '../../../e2e/test-assets/formats');

const getPixelColor = async (buffer: Buffer, x: number, y: number) => {
  const metadata = await sharp(buffer).metadata();
  const width = metadata.width!;
  const { data } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  const idx = (y * width + x) * 4;
  return {
    r: data[idx],
    g: data[idx + 1],
    b: data[idx + 2],
  };
};

const buildTestQuadImage = async () => {
  // build a 4 quadrant image for testing mirroring
  const base = sharp({
    create: { width: 1000, height: 1000, channels: 3, background: { r: 0, g: 0, b: 0 } },
  }).png();

  const tl = await sharp({
    create: { width: 500, height: 500, channels: 3, background: { r: 255, g: 0, b: 0 } },
  })
    .png()
    .toBuffer();

  const tr = await sharp({
    create: { width: 500, height: 500, channels: 3, background: { r: 0, g: 255, b: 0 } },
  })
    .png()
    .toBuffer();

  const bl = await sharp({
    create: { width: 500, height: 500, channels: 3, background: { r: 0, g: 0, b: 255 } },
  })
    .png()
    .toBuffer();

  const br = await sharp({
    create: { width: 500, height: 500, channels: 3, background: { r: 255, g: 255, b: 0 } },
  })
    .png()
    .toBuffer();

  const image = base.composite([
    { input: tl, left: 0, top: 0 }, // top-left
    { input: tr, left: 500, top: 0 }, // top-right
    { input: bl, left: 0, top: 500 }, // bottom-left
    { input: br, left: 500, top: 500 }, // bottom-right
  ]);

  return image.png().toBuffer();
};

// the pixels of a decoded image, in its file (made smaller) or in memory
const pixels = async ({ data, file }: Bitmap) => (file ? await sharp(file).raw().toBuffer() : data);

describe(MediaRepository.name, () => {
  let sut: MediaRepository;

  beforeEach(() => {
    // eslint-disable-next-line no-sparse-arrays
    sut = new MediaRepository(automock(LoggingRepository, { args: [, { getEnv: () => ({}) }], strict: false }));
  });

  describe('edit (single actions)', () => {
    it('should apply crop edit correctly', async () => {
      const result = sut['edit'](
        sharp({
          create: {
            width: 1000,
            height: 1000,
            channels: 4,
            background: { r: 255, g: 0, b: 0, alpha: 0.5 },
          },
        }).png(),
        [
          {
            action: AssetEditAction.Crop,
            parameters: {
              x: 100,
              y: 200,
              width: 700,
              height: 300,
            },
          },
        ],
      );

      const metadata = await result.toBuffer().then((buf) => sharp(buf).metadata());
      expect(metadata.width).toBe(700);
      expect(metadata.height).toBe(300);
    });
    it('should apply rotate edit correctly', async () => {
      const result = sut['edit'](
        sharp({
          create: {
            width: 500,
            height: 1000,
            channels: 4,
            background: { r: 255, g: 0, b: 0, alpha: 0.5 },
          },
        }).png(),
        [
          {
            action: AssetEditAction.Rotate,
            parameters: {
              angle: 90,
            },
          },
        ],
      );

      const metadata = await result.toBuffer().then((buf) => sharp(buf).metadata());
      expect(metadata.width).toBe(1000);
      expect(metadata.height).toBe(500);
    });

    it('should apply mirror edit correctly', async () => {
      const resultHorizontal = sut['edit'](sharp(await buildTestQuadImage()), [
        {
          action: AssetEditAction.Mirror,
          parameters: {
            axis: MirrorAxis.Horizontal,
          },
        },
      ]);

      const bufferHorizontal = await resultHorizontal.toBuffer();
      const metadataHorizontal = await resultHorizontal.metadata();
      expect(metadataHorizontal.width).toBe(1000);
      expect(metadataHorizontal.height).toBe(1000);

      expect(await getPixelColor(bufferHorizontal, 10, 10)).toEqual({ r: 0, g: 255, b: 0 });
      expect(await getPixelColor(bufferHorizontal, 990, 10)).toEqual({ r: 255, g: 0, b: 0 });
      expect(await getPixelColor(bufferHorizontal, 10, 990)).toEqual({ r: 255, g: 255, b: 0 });
      expect(await getPixelColor(bufferHorizontal, 990, 990)).toEqual({ r: 0, g: 0, b: 255 });

      const resultVertical = sut['edit'](sharp(await buildTestQuadImage()), [
        {
          action: AssetEditAction.Mirror,
          parameters: {
            axis: MirrorAxis.Vertical,
          },
        },
      ]);

      const bufferVertical = await resultVertical.toBuffer();
      const metadataVertical = await resultVertical.metadata();
      expect(metadataVertical.width).toBe(1000);
      expect(metadataVertical.height).toBe(1000);

      // top-left should now be bottom-left (blue)
      expect(await getPixelColor(bufferVertical, 10, 10)).toEqual({ r: 0, g: 0, b: 255 });
      // top-right should now be bottom-right (yellow)
      expect(await getPixelColor(bufferVertical, 990, 10)).toEqual({ r: 255, g: 255, b: 0 });
      // bottom-left should now be top-left (red)
      expect(await getPixelColor(bufferVertical, 10, 990)).toEqual({ r: 255, g: 0, b: 0 });
      // bottom-right should now be top-right (blue)
      expect(await getPixelColor(bufferVertical, 990, 990)).toEqual({ r: 0, g: 255, b: 0 });
    });
  });

  describe('edit (multiple sequential edits)', () => {
    it('should turn and mirror every pixel exactly, in the order of the edits, after the crop', async () => {
      // 7 x 5 pixels, each of its own value
      const width = 7;
      const height = 5;
      const source = Buffer.alloc(width * height * 3);
      for (let index = 0; index < width * height; index++) {
        source.fill(index + 1, index * 3, index * 3 + 3);
      }
      const raw = { raw: { width, height, channels: 3 as const } };
      const crop = { action: AssetEditAction.Crop, parameters: { x: 1, y: 1, width: 5, height: 3 } };
      // one sharp pipeline for each step: exactly in this order
      const step = async (image: { data: Buffer; info: OutputInfo }, edit: AssetEditActionItem) => {
        let pipeline = sharp(image.data, { raw: image.info });
        switch (edit.action) {
          case AssetEditAction.Crop: {
            const { x, y, width, height } = edit.parameters;
            pipeline = pipeline.extract({ left: x, top: y, width, height });
            break;
          }
          case AssetEditAction.Rotate: {
            pipeline = pipeline.rotate(edit.parameters.angle);
            break;
          }
          case AssetEditAction.Mirror: {
            pipeline = edit.parameters.axis === MirrorAxis.Horizontal ? pipeline.flop() : pipeline.flip();
            break;
          }
          // No default
        }
        return pipeline.raw().toBuffer({ resolveWithObject: true });
      };
      const rotate = (angle: number) => ({ action: AssetEditAction.Rotate, parameters: { angle } });
      const mirror = (axis: MirrorAxis) => ({ action: AssetEditAction.Mirror, parameters: { axis } });

      for (const edits of [
        [rotate(90)],
        [rotate(180)],
        [rotate(270)],
        [mirror(MirrorAxis.Horizontal)],
        [mirror(MirrorAxis.Vertical)],
        [rotate(90), mirror(MirrorAxis.Horizontal)],
        [mirror(MirrorAxis.Horizontal), rotate(90)],
        [mirror(MirrorAxis.Vertical), rotate(270), mirror(MirrorAxis.Horizontal)],
        [crop, rotate(90), mirror(MirrorAxis.Vertical)],
        [rotate(270), crop],
      ] as AssetEditActionItem[][]) {
        // the crop first, wherever it is (its coordinates are those of the photo)
        const ordered = [
          ...edits.filter((edit) => edit.action === AssetEditAction.Crop),
          ...edits.filter((edit) => edit.action !== AssetEditAction.Crop),
        ];
        let expected = { data: source, info: { width, height, channels: 3 } as OutputInfo };
        for (const edit of ordered) {
          expected = await step(expected, edit);
        }

        const actual = await sut['edit'](sharp(source, raw), edits).raw().toBuffer({ resolveWithObject: true });

        expect([actual.info.width, actual.info.height], JSON.stringify(edits)).toEqual([
          expected.info.width,
          expected.info.height,
        ]);
        expect([...actual.data], JSON.stringify(edits)).toEqual([...expected.data]);
      }
    });

    it('should apply horizontal mirror then vertical mirror (equivalent to 180° rotation)', async () => {
      const imageBuffer = await buildTestQuadImage();
      const result = sut['edit'](sharp(imageBuffer), [
        { action: AssetEditAction.Mirror, parameters: { axis: MirrorAxis.Horizontal } },
        { action: AssetEditAction.Mirror, parameters: { axis: MirrorAxis.Vertical } },
      ]);

      const buffer = await result.png().toBuffer();
      const metadata = await sharp(buffer).metadata();
      expect(metadata.width).toBe(1000);
      expect(metadata.height).toBe(1000);

      expect(await getPixelColor(buffer, 10, 10)).toEqual({ r: 255, g: 255, b: 0 });
      expect(await getPixelColor(buffer, 990, 10)).toEqual({ r: 0, g: 0, b: 255 });
      expect(await getPixelColor(buffer, 10, 990)).toEqual({ r: 0, g: 255, b: 0 });
      expect(await getPixelColor(buffer, 990, 990)).toEqual({ r: 255, g: 0, b: 0 });
    });

    it('should apply rotate 90° then horizontal mirror', async () => {
      const imageBuffer = await buildTestQuadImage();
      const result = sut['edit'](sharp(imageBuffer), [
        { action: AssetEditAction.Rotate, parameters: { angle: 90 } },
        { action: AssetEditAction.Mirror, parameters: { axis: MirrorAxis.Horizontal } },
      ]);

      const buffer = await result.png().toBuffer();
      const metadata = await sharp(buffer).metadata();
      expect(metadata.width).toBe(1000);
      expect(metadata.height).toBe(1000);

      expect(await getPixelColor(buffer, 10, 10)).toEqual({ r: 255, g: 0, b: 0 });
      expect(await getPixelColor(buffer, 990, 10)).toEqual({ r: 0, g: 0, b: 255 });
      expect(await getPixelColor(buffer, 10, 990)).toEqual({ r: 0, g: 255, b: 0 });
      expect(await getPixelColor(buffer, 990, 990)).toEqual({ r: 255, g: 255, b: 0 });
    });

    it('should apply 180° rotation', async () => {
      const imageBuffer = await buildTestQuadImage();
      const result = sut['edit'](sharp(imageBuffer), [{ action: AssetEditAction.Rotate, parameters: { angle: 180 } }]);

      const buffer = await result.png().toBuffer();
      const metadata = await sharp(buffer).metadata();
      expect(metadata.width).toBe(1000);
      expect(metadata.height).toBe(1000);

      expect(await getPixelColor(buffer, 10, 10)).toEqual({ r: 255, g: 255, b: 0 });
      expect(await getPixelColor(buffer, 990, 10)).toEqual({ r: 0, g: 0, b: 255 });
      expect(await getPixelColor(buffer, 10, 990)).toEqual({ r: 0, g: 255, b: 0 });
      expect(await getPixelColor(buffer, 990, 990)).toEqual({ r: 255, g: 0, b: 0 });
    });

    it('should apply 270° rotations', async () => {
      const imageBuffer = await buildTestQuadImage();
      const result = sut['edit'](sharp(imageBuffer), [{ action: AssetEditAction.Rotate, parameters: { angle: 270 } }]);

      const buffer = await result.png().toBuffer();
      const metadata = await sharp(buffer).metadata();
      expect(metadata.width).toBe(1000);
      expect(metadata.height).toBe(1000);

      expect(await getPixelColor(buffer, 10, 10)).toEqual({ r: 0, g: 255, b: 0 });
      expect(await getPixelColor(buffer, 990, 10)).toEqual({ r: 255, g: 255, b: 0 });
      expect(await getPixelColor(buffer, 10, 990)).toEqual({ r: 255, g: 0, b: 0 });
      expect(await getPixelColor(buffer, 990, 990)).toEqual({ r: 0, g: 0, b: 255 });
    });

    it('should apply crop then rotate 90°', async () => {
      const imageBuffer = await buildTestQuadImage();
      const result = sut['edit'](sharp(imageBuffer), [
        { action: AssetEditAction.Crop, parameters: { x: 0, y: 0, width: 1000, height: 500 } },
        { action: AssetEditAction.Rotate, parameters: { angle: 90 } },
      ]);

      const buffer = await result.png().toBuffer();
      const metadata = await sharp(buffer).metadata();
      expect(metadata.width).toBe(500);
      expect(metadata.height).toBe(1000);

      expect(await getPixelColor(buffer, 10, 10)).toEqual({ r: 255, g: 0, b: 0 });
      expect(await getPixelColor(buffer, 10, 990)).toEqual({ r: 0, g: 255, b: 0 });
    });

    it('should apply rotate 90° then crop', async () => {
      const imageBuffer = await buildTestQuadImage();
      const result = sut['edit'](sharp(imageBuffer), [
        { action: AssetEditAction.Crop, parameters: { x: 0, y: 0, width: 500, height: 1000 } },
        { action: AssetEditAction.Rotate, parameters: { angle: 90 } },
      ]);

      const buffer = await result.png().toBuffer();
      const metadata = await sharp(buffer).metadata();
      expect(metadata.width).toBe(1000);
      expect(metadata.height).toBe(500);

      expect(await getPixelColor(buffer, 10, 10)).toEqual({ r: 0, g: 0, b: 255 });
      expect(await getPixelColor(buffer, 990, 10)).toEqual({ r: 255, g: 0, b: 0 });
    });

    it('should apply vertical mirror then horizontal mirror then rotate 90°', async () => {
      const imageBuffer = await buildTestQuadImage();
      const result = sut['edit'](sharp(imageBuffer), [
        { action: AssetEditAction.Mirror, parameters: { axis: MirrorAxis.Vertical } },
        { action: AssetEditAction.Mirror, parameters: { axis: MirrorAxis.Horizontal } },
        { action: AssetEditAction.Rotate, parameters: { angle: 90 } },
      ]);

      const buffer = await result.png().toBuffer();
      const metadata = await sharp(buffer).metadata();
      expect(metadata.width).toBe(1000);
      expect(metadata.height).toBe(1000);

      expect(await getPixelColor(buffer, 10, 10)).toEqual({ r: 0, g: 255, b: 0 });
      expect(await getPixelColor(buffer, 990, 10)).toEqual({ r: 255, g: 255, b: 0 });
      expect(await getPixelColor(buffer, 10, 990)).toEqual({ r: 255, g: 0, b: 0 });
      expect(await getPixelColor(buffer, 990, 990)).toEqual({ r: 0, g: 0, b: 255 });
    });

    it('should apply crop to single quadrant then mirror', async () => {
      const imageBuffer = await buildTestQuadImage();
      const result = sut['edit'](sharp(imageBuffer), [
        { action: AssetEditAction.Crop, parameters: { x: 0, y: 0, width: 500, height: 500 } },
        { action: AssetEditAction.Mirror, parameters: { axis: MirrorAxis.Horizontal } },
      ]);

      const buffer = await result.png().toBuffer();
      const metadata = await sharp(buffer).metadata();
      expect(metadata.width).toBe(500);
      expect(metadata.height).toBe(500);

      expect(await getPixelColor(buffer, 10, 10)).toEqual({ r: 255, g: 0, b: 0 });
      expect(await getPixelColor(buffer, 490, 10)).toEqual({ r: 255, g: 0, b: 0 });
      expect(await getPixelColor(buffer, 10, 490)).toEqual({ r: 255, g: 0, b: 0 });
      expect(await getPixelColor(buffer, 490, 490)).toEqual({ r: 255, g: 0, b: 0 });
    });

    it('should apply all operations: crop, rotate, mirror', async () => {
      const imageBuffer = await buildTestQuadImage();
      const result = sut['edit'](sharp(imageBuffer), [
        { action: AssetEditAction.Crop, parameters: { x: 0, y: 0, width: 500, height: 1000 } },
        { action: AssetEditAction.Rotate, parameters: { angle: 90 } },
        { action: AssetEditAction.Mirror, parameters: { axis: MirrorAxis.Horizontal } },
      ]);

      const buffer = await result.png().toBuffer();
      const metadata = await sharp(buffer).metadata();
      expect(metadata.width).toBe(1000);
      expect(metadata.height).toBe(500);

      expect(await getPixelColor(buffer, 10, 10)).toEqual({ r: 255, g: 0, b: 0 });
      expect(await getPixelColor(buffer, 990, 10)).toEqual({ r: 0, g: 0, b: 255 });
    });
  });

  describe('generateThumbnail', () => {
    it('should process random Authentik thumbnail image', async () => {
      const response = await fetch(
        'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NHB4IiBoZWlnaHQ9IjY0cHgiIHZpZXdCb3g9IjAgMCA2NCA2NCIgdmVyc2lvbj0iMS4xIj48cmVjdCBmaWxsPSIjMzc3YjM3IiBjeD0iMzIiIGN5PSIzMiIgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByPSIzMiIvPjx0ZXh0IHg9IjUwJSIgeT0iNTAlIiBzdHlsZT0iY29sb3I6ICNmZmY7IGxpbmUtaGVpZ2h0OiAxOyBmb250LWZhbWlseTogJ1JlZEhhdFRleHQnLCdPdmVycGFzcycsb3ZlcnBhc3MsaGVsdmV0aWNhLGFyaWFsLHNhbnMtc2VyaWY7ICIgZmlsbD0iI2ZmZiIgYWxpZ25tZW50LWJhc2VsaW5lPSJtaWRkbGUiIGRvbWluYW50LWJhc2VsaW5lPSJtaWRkbGUiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGZvbnQtc2l6ZT0iMjgiIGZvbnQtd2VpZ2h0PSI0MDAiIGR5PSIuMWVtIj5BQTwvdGV4dD48L3N2Zz4=',
      );
      const buffer = Buffer.from(await response.arrayBuffer());
      const dir = mkdtempDisposableSync(join(tmpdir(), 'media-repository-'));
      const file = join(dir.path, 'test.webp');
      const decoded = await sut.decodeImage(buffer, { colorspace: Colorspace.P3, processInvalidImages: false });
      await sut.generateThumbnail(
        decoded,
        { colorspace: Colorspace.P3, quality: 80, format: ImageFormat.Webp, processInvalidImages: false },
        file,
      );

      expect(statSync(file).blksize).toBeGreaterThan(0);
    });
  });

  // photos made smaller are read by immich-thumbnail (native/thumbnail), in one pass; the image must be the one sharp
  // makes in two (decode, then resize in linear light), but for the rounding of a few pixels
  describe('decodeImage, made smaller', () => {
    const cases = [
      { file: 'heic/IMG_2682.heic', colorspace: Colorspace.P3, size: 1440 },
      { file: 'motionphoto/samsung-one-ui-6.heic', colorspace: Colorspace.P3, size: 1440 },
      { file: 'motionphoto/pixel-8a.jpg', colorspace: Colorspace.P3, size: 1440 },
      { file: 'avif/10bit-HDR-P3-nclx.avif', colorspace: Colorspace.P3, size: 1440 },
      { file: 'webp/denali.webp', colorspace: Colorspace.Srgb, size: 250 },
      { file: 'jpg/el_torcal_rocks.jpg', colorspace: Colorspace.Srgb, size: 1440 },
      // as large as it is (the image of the full-size file)
      { file: 'heic/IMG_2682.heic', colorspace: Colorspace.P3, size: undefined },
      { file: 'motionphoto/pixel-8a.jpg', colorspace: Colorspace.Srgb, size: undefined },
    ];

    for (const { file, colorspace, size } of cases) {
      it(`should read ${file} ${size ? `at ${size}` : 'whole'} as sharp does`, async () => {
        const path = join(testAssets, file);
        const options = { colorspace, processInvalidImages: false, size };

        const smaller = await sut.decodeImage(path, options);
        // from memory, sharp reads it
        const expected = await sut.decodeImage(await readFile(path), options);

        expect(smaller.info).toEqual({
          width: expected.info.width,
          height: expected.info.height,
          channels: expected.info.channels,
        });
        const data = await pixels(smaller);
        expect(data.length).toBe(expected.data.length);
        let total = 0;
        let max = 0;
        for (let index = 0; index < data.length; index++) {
          const difference = Math.abs(data[index] - expected.data[index]);
          total += difference;
          max = Math.max(max, difference);
        }
        expect(total / data.length).toBeLessThan(0.5);
        expect(max).toBeLessThanOrEqual(5);
        await sut.releaseImage(smaller);
      });
    }

    it('should make a camera RAW file smaller from half its size, as sharp makes it from all of it', async () => {
      // 5472 x 3648: its preview is less than half of it
      const path = join(testAssets, 'raw/Canon/EOS_70D.CR2');
      const options = { colorspace: Colorspace.P3, processInvalidImages: false, size: 1440 };

      const smaller = await sut.decodeImage(path, options);
      // (sharp, from the file: LibRaw reads more of a file than of a buffer, the crop of the sensor too)
      const expected = await sut.decodeImage(path, { ...options, orientation: ExifOrientation.Horizontal });

      expect(smaller.info).toEqual({ width: 2156, height: 1440, channels: 3 });
      expect(expected.info).toMatchObject({ width: 2156, height: 1440 });
      // (each 2x2 block of the sensor a pixel, rather than demosaiced: the same picture, its fine detail sampled a
      // little elsewhere, within 2 levels on average)
      const data = await pixels(smaller);
      let total = 0;
      for (let index = 0; index < data.length; index++) {
        total += Math.abs(data[index] - expected.data[index]);
      }
      expect(total / data.length).toBeLessThan(2);
      await sut.releaseImage(smaller);
    });

    it('should read a photo that must be rotated whole as sharp does, through a file removed when released', async () => {
      const dir = mkdtempDisposableSync(join(tmpdir(), 'media-repository-'));
      const rotated = join(dir.path, 'rotated.jpg');
      // stored upright (3472 x 4624), with the tag that says to turn it a quarter clockwise
      await sharp(join(testAssets, 'motionphoto/pixel-8a.jpg')).withMetadata({ orientation: 6 }).toFile(rotated);
      const options = { colorspace: Colorspace.Srgb, processInvalidImages: false };

      const whole = await sut.decodeImage(rotated, options);
      const expected = await sut.decodeImage(await readFile(rotated), options);

      expect(whole.info).toEqual({ width: expected.info.width, height: expected.info.height, channels: 3 });
      expect(whole.info).toMatchObject({ width: 4624, height: 3472 });
      const data = await pixels(whole);
      let total = 0;
      for (let index = 0; index < data.length; index++) {
        total += Math.abs(data[index] - expected.data[index]);
      }
      expect(total / data.length).toBeLessThan(0.5);
      expect(readdirSync(dirname(whole.file!))).toEqual(['image.v']);
      await sut.releaseImage(whole);
      expect(existsSync(dirname(whole.file!))).toBe(false);
    });

    it('should shrink an edited photo kept in a file as sharp does, edited first', async () => {
      const options = { colorspace: Colorspace.P3, processInvalidImages: false };
      // as large as it is: 4624 x 3472, in a file
      const whole = await sut.decodeImage(join(testAssets, 'motionphoto/pixel-8a.jpg'), options);
      expect(whole.file).toBeDefined();
      const crop = { x: 100, y: 50, width: 3000, height: 2000 };
      const edited = await sharp(whole.file)
        .extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height })
        .raw()
        .toBuffer({ resolveWithObject: true });

      const small = await sut.shrinkImage(whole, {
        size: 1440,
        colorspace: Colorspace.P3,
        edits: [{ action: AssetEditAction.Crop, parameters: crop }] as AssetEditActionItem[],
      });
      const expected = await sut.shrinkImage(edited, { size: 1440, colorspace: Colorspace.P3 });

      expect(small.info).toEqual({ width: 2160, height: 1440, channels: 3 });
      expect(expected.info).toMatchObject({ width: 2160, height: 1440 });
      const data = await pixels(small);
      let total = 0;
      let max = 0;
      for (let index = 0; index < data.length; index++) {
        const difference = Math.abs(data[index] - expected.data[index]);
        total += difference;
        max = Math.max(max, difference);
      }
      expect(total / data.length).toBeLessThan(0.5);
      expect(max).toBeLessThanOrEqual(5);
      await sut.releaseImage(small);
      // and turned
      const turned = await sut.shrinkImage(whole, {
        size: 1440,
        colorspace: Colorspace.P3,
        edits: [
          { action: AssetEditAction.Crop, parameters: crop },
          { action: AssetEditAction.Rotate, parameters: { angle: 90 } },
        ] as AssetEditActionItem[],
      });
      expect(turned.info).toEqual({ width: 1440, height: 2160, channels: 3 });
      await sut.releaseImage(turned);
      await sut.releaseImage(whole);
    });

    it('should keep the pixels of a large image in a file, removed when released', async () => {
      const dir = mkdtempDisposableSync(join(tmpdir(), 'media-repository-'));
      const screenshot = join(dir.path, 'screenshot.png');
      await sharp({ create: { width: 1080, height: 20_000, channels: 3, background: '#336699' } })
        .png()
        .toFile(screenshot);

      const smaller = await sut.decodeImage(screenshot, {
        colorspace: Colorspace.Srgb,
        processInvalidImages: false,
        size: 1440,
      });

      expect(smaller.data.length).toBe(0);
      expect(existsSync(smaller.file!)).toBe(true);
      const data = await pixels(smaller);
      expect(data.length).toBe(885 * 16_383 * 3);
      // (through linear light and back: within a level)
      for (const [index, value] of [0x33, 0x66, 0x99].entries()) {
        expect(Math.abs(data[index] - value)).toBeLessThanOrEqual(1);
      }
      await sut.releaseImage(smaller);
      expect(existsSync(dirname(smaller.file!))).toBe(false);
    });

    it('should read the pixels of a small image into memory', async () => {
      const smaller = await sut.decodeImage(join(testAssets, 'heic/IMG_2682.heic'), {
        colorspace: Colorspace.P3,
        processInvalidImages: false,
        size: 1440,
      });

      expect(smaller.file).toBeUndefined();
      expect(smaller.data.length).toBe(smaller.info.width * smaller.info.height * smaller.info.channels);
    });

    it('should make the same files from the file as from the pixels in memory', async () => {
      const dir0 = mkdtempDisposableSync(join(tmpdir(), 'media-repository-'));
      const long = join(dir0.path, 'long.jpg');
      // a long photo, of the colours of a photo (its preview is in a file)
      await sharp(join(testAssets, 'motionphoto/pixel-8a.jpg')).resize(1200, 9000, { fit: 'fill' }).toFile(long);
      const smaller = await sut.decodeImage(long, {
        colorspace: Colorspace.P3,
        processInvalidImages: false,
        size: 1440,
      });
      expect(smaller.file).toBeDefined();
      const inMemory = { data: await pixels(smaller), info: smaller.info };
      const dir = mkdtempDisposableSync(join(tmpdir(), 'media-repository-'));
      const options = { colorspace: Colorspace.P3, processInvalidImages: false, quality: 80 };
      const edits = [
        { action: AssetEditAction.Crop, parameters: { x: 100, y: 50, width: 800, height: 6000 } },
        { action: AssetEditAction.Rotate, parameters: { angle: 90 } },
      ] as AssetEditActionItem[];

      for (const [name, generate] of [
        [
          'preview',
          (image: Bitmap, path: string) =>
            sut.generateThumbnail(image, { ...options, format: ImageFormat.Jpeg, size: 1440 }, path),
        ],
        [
          'thumbnail',
          (image: Bitmap, path: string) =>
            sut.generateThumbnail(image, { ...options, format: ImageFormat.Webp, size: 250 }, path),
        ],
        [
          'edited',
          (image: Bitmap, path: string) =>
            sut.generateThumbnail(image, { ...options, format: ImageFormat.Jpeg, size: 1440, edits }, path),
        ],
      ] as const) {
        const fromFile = join(dir.path, `${name}-file`);
        const fromMemory = join(dir.path, `${name}-memory`);
        await generate(smaller, fromFile);
        await generate(inMemory, fromMemory);
        const [a, b] = await Promise.all([sharp(fromFile).raw().toBuffer(), sharp(fromMemory).raw().toBuffer()]);
        expect(a.equals(b), name).toBe(true);
      }
      await expect(sut.generateThumbhash(smaller, options)).resolves.toEqual(
        await sut.generateThumbhash(inMemory, options),
      );
      await sut.releaseImage(smaller);
    });

    it('should make the preview of a long screenshot as getDerivedDimensions says', async () => {
      const dir = mkdtempDisposableSync(join(tmpdir(), 'media-repository-'));
      const file = join(dir.path, 'screenshot.png');
      await sharp({ create: { width: 1080, height: 20_000, channels: 3, background: '#336699' } })
        .png()
        .toFile(file);

      const smaller = await sut.decodeImage(file, {
        colorspace: Colorspace.Srgb,
        processInvalidImages: false,
        size: 1440,
      });

      expect(smaller.info).toEqual({ ...getDerivedDimensions({ width: 1080, height: 20_000 }, 1440), channels: 3 });
      expect(smaller.info).toMatchObject({ width: 885, height: 16_383 });
      // the preview and the thumbnail made from it
      const dir2 = mkdtempDisposableSync(join(tmpdir(), 'media-repository-'));
      const preview = join(dir2.path, 'preview.jpeg');
      const thumbnail = join(dir2.path, 'thumbnail.webp');
      const options = { colorspace: Colorspace.Srgb, processInvalidImages: false, quality: 80 };
      await sut.generateThumbnail(smaller, { ...options, format: ImageFormat.Jpeg, size: 1440 }, preview);
      await sut.generateThumbnail(smaller, { ...options, format: ImageFormat.Webp, size: 250 }, thumbnail);
      await expect(sharp(preview).metadata()).resolves.toMatchObject({ width: 885, height: 16_383 });
      await expect(sharp(thumbnail).metadata()).resolves.toMatchObject({ width: 221, height: 4096 });
    });

    it('should make the shorter side the size whatever the shape, with shortSide (the image a face is cut from)', async () => {
      const dir = mkdtempDisposableSync(join(tmpdir(), 'media-repository-'));
      const file = join(dir.path, 'screenshot.png');
      await sharp({ create: { width: 1080, height: 20_000, channels: 3, background: '#336699' } })
        .png()
        .toFile(file);
      const options = { colorspace: Colorspace.Srgb, processInvalidImages: false, size: 500, shortSide: true };

      const smaller = await sut.decodeImage(file, options);
      // from memory, sharp reads it
      const expected = await sut.decodeImage(await readFile(file), options);

      expect(smaller.info).toEqual({ width: 500, height: 9259, channels: 3 });
      expect(expected.info).toMatchObject({ width: 500, height: 9259 });
      await sut.releaseImage(smaller);
      // and no larger than it is
      await expect(sut.decodeImage(file, { ...options, size: 2000 })).resolves.toMatchObject({
        info: { width: 1080, height: 20_000 },
      });
    });

    it('should not make a photo larger than it is', async () => {
      const smaller = await sut.decodeImage(join(testAssets, 'jpg/el_torcal_rocks.jpg'), {
        colorspace: Colorspace.Srgb,
        processInvalidImages: false,
        size: 1440,
      });

      expect(smaller.info).toEqual({ width: 512, height: 341, channels: 3 });
    });

    it('should fail on a file that is no image', async () => {
      const dir = mkdtempDisposableSync(join(tmpdir(), 'media-repository-'));
      const file = join(dir.path, 'broken.jpg');
      await writeFile(file, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));

      await expect(
        sut.decodeImage(file, { colorspace: Colorspace.Srgb, processInvalidImages: false, size: 250 }),
      ).rejects.toThrow(/immich-thumbnail exited with 1: immich-thumbnail: cannot/);
    });
  });
});
