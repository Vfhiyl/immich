/* PNG. Its pixels are one zlib stream, which can only be decoded from its start; but deflate can be entered again at the
 * start of any of its blocks, given the 32 KB that came before (as zlib's example zran.c does). Opening the image
 * decodes it once, row by row, and keeps such an entry point about every megabyte of rows, with the row before it
 * (rows are filtered against the previous one); a part is then decoded from the entry point before it.
 * Interlaced PNGs are not supported. */
#include <stdlib.h>
#include <string.h>

#include <zlib.h>

#include "region_private.h"

#define WINDOW 32768
#define SPAN (1 << 20)
#define CHUNK 16384

typedef struct {
	uint64_t offset; /* in the stream of IDAT data */
	uint64_t length;
	long position;	 /* in the file */
} idat;

typedef struct {
	uint64_t out;	/* bytes of filtered rows before it */
	uint64_t in;	/* bytes of the zlib stream before it */
	int bits;		/* bits of the byte before `in` that are part of the next block */
	uint8_t window[WINDOW];
	unsigned window_length;
	int row;		/* the first row that starts at or after `out` */
	uint8_t *previous; /* that row's previous row, unfiltered (none for row 0) */
} point;

typedef struct {
	FILE *file;
	int depth;
	int color;	/* 0 gray, 2 RGB, 3 palette, 4 gray + alpha, 6 RGBA */
	int channels;
	size_t row_bytes; /* without the filter byte */
	int bpp;		  /* bytes of a pixel, at least 1, for the filters */
	uint8_t palette[256][4];
	int has_trns;
	uint16_t trns[3];
	idat *idats;
	int idat_count;
	uint64_t stream_length;
	point *points;
	int point_count;
} png;

/* --- reading the stream of IDAT data --- */

typedef struct {
	png *p;
	uint64_t offset;
	int index;
} stream;

static size_t stream_read(stream *s, uint8_t *buffer, size_t size)
{
	png *p = s->p;
	size_t done = 0;
	while (done < size && s->index < p->idat_count) {
		idat *d = &p->idats[s->index];
		if (s->offset >= d->offset + d->length) {
			s->index++;
			continue;
		}
		const uint64_t within = s->offset - d->offset;
		size_t n = (size_t) (d->length - within);
		if (n > size - done)
			n = size - done;
		if (fseek(p->file, d->position + (long) within, SEEK_SET) || fread(buffer + done, 1, n, p->file) != n)
			break;
		done += n;
		s->offset += n;
	}
	return done;
}

static void stream_seek(stream *s, uint64_t offset)
{
	s->offset = offset;
	s->index = 0;
	while (s->index < s->p->idat_count &&
		s->p->idats[s->index].offset + s->p->idats[s->index].length <= offset)
		s->index++;
}

/* --- rows --- */

