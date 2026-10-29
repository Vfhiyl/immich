/* JPEG through libjpeg-turbo. Rows are decoded from the top (a baseline JPEG cannot be entered elsewhere), but only
 * the columns of the part (jpeg_crop_scanline), the rows above it are skipped without colour conversion and IDCT
 * (jpeg_skip_scanlines), and a part made smaller is decoded smaller by the DCT itself where it can (1/2, 1/4, 1/8).
 * Skipping the rows above still decodes their entropy-coded data, so the image keeps an index of it (our patch of
 * libjpeg-turbo, patches/jpeg-turbo/0001), filled as rows are skipped: the parts after start near their rows. */
#include <setjmp.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include <stdio.h>

#include <jpeglib.h>
#include <jerror.h>

#include "region_private.h"

typedef struct {
	/* the state of the entropy decoder at each iMCU row skipped so far (allocated at the first part) */
	jpeg_scan_index index;
} jpeg;

/* A source of the file read with pread(), which can tell where it is and seek, for the index */
#define SOURCE_BUFFER 65536

typedef struct {
	struct jpeg_source_mgr pub;
	int fd;
	long end; /* the position in the file of the byte after the buffer */
	JOCTET buffer[SOURCE_BUFFER];
} source;

static void source_init(j_decompress_ptr info)
{
	(void) info;
}

static boolean source_fill(j_decompress_ptr info)
{
	source *src = (source *) info->src;
	const ssize_t n = pread(src->fd, src->buffer, SOURCE_BUFFER, (off_t) src->end);
	if (n <= 0) {
		/* the end of the file before the end of the image: as jpeg_stdio_src does */
		WARNMS(info, JWRN_JPEG_EOF);
		src->buffer[0] = (JOCTET) 0xFF;
		src->buffer[1] = (JOCTET) JPEG_EOI;
		src->pub.next_input_byte = src->buffer;
		src->pub.bytes_in_buffer = 2;
		return TRUE;
	}
	src->end += n;
	src->pub.next_input_byte = src->buffer;
	src->pub.bytes_in_buffer = (size_t) n;
	return TRUE;
}

static void source_skip(j_decompress_ptr info, long bytes)
{
	source *src = (source *) info->src;
	if (bytes <= 0)
		return;
	if ((size_t) bytes <= src->pub.bytes_in_buffer) {
		src->pub.next_input_byte += bytes;
		src->pub.bytes_in_buffer -= (size_t) bytes;
		return;
	}
	src->end += bytes - (long) src->pub.bytes_in_buffer;
	src->pub.bytes_in_buffer = 0;
}

static void source_term(j_decompress_ptr info)
{
	(void) info;
}

static long source_tell(j_decompress_ptr info)
{
	source *src = (source *) info->src;
	return src->end - (long) src->pub.bytes_in_buffer;
}

static void source_seek(j_decompress_ptr info, long offset)
{
	source *src = (source *) info->src;
	src->end = offset;
	src->pub.next_input_byte = src->buffer;
	src->pub.bytes_in_buffer = 0;
}

static void use_source(j_decompress_ptr info, source *src, int fd)
{
	memset(&src->pub, 0, sizeof(src->pub));
	src->fd = fd;
	src->end = 0;
	src->pub.init_source = source_init;
	src->pub.fill_input_buffer = source_fill;
	src->pub.skip_input_data = source_skip;
	src->pub.resync_to_restart = jpeg_resync_to_restart;
	src->pub.term_source = source_term;
	info->src = &src->pub;
}

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


static int jpeg_decode(ir_image *image, int x, int y, int width, int height, int sample, ir_box *box)
{
	jpeg *j = image->data;
	struct jpeg_decompress_struct info;
	jpeg_error error;
	source *src = malloc(sizeof(source));
	uint8_t *row = NULL;
	uint8_t *rgba = NULL;
	if (!src) {
		ir_fail(image, "out of memory");
		return -1;
	}
	info.err = jpeg_std_error(&error.manager);
	error.manager.error_exit = on_error;
	error.manager.emit_message = on_warning;
	if (setjmp(error.jump)) {
		ir_fail(image, "%s", error.message);
		jpeg_destroy_decompress(&info);
		free(src);
		free(row);
		free(rgba);
		return -1;
	}
	jpeg_create_decompress(&info);
	use_source(&info, src, image->fd);
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

	/* the index, the same for every scale and part */
	if (!j->index.points) {
		j->index.points = calloc(info.total_iMCU_rows, sizeof(jpeg_scan_point));
		j->index.count = j->index.points ? info.total_iMCU_rows : 0;
		j->index.interval = 1;
		j->index.tell = source_tell;
		j->index.seek = source_seek;
	}
	if (j->index.points)
		jpeg_use_scan_index(&info, &j->index);

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
	rgba = malloc((size_t) crop_width * 4);
	if (!row || !rgba) {
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
	jpeg_abort_decompress(&info);
	jpeg_destroy_decompress(&info);
	free(src);
	free(row);
	free(rgba);
	return 0;
}

static void jpeg_close(ir_image *image)
{
	jpeg *j = image->data;
	if (j)
		free(j->index.points);
	free(j);
}

static const ir_format format = { "jpeg", jpeg_decode, jpeg_close };

int ir_open_jpeg(ir_image *image)
{
	image->format = &format;
	if (!(image->data = calloc(1, sizeof(jpeg)))) {
		ir_fail(image, "out of memory");
		return -1;
	}

	struct jpeg_decompress_struct info;
	jpeg_error error;
	source *src = malloc(sizeof(source));
	if (!src) {
		ir_fail(image, "out of memory");
		return -1;
	}
	info.err = jpeg_std_error(&error.manager);
	error.manager.error_exit = on_error;
	error.manager.emit_message = on_warning;
	if (setjmp(error.jump)) {
		ir_fail(image, "%s", error.message);
		jpeg_destroy_decompress(&info);
		free(src);
		return -1;
	}
	jpeg_create_decompress(&info);
	use_source(&info, src, image->fd);
	jpeg_save_markers(&info, JPEG_APP0 + 1, 0xffff);
	jpeg_save_markers(&info, JPEG_APP0 + 2, 0xffff);
	jpeg_read_header(&info, TRUE);
	image->stored_width = (int) info.image_width;
	image->stored_height = (int) info.image_height;
	/* a progressive JPEG is decoded with all of its coefficients in memory: about 3 bytes a pixel */
	if (info.progressive_mode && (uint64_t) info.image_width * info.image_height > 50000000) {
		ir_fail(image, "a progressive JPEG this large cannot be decoded in parts");
		jpeg_destroy_decompress(&info);
		free(src);
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
	free(src);
	return 0;
}
