/* HEIF, HEIC and AVIF through libheif. An image made of tiles (the photos of phones) is decoded a tile at a time, only
 * the tiles of the part; libheif applies the rotation, mirroring and crop of the image to the tiles. An image of one
 * piece is decoded whole, once, and kept while it is open. */
#include <stdlib.h>
#include <string.h>

#include <libheif/heif.h>

#include "region_private.h"

/* decoded tiles kept, for parts that do not fall on tiles */
#define TILE_CACHE 4

typedef struct {
	uint32_t column;
	uint32_t row;
	struct heif_image *image;
	const uint8_t *data;
	int stride;
	int width;
	int height;
	unsigned used;
} tile;

typedef struct {
	struct heif_context *context;
	struct heif_image_handle *handle;
	heif_image_tiling tiling;
	int tiled;
	tile cache[TILE_CACHE];
	unsigned clock;
} heif;

static void heif_close(ir_image *image)
{
	heif *h = image->data;
	if (!h)
		return;
	for (int i = 0; i < TILE_CACHE; i++)
		if (h->cache[i].image)
			heif_image_release(h->cache[i].image);
	if (h->handle)
		heif_image_handle_release(h->handle);
	if (h->context)
		heif_context_free(h->context);
	free(h);
}

/* The tile at `column`, `row` (the whole image when not tiled), decoded */
static const tile *get_tile(ir_image *image, uint32_t column, uint32_t row)
{
	heif *h = image->data;
	tile *oldest = &h->cache[0];
	for (int i = 0; i < TILE_CACHE; i++) {
		tile *t = &h->cache[i];
		if (t->image && t->column == column && t->row == row) {
			t->used = ++h->clock;
			return t;
		}
		if (!t->image || t->used < oldest->used)
			oldest = t;
	}

	if (oldest->image) {
		heif_image_release(oldest->image);
		oldest->image = NULL;
	}
	struct heif_decoding_options *options = heif_decoding_options_alloc();
	options->convert_hdr_to_8bit = 1;
	options->num_codec_threads = 1;
	struct heif_image *decoded;
	struct heif_error error =
		h->tiled ? heif_image_handle_decode_image_tile(h->handle, &decoded, heif_colorspace_RGB,
					   heif_chroma_interleaved_RGBA, options, column, row)
				 : heif_decode_image(h->handle, &decoded, heif_colorspace_RGB, heif_chroma_interleaved_RGBA, options);
	heif_decoding_options_free(options);
	if (error.code) {
		ir_fail(image, "%s", error.message);
		return NULL;
	}
	oldest->image = decoded;
	oldest->column = column;
	oldest->row = row;
	oldest->used = ++h->clock;
	oldest->width = heif_image_get_width(decoded, heif_channel_interleaved);
	oldest->height = heif_image_get_height(decoded, heif_channel_interleaved);
	oldest->data = heif_image_get_plane_readonly(decoded, heif_channel_interleaved, &oldest->stride);
	return oldest;
}

static int heif_decode(ir_image *image, int x, int y, int width, int height, int sample, ir_box *box)
{
	(void) sample;
	heif *h = image->data;
	const int tile_width = h->tiled ? (int) h->tiling.tile_width : image->stored_width;
	const int tile_height = h->tiled ? (int) h->tiling.tile_height : image->stored_height;
	/* tiles may begin before the image (rotated or cropped images) */
	const int left = h->tiled ? -(int) h->tiling.left_offset : 0;
	const int top = h->tiled ? -(int) h->tiling.top_offset : 0;

	const int first_column = (x - left) / tile_width;
	const int last_column = (x + width - 1 - left) / tile_width;
	const int first_row = (y - top) / tile_height;
	const int last_row = (y + height - 1 - top) / tile_height;
	for (int row = first_row; row <= last_row; row++)
		for (int column = first_column; column <= last_column; column++) {
			const tile *t = get_tile(image, (uint32_t) column, (uint32_t) row);
			if (!t)
				return -1;
			const int tile_x = left + column * tile_width;
			const int tile_y = top + row * tile_height;
			/* the part of the tile within the part asked for */
			const int x0 = x > tile_x ? x : tile_x;
			const int x1 = (x + width < tile_x + t->width) ? x + width : tile_x + t->width;
			const int y0 = y > tile_y ? y : tile_y;
			const int y1 = (y + height < tile_y + t->height) ? y + height : tile_y + t->height;
			for (int py = y0; py < y1; py++)
				ir_box_add(box, x0, py, t->data + (size_t) t->stride * (py - tile_y) + (size_t) (x0 - tile_x) * 4,
					x1 - x0);
		}
	return 0;
}

static const ir_format format = { "heif", heif_decode, heif_close };

int ir_open_heif(ir_image *image, const char *path)
{
	heif *h = calloc(1, sizeof(heif));
	if (!h) {
		ir_fail(image, "out of memory");
		return -1;
	}
	image->format = &format;
	image->data = h;

	h->context = heif_context_alloc();
	/* photos of 200 MP are grids of more items than libheif allows by default */
	heif_context_set_security_limits(h->context, heif_get_disabled_security_limits());
	struct heif_error error = heif_context_read_from_file(h->context, path, NULL);
	if (!error.code)
		error = heif_context_get_primary_image_handle(h->context, &h->handle);
	if (error.code) {
		ir_fail(image, "%s", error.message);
		return -1;
	}
	image->stored_width = heif_image_handle_get_width(h->handle);
	image->stored_height = heif_image_handle_get_height(h->handle);

	error = heif_image_handle_get_image_tiling(h->handle, 1, &h->tiling);
	h->tiled = !error.code && h->tiling.num_columns * h->tiling.num_rows > 1 &&
		h->tiling.image_width == (uint32_t) image->stored_width &&
		h->tiling.image_height == (uint32_t) image->stored_height && h->tiling.number_of_extra_dimensions == 0;

	switch (heif_image_handle_get_color_profile_type(h->handle)) {
	case heif_color_profile_type_prof:
	case heif_color_profile_type_rICC: {
		const size_t size = heif_image_handle_get_raw_color_profile_size(h->handle);
		void *icc = malloc(size);
		if (icc && !heif_image_handle_get_raw_color_profile(h->handle, icc).code)
			ir_set_profile(image, icc, size);
		free(icc);
		break;
	}
	case heif_color_profile_type_nclx: {
		struct heif_color_profile_nclx *nclx = NULL;
		if (!heif_image_handle_get_nclx_color_profile(h->handle, &nclx).code && nclx) {
			ir_set_primaries(image, nclx->color_primaries);
			heif_nclx_color_profile_free(nclx);
		}
		break;
	}
	default:
		break;
	}
	return 0;
}
