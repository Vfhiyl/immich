/* JPEG through libjpeg-turbo. Rows are decoded from the top (a baseline JPEG cannot be entered elsewhere), but only
 * the columns of the part (jpeg_crop_scanline), the rows above it are skipped without colour conversion and IDCT
 * (jpeg_skip_scanlines), and a part made smaller is decoded smaller by the DCT itself where it can (1/2, 1/4, 1/8). */
#include <setjmp.h>
#include <stdlib.h>
#include <string.h>

#include <stdio.h>

#include <jpeglib.h>

#include "region_private.h"

typedef struct {
	char *path;
} jpeg;

typedef struct {
	struct jpeg_error_mgr manager;
	jmp_buf jump;
	char message[JMSG_LENGTH_MAX];
} jpeg_error;

static void on_error(j_common_ptr info)
{
	jpeg_error *error = (jpeg_error *) info->err;
	info->err->format_message(info, error->message);
	longjmp(error->jump, 1);
}

static void on_warning(j_common_ptr info, int level)
{
	(void) info;
	(void) level;
}

static void jpeg_close(ir_image *image)
{
	jpeg *j = image->data;
	if (j)
		free(j->path);
	free(j);
}

static int jpeg_decode(ir_image *image, int x, int y, int width, int height, int sample, ir_box *box)
{
	jpeg *j = image->data;
	struct jpeg_decompress_struct info;
	jpeg_error error;
	FILE *file = fopen(j->path, "rb");
	uint8_t *row = NULL;
	if (!file) {
		ir_fail(image, "cannot open the file");
		return -1;
	}
	info.err = jpeg_std_error(&error.manager);
	error.manager.error_exit = on_error;
	error.manager.emit_message = on_warning;
	if (setjmp(error.jump)) {
		ir_fail(image, "%s", error.message);
		jpeg_destroy_decompress(&info);
		fclose(file);
		free(row);
		return -1;
	}
	jpeg_create_decompress(&info);
	jpeg_stdio_src(&info, file);
	jpeg_read_header(&info, TRUE);

	/* the largest scale of the DCT within the factor, on whose pixels the part begins */
	int scale = 1;
	while (scale < 8 && sample % (scale * 2) == 0 && x % (scale * 2) == 0 && y % (scale * 2) == 0)
		scale *= 2;
	info.scale_num = 1;
	info.scale_denom = (unsigned) scale;
	const int cmyk = info.jpeg_color_space == JCS_CMYK || info.jpeg_color_space == JCS_YCCK;
	info.out_color_space = cmyk ? JCS_CMYK : JCS_EXT_RGBA;
	jpeg_start_decompress(&info);

	/* the part, in the image as scaled by the DCT */
	const int sx0 = x / scale;
	const int sy0 = y / scale;
	/* decoded with a margin: the chroma of the pixels at the edges of the part is upsampled from its neighbours,
	 * which must be decoded too (the box leaves out what is beyond the part) */
	const int margin = 16;
	int sx1 = (x + width + scale - 1) / scale + margin;
	int sy1 = (y + height + scale - 1) / scale + margin;
	if (sx1 > (int) info.output_width)
		sx1 = (int) info.output_width;
	if (sy1 > (int) info.output_height)
		sy1 = (int) info.output_height;
	const int left = sx0 > margin ? sx0 - margin : 0;
	const int top = sy0 > margin ? sy0 - margin : 0;
	JDIMENSION crop_x = (JDIMENSION) left;
	JDIMENSION crop_width = (JDIMENSION) (sx1 - left);
	jpeg_crop_scanline(&info, &crop_x, &crop_width);
	if (top > 0)
		jpeg_skip_scanlines(&info, (JDIMENSION) top);

	/* the box counts pixels of the scaled image: its origin and factor are scaled too */
	box->x = sx0;
	box->y = sy0;
	box->factor = sample / scale;
	row = malloc((size_t) info.output_width * 4);
	uint8_t *rgba = malloc((size_t) crop_width * 4);
	if (!row || !rgba) {
		free(rgba);
		error.message[0] = 0;
		snprintf(error.message, sizeof(error.message), "out of memory");
		longjmp(error.jump, 1);
	}
	while ((int) info.output_scanline < sy1) {
		const int line = (int) info.output_scanline;
		JSAMPROW rows[1] = { row };
		jpeg_read_scanlines(&info, rows, 1);
		const uint8_t *pixels = row;
		if (cmyk) {
			/* Adobe's inverted CMYK, made RGB without a profile */
			for (JDIMENSION i = 0; i < crop_width; i++) {
				const uint8_t *p = row + i * 4;
				rgba[i * 4] = (uint8_t) (p[0] * p[3] / 255);
				rgba[i * 4 + 1] = (uint8_t) (p[1] * p[3] / 255);
				rgba[i * 4 + 2] = (uint8_t) (p[2] * p[3] / 255);
				rgba[i * 4 + 3] = 255;
			}
			pixels = rgba;
		}
		ir_box_add(box, (int) crop_x, line, pixels, (int) crop_width);
	}
	free(rgba);
	jpeg_abort_decompress(&info);
	jpeg_destroy_decompress(&info);
	fclose(file);
	free(row);
	return 0;
}

static const ir_format format = { "jpeg", jpeg_decode, jpeg_close };

int ir_open_jpeg(ir_image *image, const char *path)
{
	jpeg *j = calloc(1, sizeof(jpeg));
	if (!j || !(j->path = strdup(path))) {
		free(j);
		ir_fail(image, "out of memory");
		return -1;
	}
	image->format = &format;
	image->data = j;

	struct jpeg_decompress_struct info;
	jpeg_error error;
	FILE *file = fopen(path, "rb");
	if (!file) {
		ir_fail(image, "cannot open the file");
		return -1;
	}
	info.err = jpeg_std_error(&error.manager);
	error.manager.error_exit = on_error;
	error.manager.emit_message = on_warning;
	if (setjmp(error.jump)) {
		ir_fail(image, "%s", error.message);
		jpeg_destroy_decompress(&info);
		fclose(file);
		return -1;
	}
	jpeg_create_decompress(&info);
	jpeg_stdio_src(&info, file);
	jpeg_save_markers(&info, JPEG_APP0 + 1, 0xffff);
	jpeg_save_markers(&info, JPEG_APP0 + 2, 0xffff);
	jpeg_read_header(&info, TRUE);
	image->stored_width = (int) info.image_width;
	image->stored_height = (int) info.image_height;
	/* a progressive JPEG is decoded with all of its coefficients in memory: about 3 bytes a pixel */
	if (info.progressive_mode && (uint64_t) info.image_width * info.image_height > 50000000) {
		ir_fail(image, "a progressive JPEG this large cannot be decoded in parts");
		jpeg_destroy_decompress(&info);
		fclose(file);
		return -1;
	}
	for (jpeg_saved_marker_ptr marker = info.marker_list; marker; marker = marker->next)
		if (marker->marker == JPEG_APP0 + 1 && marker->data_length > 6 && !memcmp(marker->data, "Exif", 4)) {
			image->orientation = ir_exif_orientation(marker->data, marker->data_length);
			break;
		}
	JOCTET *icc = NULL;
	unsigned int icc_size = 0;
	if (jpeg_read_icc_profile(&info, &icc, &icc_size)) {
		ir_set_profile(image, icc, icc_size);
		free(icc);
	}
	jpeg_destroy_decompress(&info);
	fclose(file);
	return 0;
}
