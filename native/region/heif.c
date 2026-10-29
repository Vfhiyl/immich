/* HEIF, HEIC and AVIF through libheif. An image made of tiles (the photos of phones) is decoded a tile at a time, only
 * the tiles of the part; libheif applies the rotation, mirroring and crop of the image to the tiles. A part of several
 * tiles is decoded by a few threads, each with its own context of the file (as libvips's heifload: a context is used
 * by one thread at a time), a row of tiles at a time, and added to the box in order. An image of one piece is
 * decoded whole, once, and kept while it is open. */
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include <libheif/heif.h>

#include "region_private.h"

/* decoded tiles kept, for parts that do not fall on tiles */
#define TILE_CACHE 4

/* the threads that decode the tiles of a part, and the tiles decoded but not added to the box yet, at most */
#ifndef WORKERS
#define WORKERS 4
#endif
#define WINDOW (2 * WORKERS)

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

/* What libheif reads the file through, as long as the context is open (it reads tiles when they are decoded). Its
 * reads are mostly of a few bytes (the boxes of the file): they are served from a buffer, as a stdio stream would. */
#define READ_BUFFER 65536

typedef struct {
	int fd;
	int64_t position;
	int64_t size;
	uint8_t *buffer;
	int64_t buffer_start;
	size_t buffer_length;
} file;

/* a context of the file, and its primary image */
typedef struct {
	file file;
	struct heif_context *context;
	struct heif_image_handle *handle;
} reader_context;

typedef struct {
	file file;
	struct heif_context *context;
	struct heif_image_handle *handle;
	/* the contexts of the other threads, opened when first needed */
	reader_context others[WORKERS - 1];
	int others_open;
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
	for (int i = 0; i < h->others_open; i++) {
		heif_image_handle_release(h->others[i].handle);
		heif_context_free(h->others[i].context);
		free(h->others[i].file.buffer);
	}
	if (h->handle)
		heif_image_handle_release(h->handle);
	if (h->context)
		heif_context_free(h->context);
	free(h->file.buffer);
	free(h);
}

