/* Decodes parts of images with immich-region and compares them with the whole image decoded by libheif, libjpeg-turbo or
 * libpng: parts at full size must be the same pixels; parts made smaller the averages of those pixels (JPEG, made
 * smaller by its DCT, within a few levels).
 *
 * Usage: region-test FILE...
 *        region-test --make-png FILE WIDTH HEIGHT photo|text|palette    (long PNGs to test with) */
#include <setjmp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <jpeglib.h>
#include <libheif/heif.h>
#include <png.h>

#include "immich_region.h"

static int width, height;

/* the whole image upright, RGBA, from another decoder */
static uint8_t *reference(const char *path)
{
	FILE *f = fopen(path, "rb");
	uint8_t magic[8];
	if (fread(magic, 1, 8, f) != 8)
		return NULL;
	rewind(f);
	uint8_t *rgba = NULL;
	if (magic[0] == 0xff) {
		struct jpeg_decompress_struct c;
		struct jpeg_error_mgr e;
		c.err = jpeg_std_error(&e);
		jpeg_create_decompress(&c);
		jpeg_stdio_src(&c, f);
		jpeg_read_header(&c, TRUE);
		c.out_color_space = JCS_EXT_RGBA;
		jpeg_start_decompress(&c);
		width = c.output_width;
		height = c.output_height;
		rgba = malloc((size_t) width * height * 4);
		while (c.output_scanline < c.output_height) {
			JSAMPROW row = rgba + (size_t) c.output_scanline * width * 4;
			jpeg_read_scanlines(&c, &row, 1);
		}
		jpeg_finish_decompress(&c);
		jpeg_destroy_decompress(&c);
	}
	else if (magic[0] == 0x89) {
		png_image image = { .version = PNG_IMAGE_VERSION };
		png_image_begin_read_from_stdio(&image, f);
		image.format = PNG_FORMAT_RGBA;
		width = image.width;
		height = image.height;
		rgba = malloc(PNG_IMAGE_SIZE(image));
		png_image_finish_read(&image, NULL, rgba, 0, NULL);
	}
	else {
		struct heif_context *ctx = heif_context_alloc();
		heif_context_set_security_limits(ctx, heif_get_disabled_security_limits());
		heif_context_read_from_file(ctx, path, NULL);
		struct heif_image_handle *h;
		heif_context_get_primary_image_handle(ctx, &h);
		struct heif_decoding_options *o = heif_decoding_options_alloc();
		o->convert_hdr_to_8bit = 1;
		struct heif_image *img;
		heif_decode_image(h, &img, heif_colorspace_RGB, heif_chroma_interleaved_RGBA, o);
		width = heif_image_get_width(img, heif_channel_interleaved);
		height = heif_image_get_height(img, heif_channel_interleaved);
		int stride;
		const uint8_t *data = heif_image_get_plane_readonly(img, heif_channel_interleaved, &stride);
		rgba = malloc((size_t) width * height * 4);
		for (int y = 0; y < height; y++)
			memcpy(rgba + (size_t) y * width * 4, data + (size_t) y * stride, (size_t) width * 4);
	}
	fclose(f);
	return rgba;
}

/* the pixel (x, y) of the reference, upright as `orientation` says (EXIF; libjpeg does not apply it) */
static const uint8_t *at(const uint8_t *rgba, int orientation, int x, int y)
{
	int s = x, t = y;
	switch (orientation) {
	case 6: s = y; t = height - 1 - x; break;
	case 8: s = width - 1 - y; t = x; break;
	case 3: s = width - 1 - x; t = height - 1 - y; break;
	default: break;
	}
	return rgba + ((size_t) t * width + s) * 4;
}

/* A PNG to test with: `photo` (RGB of smooth noise, which libpng filters in every way), `text` (black lines on white,
 * as a long screenshot), `palette` (8-bit palette with transparency) */
