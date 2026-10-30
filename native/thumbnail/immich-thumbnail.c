/* immich-thumbnail: makes the image from which the server makes the preview, the thumbnail and the thumbhash of a
 * photo, with the memory of a few hundred lines of it rather than of all its pixels.
 *
 * Usage: immich-thumbnail INPUT SIZE COLORSPACE [--process-invalid] [--output FILE.v] [--short-side]
 *   SIZE        the size of the server's preview: the shorter side of the result, but for very long images (see
 *               derived_scale), and no larger than the photo; with --short-side, the shorter side of the result
 *               whatever its shape (the image a face is cut from), no larger than the photo; 0: the photo as large
 *               as it is (the image its full-size file is made from)
 *   COLORSPACE  srgb or p3: the colours of the result, and of the files made from it
 *
 * Writes to stdout one line of JSON ({"width":..,"height":..,"channels":..}) and then the pixels: 8 bits per channel,
 * RGB or RGBA, upright (as its orientation tag says), in COLORSPACE. With --output, the pixels go to FILE.v (libvips'
 * format, which the server's sharp maps into memory rather than reading) instead, as they are made: the result is never
 * in memory whole (the preview of a long screenshot is up to 16 MP; a photo as large as it is, up to 200 MP).
 *
 * It does what the server did with sharp (src/repositories/media.repository.ts: decodeImage), in the same order, in
 * one pass over the photo instead of two: the colours are converted from the embedded profile to COLORSPACE (16 bits,
 * perceptual intent), linearised as sRGB (exact for sRGB and Display P3, which share the curve), resized with
 * premultiplied alpha, encoded again, and rotated upright. libvips reads the photo from top to bottom and keeps only
 * the lines that the resize still needs.
 *
 * It runs in a process of its own: when it is done, all of its memory goes back to the system, and when memory runs
 * out, it alone is stopped.
 */

#include <stdio.h>
#include <stdlib.h>
#include <math.h>
#include <string.h>
#include <unistd.h>

#include <vips/vips.h>

static int
fail(const char *message)
{
	fprintf(stderr, "immich-thumbnail: %s%s\n", message, vips_error_buffer());
	return 1;
}

/* libvips works through an image in strips of 128 lines (its tile height), and keeps two strips of the result, and
 * the lines of the photo they are made from: 1500 lines of floats for a photo made 6 times smaller, 280 MB for a
 * width of 15000. With 16 lines it keeps an eighth of that, makes the same pixels, and is no slower (we measured).
 * The tile height is an option of libvips' command line (--vips-tile-height), which we parse as vips(1) does.
 */
static int
set_tile_height(void)
{
	char *args[] = { "immich-thumbnail", "--vips-tile-height=16", NULL };
	char **argv = args;
	int argc = 2;
	GOptionContext *context;
	GOptionGroup *group;
	GError *error = NULL;
	gboolean parsed;

	context = g_option_context_new(NULL);
	group = g_option_group_new(NULL, NULL, NULL, NULL, NULL);
	g_option_context_set_main_group(context, group);
	vips_add_option_entries(group);
	parsed = g_option_context_parse(context, &argc, &argv, &error);
	g_option_context_free(context);
	if (!parsed) {
		vips_error("immich-thumbnail", "%s", error->message);
		g_error_free(error);
		return -1;
	}

	return 0;
}

/* The scale of the preview of an image of @width x @height for @size, as the server's getDerivedScale
 * (server/src/utils/derived-size.ts), which the server's tests compare with this: @size as the short side for images
 * up to 16 MP:1440² (7.7:1); for longer ones at most 16 MP (in proportion to @size), with a long side of at least 4096;
 * never more than 16383 a side (WebP), nor larger than the image.
 */
static double
derived_scale(int width, int height, int size)
{
	const double short_side = VIPS_MIN(width, height);
	const double long_side = VIPS_MAX(width, height);
	const double by_pixels = sqrt((double) size * size * (16000000.0 / (1440.0 * 1440.0)) / ((double) width * height));

	return VIPS_MIN(VIPS_MIN(1.0, size / short_side),
		VIPS_MIN(16383.0 / long_side, VIPS_MAX(by_pixels, 4096.0 / long_side)));
}

/* The scale of the result for SIZE (see the usage) */
static double
target_scale(int width, int height, int size, gboolean short_side)
{
	if (size == 0)
		return 1.0;
	if (short_side)
		return VIPS_MIN(1.0, (double) size / VIPS_MIN(width, height));
	return derived_scale(width, height, size);
}