/* Decodes the tile at `column`, `row` of an image (the whole image when not tiled), 8 bits RGBA */
static struct heif_error decode_tile(struct heif_image_handle *handle, int tiled, uint32_t column, uint32_t row,
	struct heif_image **decoded)
{
	struct heif_decoding_options *options = heif_decoding_options_alloc();
	options->convert_hdr_to_8bit = 1;
	options->num_codec_threads = 1;
	struct heif_error error =
		tiled ? heif_image_handle_decode_image_tile(handle, decoded, heif_colorspace_RGB, heif_chroma_interleaved_RGBA,
					options, column, row)
			  : heif_decode_image(handle, decoded, heif_colorspace_RGB, heif_chroma_interleaved_RGBA, options);
	heif_decoding_options_free(options);
	return error;
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
	struct heif_image *decoded;
	struct heif_error error = decode_tile(h->handle, h->tiled, column, row, &decoded);
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

static const struct heif_reader reader;

/* Opens a context of the file and its primary image */
static int open_context(reader_context *c, int fd, int64_t size)
{
	c->file = (file) { fd, 0, size, malloc(READ_BUFFER), 0, 0 };
	c->context = heif_context_alloc();
	heif_context_set_security_limits(c->context, heif_get_disabled_security_limits());
	struct heif_error error = heif_context_read_from_reader(c->context, &reader, &c->file, NULL);
	if (!error.code)
		error = heif_context_get_primary_image_handle(c->context, &c->handle);
	if (error.code) {
		heif_context_free(c->context);
		free(c->file.buffer);
		return -1;
	}
	return 0;
}

/* The tiles of a part, decoded by threads in order (row by row, then column by column) and added to the box in that
 * order by the thread of the call */
typedef struct {
	pthread_mutex_t lock;
	pthread_cond_t changed;
	int first_column;
	int columns;
	int first_row;
	int count;
	int next;  /* the next tile to decode */
	int added; /* the tiles added to the box */
	struct heif_image *decoded[WINDOW];
	int failed;
	char message[256];
} job;

typedef struct {
	job *job;
	struct heif_image_handle *handle;
} worker;

static void *work(void *data)
{
	worker *w = data;
	job *j = w->job;
	pthread_mutex_lock(&j->lock);
	for (;;) {
		while (!j->failed && j->next < j->count && j->next >= j->added + WINDOW)
			pthread_cond_wait(&j->changed, &j->lock);
		if (j->failed || j->next >= j->count)
			break;
		const int i = j->next++;
		pthread_mutex_unlock(&j->lock);
		struct heif_image *decoded = NULL;
		const struct heif_error error = decode_tile(w->handle, 1, (uint32_t) (j->first_column + i % j->columns),
			(uint32_t) (j->first_row + i / j->columns), &decoded);
		pthread_mutex_lock(&j->lock);
		if (error.code) {
			if (!j->failed)
				snprintf(j->message, sizeof(j->message), "%s", error.message);
			j->failed = 1;
		}
		else
			j->decoded[i % WINDOW] = decoded;
		pthread_cond_broadcast(&j->changed);
	}
	pthread_mutex_unlock(&j->lock);
	return NULL;
}

/* Adds the rows of a decoded tile (at `tile_x`, `tile_y` of the image) within the part to the box */
static void add_tile(ir_box *box, const uint8_t *data, int stride, int tile_width, int tile_height, int tile_x,
	int tile_y, int x, int y, int width, int height)
{
	const int x0 = x > tile_x ? x : tile_x;
	const int x1 = (x + width < tile_x + tile_width) ? x + width : tile_x + tile_width;
	const int y0 = y > tile_y ? y : tile_y;
	const int y1 = (y + height < tile_y + tile_height) ? y + height : tile_y + tile_height;
	for (int py = y0; py < y1; py++)
		ir_box_add(box, x0, py, data + (size_t) stride * (py - tile_y) + (size_t) (x0 - tile_x) * 4, x1 - x0);
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
	const int count = (last_column - first_column + 1) * (last_row - first_row + 1);

	/* the contexts of the other threads */
	int workers = count < WORKERS ? count : WORKERS;
	if (!h->tiled)
		workers = 1;
	while (h->others_open < workers - 1 && !open_context(&h->others[h->others_open], image->fd, h->file.size))
		h->others_open++;
	if (workers > h->others_open + 1)
		workers = h->others_open + 1;

	if (workers == 1) {
		for (int row = first_row; row <= last_row; row++)
			for (int column = first_column; column <= last_column; column++) {
				const tile *t = get_tile(image, (uint32_t) column, (uint32_t) row);
				if (!t)
					return -1;
				add_tile(box, t->data, t->stride, t->width, t->height, left + column * tile_width,
					top + row * tile_height, x, y, width, height);
			}
		return 0;
	}

	job j = { .first_column = first_column, .columns = last_column - first_column + 1, .first_row = first_row,
		.count = count };
	pthread_mutex_init(&j.lock, NULL);
	pthread_cond_init(&j.changed, NULL);
	worker w[WORKERS];
	pthread_t threads[WORKERS];
	int started = 0;
	for (int i = 0; i < workers; i++) {
		w[i] = (worker) { &j, i == 0 ? h->handle : h->others[i - 1].handle };
		if (pthread_create(&threads[started], NULL, work, &w[i]) == 0)
			started++;
	}
	if (!started) {
		snprintf(j.message, sizeof(j.message), "cannot start a thread");
		j.failed = 1;
	}

	for (int i = 0; i < count; i++) {
		pthread_mutex_lock(&j.lock);
		while (!j.failed && !j.decoded[i % WINDOW])
			pthread_cond_wait(&j.changed, &j.lock);
		struct heif_image *decoded = j.decoded[i % WINDOW];
		j.decoded[i % WINDOW] = NULL;
		if (decoded)
			j.added++;
		pthread_cond_broadcast(&j.changed);
		pthread_mutex_unlock(&j.lock);
		if (!decoded)
			break;
		int stride;
		const uint8_t *data = heif_image_get_plane_readonly(decoded, heif_channel_interleaved, &stride);
		const int column = first_column + i % j.columns;
		const int row = first_row + i / j.columns;
		add_tile(box, data, stride, heif_image_get_width(decoded, heif_channel_interleaved),
			heif_image_get_height(decoded, heif_channel_interleaved), left + column * tile_width,
			top + row * tile_height, x, y, width, height);
		heif_image_release(decoded);
	}

	pthread_mutex_lock(&j.lock);
	const int failed = j.failed;
	j.failed = 1; /* (stops the threads, when it ended early) */
	pthread_cond_broadcast(&j.changed);
	pthread_mutex_unlock(&j.lock);
	for (int i = 0; i < started; i++)
		pthread_join(threads[i], NULL);
	for (int i = 0; i < WINDOW; i++)
		if (j.decoded[i])
			heif_image_release(j.decoded[i]);
	pthread_cond_destroy(&j.changed);
	pthread_mutex_destroy(&j.lock);
	if (failed) {
		ir_fail(image, "%s", j.message);
		return -1;
	}
	return 0;
}

static int64_t file_position(void *data)
{
	return ((file *) data)->position;
}

static int read_at(int fd, void *buffer, size_t size, int64_t position)
{
	size_t done = 0;
	while (done < size) {
		const ssize_t n = pread(fd, (char *) buffer + done, size - done, (off_t) (position + (int64_t) done));
		if (n <= 0)
			return -1;
		done += (size_t) n;
	}
	return 0;
}

static int file_read(void *buffer, size_t size, void *data)
{
	file *f = data;
	if (size >= READ_BUFFER || !f->buffer) {
		if (read_at(f->fd, buffer, size, f->position))
			return -1;
		f->position += (int64_t) size;
		return 0;
	}
	if (f->position < f->buffer_start || f->position + (int64_t) size > f->buffer_start + (int64_t) f->buffer_length) {
		const int64_t left = f->size - f->position;
		const size_t length = left < READ_BUFFER ? (size_t) (left > 0 ? left : 0) : READ_BUFFER;
		if (length < size || read_at(f->fd, f->buffer, length, f->position))
			return -1;
		f->buffer_start = f->position;
		f->buffer_length = length;
	}
	memcpy(buffer, f->buffer + (f->position - f->buffer_start), size);
	f->position += (int64_t) size;
	return 0;
}

static int file_seek(int64_t position, void *data)
{
	((file *) data)->position = position;
	return 0;
}

static enum heif_reader_grow_status file_wait(int64_t size, void *data)
{
	return size > ((file *) data)->size ? heif_reader_grow_status_size_beyond_eof
										 : heif_reader_grow_status_size_reached;
}

static const struct heif_reader reader = {
	.reader_api_version = 1,
	.get_position = file_position,
	.read = file_read,
	.seek = file_seek,
	.wait_for_file_size = file_wait,
};

static const ir_format format = { "heif", heif_decode, heif_close };

/* The smallest thumbnail of the image at least `width` x `height` (either way round), or NULL */
static struct heif_image_handle *smallest_thumbnail(struct heif_image_handle *handle, int width, int height)
{
	if (width <= 0 || height <= 0)
		return NULL;
	const int want_long = width > height ? width : height;
	const int want_short = width > height ? height : width;
	heif_item_id ids[16];
	const int count = heif_image_handle_get_list_of_thumbnail_IDs(handle, ids, 16);
	struct heif_image_handle *best = NULL;
	for (int i = 0; i < count; i++) {
		struct heif_image_handle *thumbnail;
		if (heif_image_handle_get_thumbnail(handle, ids[i], &thumbnail).code)
			continue;
		const int w = heif_image_handle_get_width(thumbnail);
		const int h = heif_image_handle_get_height(thumbnail);
		const int large = (w > h ? w : h) >= want_long && (w > h ? h : w) >= want_short;
		if (large && (!best || (int64_t) w * h <
								   (int64_t) heif_image_handle_get_width(best) * heif_image_handle_get_height(best))) {
			if (best)
				heif_image_handle_release(best);
			best = thumbnail;
		}
		else
			heif_image_handle_release(thumbnail);
	}
	return best;
}

int ir_open_heif(ir_image *image)
{
	heif *h = calloc(1, sizeof(heif));
	if (!h) {
		ir_fail(image, "out of memory");
		return -1;
	}
	image->format = &format;
	image->data = h;

	struct stat status;
	if (fstat(image->fd, &status)) {
		ir_fail(image, "cannot read the file");
		return -1;
	}
	h->file = (file) { image->fd, 0, (int64_t) status.st_size, malloc(READ_BUFFER), 0, 0 };
	h->context = heif_context_alloc();
	/* photos of 200 MP are grids of more items than libheif allows by default */
	heif_context_set_security_limits(h->context, heif_get_disabled_security_limits());
	struct heif_error error = heif_context_read_from_reader(h->context, &reader, &h->file, NULL);
	if (!error.code)
		error = heif_context_get_primary_image_handle(h->context, &h->handle);
	if (error.code) {
		ir_fail(image, "%s", error.message);
		return -1;
	}
	/* a thumbnail large enough, if asked for; with the colours of the image if it has none of its own */
	struct heif_image_handle *primary = h->handle;
	struct heif_image_handle *colours = primary;
	struct heif_image_handle *thumbnail = smallest_thumbnail(primary, image->want_width, image->want_height);
	if (thumbnail) {
		h->handle = thumbnail;
		if (heif_image_handle_get_color_profile_type(thumbnail) != heif_color_profile_type_not_present)
			colours = thumbnail;
	}
	image->stored_width = heif_image_handle_get_width(h->handle);
	image->stored_height = heif_image_handle_get_height(h->handle);

	error = heif_image_handle_get_image_tiling(h->handle, 1, &h->tiling);
	h->tiled = !error.code && h->tiling.num_columns * h->tiling.num_rows > 1 &&
		h->tiling.image_width == (uint32_t) image->stored_width &&
		h->tiling.image_height == (uint32_t) image->stored_height && h->tiling.number_of_extra_dimensions == 0;
	/* tiles are added to a box a row of them at a time */
	image->band = h->tiled ? (int) h->tiling.tile_height : image->stored_height;

	switch (heif_image_handle_get_color_profile_type(colours)) {
	case heif_color_profile_type_prof:
	case heif_color_profile_type_rICC: {
		const size_t size = heif_image_handle_get_raw_color_profile_size(colours);
		void *icc = malloc(size);
		if (icc && !heif_image_handle_get_raw_color_profile(colours, icc).code)
			ir_set_profile(image, icc, size);
		free(icc);
		break;
	}
	case heif_color_profile_type_nclx: {
		struct heif_color_profile_nclx *nclx = NULL;
		if (!heif_image_handle_get_nclx_color_profile(colours, &nclx).code && nclx) {
			ir_set_primaries(image, nclx->color_primaries);
			heif_nclx_color_profile_free(nclx);
		}
		break;
	}
	default:
		break;
	}
	if (primary != h->handle)
		heif_image_handle_release(primary);
	return 0;
}