static int make_png(const char *path, int w, int h, const char *kind)
{
	FILE *f = fopen(path, "wb");
	png_structp p = png_create_write_struct(PNG_LIBPNG_VER_STRING, NULL, NULL, NULL);
	png_infop info = png_create_info_struct(p);
	if (!f || !p || !info || setjmp(png_jmpbuf(p)))
		return 1;
	png_init_io(p, f);
	const int palette = !strcmp(kind, "palette");
	png_set_IHDR(p, info, (png_uint_32) w, (png_uint_32) h, 8, palette ? PNG_COLOR_TYPE_PALETTE : PNG_COLOR_TYPE_RGB,
		PNG_INTERLACE_NONE, PNG_COMPRESSION_TYPE_DEFAULT, PNG_FILTER_TYPE_DEFAULT);
	if (palette) {
		png_color colours[256];
		png_byte alpha[256];
		for (int i = 0; i < 256; i++) {
			colours[i] = (png_color) { (png_byte) i, (png_byte) (255 - i), (png_byte) (i * 7) };
			alpha[i] = (png_byte) (i < 16 ? i * 16 : 255);
		}
		png_set_PLTE(p, info, colours, 256);
		png_set_tRNS(p, info, alpha, 256, NULL);
	}
	png_set_filter(p, 0, PNG_ALL_FILTERS);
	png_write_info(p, info);
	png_bytep row = malloc((size_t) w * 3);
	unsigned seed = 1;
	for (int y = 0; y < h; y++) {
		for (int x = 0; x < w; x++) {
			seed = seed * 1103515245 + 12345;
			if (palette)
				row[x] = (png_byte) ((x + y / 3 + (seed >> 28)) & 255);
			else if (!strcmp(kind, "text")) {
				const int ink = (y % 40) < 20 && (x % 13) < 9 && x > 40 && x < w - 40;
				row[x * 3] = row[x * 3 + 1] = row[x * 3 + 2] = ink ? 20 : 250;
			}
			else
				for (int c = 0; c < 3; c++)
					row[x * 3 + c] = (png_byte) ((x * (c + 1) + y * (3 - c)) / 7 + (seed >> (28 - c)) % 9);
		}
		png_write_row(p, row);
	}
	png_write_end(p, info);
	png_destroy_write_struct(&p, &info);
	free(row);
	fclose(f);
	return 0;
}

int main(int argc, char **argv)
{
	if (argc == 6 && !strcmp(argv[1], "--make-png"))
		return make_png(argv[2], atoi(argv[3]), atoi(argv[4]), argv[5]);
	setenv("IMMICH_REGION_KEEP_COLOURS", "1", 1);
	int failed = 0;
	for (int a = 1; a < argc; a++) {
		const char *path = argv[a];
		char error[256];
		ir_image *image = ir_open(path, error, sizeof(error));
		if (!image) {
			printf("FAIL %s: %s\n", path, error);
			failed++;
			continue;
		}
		const int w = ir_width(image), h = ir_height(image);
		uint8_t *ref = reference(path);
		const int orientation = (w == width && h == height) ? 1 : (getenv("ORIENTATION") ? atoi(getenv("ORIENTATION")) : 6);
		/* parts: the top left, the middle, the bottom right, one across all, at several factors */
		const int parts[][5] = {
			{ 0, 0, 512, 512, 1 }, { w / 2 - 300, h / 2 - 200, 600, 400, 1 }, { w - 513, h - 777, 513, 777, 1 },
			{ 0, 0, w, h, 16 }, { w / 3, h / 3, 1024, 1024, 2 }, { w / 4, h / 2, 1536, 1536, 4 },
			{ w - 2048, h - 2048, 2048, 2048, 8 },
		};
		for (size_t i = 0; i < sizeof(parts) / sizeof(parts[0]); i++) {
			int x = parts[i][0], y = parts[i][1], pw = parts[i][2], ph = parts[i][3];
			const int sample = parts[i][4];
			if (x < 0) x = 0;
			if (y < 0) y = 0;
			if (pw > w - x) pw = w - x;
			if (ph > h - y) ph = h - y;
			const int ow = ir_sampled(pw, sample), oh = ir_sampled(ph, sample);
			uint8_t *out = malloc((size_t) ow * oh * 4);
			if (ir_decode(image, x, y, pw, ph, sample, out, (size_t) ow * 4, error, sizeof(error))) {
				printf("FAIL %s part %zu: %s\n", path, i, error);
				failed++;
				free(out);
				continue;
			}
			int max = 0;
			double total = 0;
			for (int v = 0; v < oh; v++)
				for (int u = 0; u < ow; u++)
					for (int c = 0; c < 4; c++) {
						/* the average of the reference's pixels of this output pixel */
						unsigned sum = 0, n = 0;
						for (int yy = y + v * sample; yy < y + (v + 1) * sample && yy < y + ph; yy++)
							for (int xx = x + u * sample; xx < x + (u + 1) * sample && xx < x + pw; xx++, n++)
								sum += at(ref, orientation, xx, yy)[c];
						const int expected = (int) ((sum + n / 2) / n);
						const int d = abs(out[((size_t) v * ow + u) * 4 + c] - expected);
						total += d;
						if (d > max) max = d;
					}
			const double mean = total / ((double) ow * oh * 4);
			const int jpeg_scaled = ref && sample > 1 && strstr(path, ".jpg");
			const int ok = jpeg_scaled ? mean < 2.0 : max == 0;
			printf("%s %s part %zu (%d,%d %dx%d by %d): max %d, mean %.3f\n", ok ? "ok  " : "FAIL", path, i, x, y, pw,
				ph, sample, max, mean);
			failed += !ok;
			free(out);
		}
		free(ref);
		ir_close(image);
	}
	return failed != 0;
}