/* Whether the operation @nickname (a loader) takes the argument @name */
static gboolean
has_argument(const char *nickname, const char *name)
{
	VipsOperation *operation;
	GParamSpec *pspec;
	VipsArgumentClass *argument_class;
	VipsArgumentInstance *argument_instance;
	gboolean found;

	if (!(operation = vips_operation_new(nickname)))
		return FALSE;
	found = !vips_object_get_argument(VIPS_OBJECT(operation), name,
		&pspec, &argument_class, &argument_instance);
	g_object_unref(operation);
	vips_error_clear();

	return found;
}

static int
write_all(const void *data, size_t length)
{
	const char *p = data;

	while (length > 0) {
		ssize_t written = write(STDOUT_FILENO, p, length);

		if (written < 0)
			return -1;
		p += written;
		length -= (size_t) written;
	}

	return 0;
}

int
main(int argc, char **argv)
{
	VipsImage *in;
	VipsImage *t[10] = { NULL };
	VipsImage *x;
	const char *input;
	const char *loader;
	int size;
	const char *colorspace;
	gboolean process_invalid;
	gboolean has_alpha;
	double scale;
	size_t length;
	void *pixels;
	char header[128];
	const char *output = NULL;
	char *stored = NULL;
	gboolean short_side = FALSE;

	process_invalid = FALSE;
	for (int i = 4; i < argc; i++) {
		if (strcmp(argv[i], "--process-invalid") == 0)
			process_invalid = TRUE;
		else if (strcmp(argv[i], "--output") == 0 && i + 1 < argc)
			output = argv[++i];
		else if (strcmp(argv[i], "--short-side") == 0)
			short_side = TRUE;
		else
			argc = 0;
	}
	if (argc < 4) {
		fprintf(stderr, "Usage: immich-thumbnail INPUT SIZE srgb|p3 [--process-invalid] [--output FILE.v] "
			"[--short-side]\n");
		return 2;
	}
	input = argv[1];
	size = atoi(argv[2]);
	colorspace = argv[3];
	if (size < 0 || (size == 0 && strcmp(argv[2], "0") != 0) ||
		(strcmp(colorspace, "srgb") != 0 && strcmp(colorspace, "p3") != 0)) {
		fprintf(stderr, "immich-thumbnail: bad size or colorspace\n");
		return 2;
	}

	if (VIPS_INIT(argv[0]))
		return fail("cannot start libvips: ");
	/* reading the photo is the slow part, and it is sequential: more threads would only take more memory */
	vips_concurrency_set(1);
	vips_cache_set_max(0);
	if (set_tile_height())
		return fail("cannot set the tile height: ");

	/* without the limits of libvips' loaders against denial of service (as the server's sharp: `unlimited`): a
	 * photo of 200 MP from a phone is a grid of more items than libheif allows by default */
	if (!(loader = vips_foreign_find_load(input)))
		return fail("cannot open the photo: ");
	if (has_argument(loader, "unlimited"))
		in = vips_image_new_from_file(input,
			"access", VIPS_ACCESS_SEQUENTIAL,
			"fail_on", process_invalid ? VIPS_FAIL_ON_NONE : VIPS_FAIL_ON_ERROR,
			"unlimited", TRUE,
			NULL);
	else
		in = vips_image_new_from_file(input,
			"access", VIPS_ACCESS_SEQUENTIAL,
			"fail_on", process_invalid ? VIPS_FAIL_ON_NONE : VIPS_FAIL_ON_ERROR,
			NULL);
	if (!in)
		return fail("cannot open the photo: ");
	/* a camera RAW file made at most half as large: loaded at half its size (patches/libvips/0005), a quarter of
	 * the memory and time of demosaicing all of it */
	if (has_argument(loader, "half_size") && size > 0 &&
		target_scale(in->Xsize, in->Ysize, size, short_side) <= 0.5) {
		g_object_unref(in);
		if (!(in = vips_image_new_from_file(input,
			"access", VIPS_ACCESS_SEQUENTIAL,
			"fail_on", process_invalid ? VIPS_FAIL_ON_NONE : VIPS_FAIL_ON_ERROR,
			"half_size", TRUE,
			NULL)))
			return fail("cannot open the photo: ");
	}
	x = in;

	/* the colours of COLORSPACE, in 16 bits, from the embedded profile; an image without a profile is taken to be in
	 * COLORSPACE already, as the server does (it picks sRGB for such images, unless they have more than 8 bits, as
	 * HDR images do), and CMYK is made RGB by libvips, as sharp does before it looks at profiles */
	if (x->Type == VIPS_INTERPRETATION_CMYK) {
		if (vips_colourspace(x, &t[9], VIPS_INTERPRETATION_RGB16, NULL) ||
			vips_icc_transform(t[9], &t[0], colorspace,
				"input_profile", "srgb",
				"intent", VIPS_INTENT_PERCEPTUAL,
				"depth", 16,
				NULL))
			return fail("cannot convert the colours: ");
	}
	else if (vips_image_get_typeof(x, VIPS_META_ICC_NAME)) {
		if (vips_icc_transform(x, &t[0], colorspace,
				"embedded", TRUE,
				"intent", VIPS_INTENT_PERCEPTUAL,
				"depth", 16,
				NULL))
			return fail("cannot convert the colours: ");
	}
	else if (vips_colourspace(x, &t[0], VIPS_INTERPRETATION_RGB16, NULL))
		return fail("cannot convert the colours: ");
	x = t[0];

	/* linear light (scRGB has the primaries of its input: no matrix is applied) */
	if (vips_colourspace(x, &t[1], VIPS_INTERPRETATION_scRGB, NULL))
		return fail("cannot linearise: ");
	x = t[1];

	has_alpha = vips_image_hasalpha(x);
	if (has_alpha) {
		if (vips_premultiply(x, &t[2], NULL))
			return fail("cannot premultiply: ");
		x = t[2];
	}

	scale = target_scale(x->Xsize, x->Ysize, size, short_side);
	if (scale < 1.0) {
		if (vips_resize(x, &t[3], scale, "kernel", VIPS_KERNEL_LANCZOS3, NULL))
			return fail("cannot resize: ");
		x = t[3];
	}

	if (has_alpha) {
		if (vips_unpremultiply(x, &t[4], NULL))
			return fail("cannot unpremultiply: ");
		x = t[4];
	}

	/* encoded again with the sRGB curve, in 8 bits */
	if (vips_colourspace(x, &t[5], VIPS_INTERPRETATION_sRGB, NULL) ||
		vips_cast(t[5], &t[6], VIPS_FORMAT_UCHAR, NULL))
		return fail("cannot encode: ");
	x = t[6];

	/* rotated upright, once the photo has been read (rotating needs all of it): the result in memory, or with
	 * --output in a file next to FILE.v (FILE.v.stored.v, in the server's directory of it), which libvips maps into
	 * memory as the rotation reads it, rather than keeping it (a 200 MP photo as large as it is is 600 MB) */
	if (vips_image_get_orientation(x) != 1) {
		if (output) {
			stored = g_strconcat(output, ".stored.v", NULL);
			if (vips_image_write_to_file(x, stored, NULL) || !(t[7] = vips_image_new_from_file(stored, NULL)))
				return fail("cannot read the photo: ");
		}
		else if (!(t[7] = vips_image_copy_memory(x)))
			return fail("cannot read the photo: ");
		if (vips_autorot(t[7], &t[8], NULL))
			return fail("cannot rotate: ");
		x = t[8];
	}

	if (output) {
		/* only the pixels: no profile (they are in COLORSPACE, as the server takes them) nor orientation */
		VipsImage *bare;
		const char *meta[] = { VIPS_META_ICC_NAME, VIPS_META_EXIF_NAME, VIPS_META_XMP_NAME, VIPS_META_IPTC_NAME,
			VIPS_META_PHOTOSHOP_NAME, VIPS_META_ORIENTATION };
		if (vips_copy(x, &bare, NULL))
			return fail("cannot write the result: ");
		for (size_t i = 0; i < sizeof(meta) / sizeof(meta[0]); i++)
			vips_image_remove(bare, meta[i]);
		if (vips_image_write_to_file(bare, output, NULL)) {
			g_object_unref(bare);
			return fail("cannot write the result: ");
		}
		snprintf(header, sizeof(header), "{\"width\":%d,\"height\":%d,\"channels\":%d}\n",
			bare->Xsize, bare->Ysize, bare->Bands);
		g_object_unref(bare);
		if (stored)
			unlink(stored);
		g_free(stored);
		if (write_all(header, strlen(header))) {
			perror("immich-thumbnail: cannot write to stdout");
			return 1;
		}
	}
	else {
		if (!(pixels = vips_image_write_to_memory(x, &length)))
			return fail("cannot write the result: ");
		snprintf(header, sizeof(header), "{\"width\":%d,\"height\":%d,\"channels\":%d}\n",
			x->Xsize, x->Ysize, x->Bands);
		if (write_all(header, strlen(header)) || write_all(pixels, length)) {
			perror("immich-thumbnail: cannot write to stdout");
			return 1;
		}
		g_free(pixels);
	}

	for (int i = 0; i < 10; i++)
		VIPS_UNREF(t[i]);
	VIPS_UNREF(in);
	vips_shutdown();

	return 0;
}