static int paeth(int a, int b, int c)
{
	const int p = a + b - c;
	const int pa = abs(p - a), pb = abs(p - b), pc = abs(p - c);
	return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/* Undoes the filter of `row` (its first byte is the filter) against `previous` (unfiltered, or NULL for the first) */
static int unfilter(const png *p, uint8_t *row, const uint8_t *previous)
{
	uint8_t *r = row + 1;
	const size_t n = p->row_bytes;
	const int bpp = p->bpp;
	switch (row[0]) {
	case 0: break;
	case 1:
		for (size_t i = bpp; i < n; i++) r[i] += r[i - bpp];
		break;
	case 2:
		if (previous)
			for (size_t i = 0; i < n; i++) r[i] += previous[i];
		break;
	case 3:
		for (size_t i = 0; i < n; i++) {
			const int a = i >= (size_t) bpp ? r[i - bpp] : 0;
			const int b = previous ? previous[i] : 0;
			r[i] += (uint8_t) ((a + b) / 2);
		}
		break;
	case 4:
		for (size_t i = 0; i < n; i++) {
			const int a = i >= (size_t) bpp ? r[i - bpp] : 0;
			const int b = previous ? previous[i] : 0;
			const int c = previous && i >= (size_t) bpp ? previous[i - bpp] : 0;
			r[i] += (uint8_t) paeth(a, b, c);
		}
		break;
	default:
		return -1;
	}
	return 0;
}

/* The sample `index` of an unfiltered row, of `depth` bits, scaled to 8 bits */
static int sample_at(const uint8_t *row, int depth, size_t index, int *raw)
{
	int value;
	switch (depth) {
	case 16:
		*raw = row[index * 2] << 8 | row[index * 2 + 1];
		return row[index * 2];
	case 8:
		*raw = row[index];
		return row[index];
	default: {
		const size_t bit = index * depth;
		value = (row[bit / 8] >> (8 - depth - bit % 8)) & ((1 << depth) - 1);
		*raw = value;
		return value * 255 / ((1 << depth) - 1);
	}
	}
}

/* Converts the columns `x` to `x + count` of an unfiltered row to RGBA */
static void to_rgba(const png *p, const uint8_t *row, int x, int count, uint8_t *rgba)
{
	for (int i = 0; i < count; i++) {
		const size_t pixel = (size_t) (x + i);
		uint8_t *out = rgba + (size_t) i * 4;
		int raw[4];
		switch (p->color) {
		case 0: {
			const int g = sample_at(row, p->depth, pixel, &raw[0]);
			out[0] = out[1] = out[2] = (uint8_t) g;
			out[3] = p->has_trns && raw[0] == p->trns[0] ? 0 : 255;
			break;
		}
		case 2:
			for (int c = 0; c < 3; c++)
				out[c] = (uint8_t) sample_at(row, p->depth, pixel * 3 + c, &raw[c]);
			out[3] = p->has_trns && raw[0] == p->trns[0] && raw[1] == p->trns[1] && raw[2] == p->trns[2] ? 0 : 255;
			break;
		case 3: {
			int index;
			(void) sample_at(row, p->depth, pixel, &index);
			memcpy(out, p->palette[index & 255], 4);
			break;
		}
		case 4: {
			const int g = sample_at(row, p->depth, pixel * 2, &raw[0]);
			out[0] = out[1] = out[2] = (uint8_t) g;
			out[3] = (uint8_t) sample_at(row, p->depth, pixel * 2 + 1, &raw[1]);
			break;
		}
		default:
			for (int c = 0; c < 4; c++)
				out[c] = (uint8_t) sample_at(row, p->depth, pixel * 4 + c, &raw[c]);
			break;
		}
	}
}

/* --- decoding --- */

typedef struct {
	png *p;
	stream in;
	z_stream z;
	uint8_t input[CHUNK];
} inflater;

/* Reads `size` bytes of filtered rows; returns how many */
static size_t inflate_read(inflater *f, uint8_t *out, size_t size, int stop_at_blocks, int *at_block)
{
	f->z.next_out = out;
	f->z.avail_out = (uInt) size;
	if (at_block)
		*at_block = 0;
	while (f->z.avail_out > 0) {
		if (f->z.avail_in == 0) {
			f->z.avail_in = (uInt) stream_read(&f->in, f->input, CHUNK);
			f->z.next_in = f->input;
			if (f->z.avail_in == 0)
				break;
		}
		const int status = inflate(&f->z, stop_at_blocks ? Z_BLOCK : Z_NO_FLUSH);
		if (status == Z_STREAM_END)
			break;
		if (status != Z_OK && status != Z_BUF_ERROR)
			return (size_t) -1;
		if (stop_at_blocks && (f->z.data_type & 128) && !(f->z.data_type & 64)) {
			if (at_block)
				*at_block = 1;
			break;
		}
	}
	return size - f->z.avail_out;
}

static void png_close(ir_image *image)
{
	png *p = image->data;
	if (!p)
		return;
	if (p->file)
		fclose(p->file);
	for (int i = 0; i < p->point_count; i++)
		free(p->points[i].previous);
	free(p->points);
	free(p->idats);
	free(p);
}

/* Decodes the rows `y` to `y + height`, the columns `x` to `x + width`, into the box */
static int png_decode(ir_image *image, int x, int y, int width, int height, int sample, ir_box *box)
{
	(void) sample;
	png *p = image->data;
	const size_t row_size = p->row_bytes + 1;

	/* the last entry point before the first row */
	int which = 0;
	for (int i = 0; i < p->point_count; i++)
		if (p->points[i].row <= y)
			which = i;
	const point *start = &p->points[which];

	inflater f = { .p = p };
	f.in.p = p;
	uint8_t *row = malloc(row_size);
	uint8_t *previous = malloc(p->row_bytes);
	uint8_t *rgba = malloc((size_t) width * 4);
	uint8_t *skip = malloc(CHUNK);
	int status = -1;
	if (!row || !previous || !rgba || !skip) {
		ir_fail(image, "out of memory");
		goto done;
	}
	if (which == 0 && start->in == 0) {
		/* from the start of the stream, with its zlib header */
		if (inflateInit(&f.z) != Z_OK)
			goto done;
		stream_seek(&f.in, 0);
	}
	else {
		if (inflateInit2(&f.z, -15) != Z_OK)
			goto done;
		stream_seek(&f.in, start->in - (start->bits ? 1 : 0));
		if (start->bits) {
			uint8_t byte;
			if (stream_read(&f.in, &byte, 1) != 1)
				goto failed;
			inflatePrime(&f.z, start->bits, byte >> (8 - start->bits));
		}
		inflateSetDictionary(&f.z, start->window, start->window_length);
	}

	/* to the start of the first row after the entry point */
	uint64_t to_skip = (uint64_t) start->row * row_size - start->out;
	while (to_skip > 0) {
		const size_t n = to_skip < CHUNK ? (size_t) to_skip : CHUNK;
		if (inflate_read(&f, skip, n, 0, NULL) != n)
			goto failed;
		to_skip -= n;
	}
	int has_previous = start->row > 0;
	if (has_previous)
		memcpy(previous, start->previous, p->row_bytes);

	for (int r = start->row; r < y + height; r++) {
		if (inflate_read(&f, row, row_size, 0, NULL) != row_size || unfilter(p, row, has_previous ? previous : NULL))
			goto failed;
		if (r >= y) {
			to_rgba(p, row + 1, x, width, rgba);
			ir_box_add(box, x, r, rgba, width);
		}
		memcpy(previous, row + 1, p->row_bytes);
		has_previous = 1;
	}
	status = 0;
	goto ended;

failed:
	ir_fail(image, "the image data is broken");
ended:
	inflateEnd(&f.z);
done:
	free(row);
	free(previous);
	free(rgba);
	free(skip);
	return status;
}

static const ir_format format = { "png", png_decode, png_close };

static uint32_t read32(const uint8_t *b)
{
	return (uint32_t) b[0] << 24 | (uint32_t) b[1] << 16 | (uint32_t) b[2] << 8 | b[3];
}

/* Decodes the whole image once, keeping entry points about every SPAN bytes of rows */
static int build_index(ir_image *image)
{
	png *p = image->data;
	const size_t row_size = p->row_bytes + 1;
	inflater f = { .p = p };
	f.in.p = p;
	uint8_t *buffer = malloc(CHUNK);
	uint8_t *row = malloc(row_size);
	uint8_t *previous = malloc(p->row_bytes);
	int status = -1;
	if (!buffer || !row || !previous || inflateInit(&f.z) != Z_OK) {
		ir_fail(image, "out of memory");
		goto done;
	}
	stream_seek(&f.in, 0);

	/* the first entry point: the start of the stream */
	p->points = calloc(1, sizeof(point));
	if (!p->points)
		goto done;
	p->point_count = 1;

	uint64_t out = 0;
	uint64_t last = 0;
	size_t in_row = 0; /* bytes of the current row read */
	int rows = 0;
	int has_previous = 0;
	point *pending = NULL; /* an entry point waiting for the row before its first row */
	uint8_t window[WINDOW];
	for (;;) {
		int at_block;
		const size_t n = inflate_read(&f, buffer, CHUNK, 1, &at_block);
		if (n == (size_t) -1) {
			ir_fail(image, "the image data is broken");
			goto done;
		}
		/* split what came into rows */
		for (size_t i = 0; i < n;) {
			size_t take = row_size - in_row;
			if (take > n - i)
				take = n - i;
			memcpy(row + in_row, buffer + i, take);
			in_row += take;
			i += take;
			if (in_row < row_size)
				continue;
			in_row = 0;
			if (unfilter(p, row, has_previous ? previous : NULL)) {
				ir_fail(image, "the image data is broken");
				goto done;
			}
			memcpy(previous, row + 1, p->row_bytes);
			has_previous = 1;
			rows++;
			if (pending && pending->row == rows) {
				pending->previous = malloc(p->row_bytes);
				if (!pending->previous)
					goto done;
				memcpy(pending->previous, previous, p->row_bytes);
				pending = NULL;
			}
		}
		out += n;
		if (rows >= image->stored_height || (n == 0 && !at_block))
			break;

		/* at the end of a block, about a SPAN after the last entry point: one more */
		if (at_block && out - last > SPAN && !pending && rows < image->stored_height) {
			point *points = realloc(p->points, sizeof(point) * (p->point_count + 1));
			if (!points)
				goto done;
			p->points = points;
			point *e = &p->points[p->point_count++];
			memset(e, 0, sizeof(point));
			e->out = out;
			e->in = f.in.offset - f.z.avail_in;
			e->bits = f.z.data_type & 7;
			/* the last 32 KB of output: zlib keeps them as the dictionary */
			uInt have = WINDOW;
			inflateGetDictionary(&f.z, window, &have);
			memcpy(e->window, window, have);
			e->window_length = have;
			e->row = (int) ((out + row_size - 1) / row_size);
			if (e->row == rows && in_row == 0) {
				/* a row just ended */
				e->previous = malloc(p->row_bytes);
				if (!e->previous)
					goto done;
				memcpy(e->previous, previous, p->row_bytes);
			}
			else
				pending = e;
			last = out;
			if (e->row >= image->stored_height)
				p->point_count--;
		}
	}
	if (rows < image->stored_height) {
		ir_fail(image, "the image data ends early");
		goto done;
	}
	if (pending)
		p->point_count--;
	status = 0;
done:
	inflateEnd(&f.z);
	free(buffer);
	free(row);
	free(previous);
	return status;
}

int ir_open_png(ir_image *image)
{
	png *p = calloc(1, sizeof(png));
	if (!p) {
		ir_fail(image, "out of memory");
		return -1;
	}
	image->format = &format;
	image->data = p;
	if (!(p->file = ir_file(image))) {
		ir_fail(image, "cannot open the file");
		return -1;
	}

	uint8_t header[8];
	if (fread(header, 1, 8, p->file) != 8) {
		ir_fail(image, "not a PNG");
		return -1;
	}
	int interlaced = 0;
	for (;;) {
		uint8_t chunk[8];
		if (fread(chunk, 1, 8, p->file) != 8)
			break;
		const uint32_t length = read32(chunk);
		const long position = ftell(p->file);
		if (!memcmp(chunk + 4, "IHDR", 4) || !memcmp(chunk + 4, "PLTE", 4) || !memcmp(chunk + 4, "tRNS", 4) ||
			!memcmp(chunk + 4, "iCCP", 4) || !memcmp(chunk + 4, "eXIf", 4)) {
			uint8_t *data = malloc(length ? length : 1);
			if (!data || fread(data, 1, length, p->file) != length) {
				free(data);
				ir_fail(image, "not a PNG");
				return -1;
			}
			if (!memcmp(chunk + 4, "IHDR", 4) && length >= 13) {
				image->stored_width = (int) read32(data);
				image->stored_height = (int) read32(data + 4);
				p->depth = data[8];
				p->color = data[9];
				interlaced = data[12];
			}
			else if (!memcmp(chunk + 4, "PLTE", 4))
				for (uint32_t i = 0; i < length / 3 && i < 256; i++) {
					memcpy(p->palette[i], data + i * 3, 3);
					p->palette[i][3] = 255;
				}
			else if (!memcmp(chunk + 4, "tRNS", 4)) {
				if (p->color == 3)
					for (uint32_t i = 0; i < length && i < 256; i++)
						p->palette[i][3] = data[i];
				else {
					p->has_trns = 1;
					for (uint32_t i = 0; i < 3 && i * 2 + 1 < length; i++)
						p->trns[i] = (uint16_t) (data[i * 2] << 8 | data[i * 2 + 1]);
				}
			}
			else if (!memcmp(chunk + 4, "iCCP", 4)) {
				/* a name, a null, the compression (0), then the zlib-compressed profile */
				const uint8_t *end = memchr(data, 0, length);
				if (end && end + 2 < data + length) {
					uLongf size = 1 << 20;
					uint8_t *icc = malloc(size);
					if (icc && uncompress(icc, &size, end + 2, (uLong) (data + length - end - 2)) == Z_OK)
						ir_set_profile(image, icc, size);
					free(icc);
				}
			}
			else
				image->orientation = ir_exif_orientation(data, length);
			free(data);
		}
		else if (!memcmp(chunk + 4, "IDAT", 4)) {
			idat *idats = realloc(p->idats, sizeof(idat) * (p->idat_count + 1));
			if (!idats) {
				ir_fail(image, "out of memory");
				return -1;
			}
			p->idats = idats;
			p->idats[p->idat_count++] = (idat) { p->stream_length, length, position };
			p->stream_length += length;
			fseek(p->file, (long) length, SEEK_CUR);
		}
		else if (!memcmp(chunk + 4, "IEND", 4))
			break;
		else
			fseek(p->file, (long) length, SEEK_CUR);
		fseek(p->file, position + (long) length + 4, SEEK_SET);
	}

	static const int channels[] = { [0] = 1, [2] = 3, [3] = 1, [4] = 2, [6] = 4 };
	if (image->stored_width <= 0 || image->stored_height <= 0 || p->color > 6 || p->color == 1 || p->color == 5 ||
		p->idat_count == 0) {
		ir_fail(image, "not a PNG");
		return -1;
	}
	if (interlaced) {
		ir_fail(image, "an interlaced PNG cannot be decoded in parts");
		return -1;
	}
	p->channels = channels[p->color];
	const size_t bits = (size_t) image->stored_width * p->channels * p->depth;
	p->row_bytes = (bits + 7) / 8;
	p->bpp = (p->channels * p->depth + 7) / 8;
	return build_index(image);
}
