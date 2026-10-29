/* What the formats of immich-region share: the image, sampling (box averages), orientation and colour */
#ifndef IMMICH_REGION_PRIVATE_H
#define IMMICH_REGION_PRIVATE_H

#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>

#include <lcms2.h>

#include "immich_region.h"

/* Averages the pixels of a part of an image `factor` x `factor` at a time into `width` x `height` pixels: pixels are
 * added row by row, wherever they come from (rows of a JPEG, tiles of a HEIC), and each row of averages is written out
 * (turned to its orientation) once the rows of the image after it come. Only the rows in progress are kept: the rows
 * of the image added must not go back more than `band` rows from the furthest yet. */
typedef struct {
	int x;
	int y;
	int factor;
	int width;
	int height;
	int rows;       /* the rows of averages kept, from `first` (the first not written yet) */
	int first;
	uint32_t *sums; /* rows x width x (RGBA, then the number of pixels added) */
	uint8_t *out;   /* the averages, upright */
	size_t stride;
	int orientation;
} ir_box;

int ir_box_init(ir_box *box, int x, int y, int factor, int width, int height, int band, uint8_t *out, size_t stride,
	int orientation);
/* Adds `count` RGBA pixels of row `y`, from column `x` (both of the image); those outside the part are ignored */
void ir_box_add(ir_box *box, int x, int y, const uint8_t *rgba, int count);
/* Writes the rows not written yet */
void ir_box_finish(ir_box *box);
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
	/* the file, which the image owns */
	int fd;
	/* as stored, before `orientation` */
	int stored_width;
	int stored_height;
	/* EXIF orientation (1 to 8) that the format leaves to us */
	int orientation;
	/* how far back (in rows) the format may add rows to a box: 1 for formats decoded row by row */
	int band;
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

int ir_open_heif(ir_image *image);
int ir_open_jpeg(ir_image *image);
int ir_open_png(ir_image *image);

/* A stream of the file from its start, to fclose() (its descriptor shares the position of the image's) */
FILE *ir_file(ir_image *image);

#endif
