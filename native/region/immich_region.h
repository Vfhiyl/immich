/* immich-region: decodes a part of a very large image, made smaller if asked, with the memory of that part (and of a
 * tile or a few rows of the image), never of the whole image. The app shows very large images (photos of 100 MP and
 * more, long screenshots) through it: the part on the screen, at the scale it is shown.
 *
 * Formats: HEIF/HEIC made of tiles (the photos of phones: only the tiles of the part are decoded), JPEG (rows are
 * decoded from the top, but only the columns of the part, and smaller by its DCT where it can), PNG (an index of the
 * compressed stream, built as the image is opened, lets decoding start near the part). Colours are converted to sRGB
 * from the embedded profile. Coordinates are those of the image upright (its orientation applied).
 *
 * Not thread safe: one image is used by one thread at a time.
 */
#ifndef IMMICH_REGION_H
#define IMMICH_REGION_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct ir_image ir_image;

/* Opens an image file; on failure returns NULL and writes why into `error` */
ir_image *ir_open(const char *path, char *error, size_t error_size);

/* The size of the image, upright */
int ir_width(const ir_image *image);
int ir_height(const ir_image *image);

/* The size of a part of `width` x `height` made `sample` times smaller (both sides rounded up) */
int ir_sampled(int length, int sample);

/* Decodes the part (`x`, `y`, `width`, `height`) of the upright image, `sample` (1, 2, 3...) times smaller, into
 * `rgba` (8 bits per channel, premultiplied by nothing, `stride` bytes a row, ir_sampled(width) x ir_sampled(height)
 * pixels). Returns 0, or -1 with why in `error`.
 */
int ir_decode(ir_image *image, int x, int y, int width, int height, int sample, uint8_t *rgba, size_t stride,
	char *error, size_t error_size);

void ir_close(ir_image *image);

#ifdef __cplusplus
}
#endif

#endif
