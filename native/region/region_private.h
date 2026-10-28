/* What the formats of immich-region share: the image, sampling (box averages), orientation and colour */
#ifndef IMMICH_REGION_PRIVATE_H
#define IMMICH_REGION_PRIVATE_H

#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>

#include <lcms2.h>

#include "immich_region.h"

/* Averages the pixels of a part of an image `factor` x `factor` at a time: pixels are added row by row, wherever they
 * come from (rows of a JPEG, tiles of a HEIC), and the result is their averages, `width` x `height` pixels */
typedef struct {
	int x;
	int y;
	int factor;
	int width;
	int height;
	uint32_t *sums; /* RGBA, then the number of pixels added */
} ir_box;

int ir_box_init(ir_box *box, int x, int y, int factor, int width, int height);
/* Adds `count` RGBA pixels of row `y`, from column `x` (both of the image); those outside the part are ignored */
void ir_box_add(ir_box *box, int x, int y, const uint8_t *rgba, int count);
/* Writes the averages to `rgba` (`stride` bytes a row) */
void ir_box_write(const ir_box *box, uint8_t *rgba, size_t stride);
void ir_box_free(ir_box *box);

typedef struct ir_format {
	const char *name;
	/* Decodes the part (in the image as stored, before its orientation) into a box of `factor` (1 or more) */
	int (*decode)(ir_image *image, int x, int y, int width, int height, int sample, ir_box *box);
	void (*close)(ir_image *image);
} ir_format;

struct ir_image {
	const ir_format *format;
	void *data;
	/* as stored, before `orientation` */
	int stored_width;
	int stored_height;
	/* EXIF orientation (1 to 8) that the format leaves to us */
	int orientation;
	/* the embedded colours to sRGB, or none (sRGB already) */
	cmsHTRANSFORM transform;
	char *error;
	size_t error_size;
};

/* Writes why into the error of the call */
void ir_fail(ir_image *image, const char *format, ...);

/* Sets the transform from an ICC profile to sRGB (nothing when it is sRGB, or cannot be read) */
void ir_set_profile(ir_image *image, const void *icc, size_t size);
/* Sets the transform from the primaries of a CICP/nclx colour profile, with the sRGB curve, to sRGB */
void ir_set_primaries(ir_image *image, int primaries);

/* The EXIF orientation of an EXIF (TIFF) block, or 1 */
int ir_exif_orientation(const uint8_t *exif, size_t size);

int ir_open_heif(ir_image *image, const char *path);
int ir_open_jpeg(ir_image *image, const char *path);
int ir_open_png(ir_image *image, const char *path);

#endif
