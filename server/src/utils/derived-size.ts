import type { ImageDimensions } from 'src/types.js';

/** The version of the rule below; previews and thumbnails made by an earlier one are made again (MediaService) */
export const DERIVED_SIZE_RULE_VERSION = 1;

/** The most pixels of a preview of the default size (1440): 16 MP, as Google Photos keeps of a photo in storage saver */
export const DERIVED_MAX_PIXELS = 16_000_000;

/**
 * A preview or thumbnail of an image up to this ratio (7.7:1, almost every photo) has the configured size as its short
 * side, as upstream's; beyond it, `DERIVED_MAX_PIXELS` (in proportion to the configured size) limits it
 */
export const DERIVED_MAX_RATIO = DERIVED_MAX_PIXELS / (1440 * 1440);

/** The long side of a very long image's preview or thumbnail is kept at least at this, as long as the short side allows */
export const DERIVED_MIN_LONG_SIDE = 4096;

/** WebP, one of the formats of previews and thumbnails, cannot be larger on either side */
export const DERIVED_MAX_SIDE = 16_383;

/**
 * The scale of the preview or thumbnail of an image, for the configured `size` (its short side). Images up to
 * `DERIVED_MAX_RATIO` (almost all) have `size` as their short side. Longer ones (long screenshots, panoramas) are made
 * smaller still, to the pixels of a `size` x `size * DERIVED_MAX_RATIO` image (16 MP for previews of 1440), so that the
 * preview of a long screenshot can still be read: 1080 x 10000 stays as it is, 1080 x 20000 becomes 885 x 16383. Their
 * long side is kept at least at `DERIVED_MIN_LONG_SIDE` (thumbnails of 250 x 4096 at most, rather than 81 x 1494), and
 * at most at `DERIVED_MAX_SIDE`. Never larger than the image. `native/thumbnail/immich-thumbnail.c` computes the same.
 */
export const getDerivedScale = ({ width, height }: ImageDimensions, size: number) => {
  const short = Math.min(width, height);
  const long = Math.max(width, height);
  const byPixels = Math.sqrt((size * size * DERIVED_MAX_RATIO) / (width * height));
  return Math.min(1, size / short, DERIVED_MAX_SIDE / long, Math.max(byPixels, DERIVED_MIN_LONG_SIDE / long));
};

/** The dimensions of the preview or thumbnail of an image for the configured `size` (see `getDerivedScale`) */
export const getDerivedDimensions = (dimensions: ImageDimensions, size: number): ImageDimensions => {
  const scale = getDerivedScale(dimensions, size);
  return {
    width: Math.max(1, Math.round(dimensions.width * scale)),
    height: Math.max(1, Math.round(dimensions.height * scale)),
  };
};
