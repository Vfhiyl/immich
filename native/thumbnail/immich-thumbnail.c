/* immich-thumbnail: makes the image from which the server makes the preview, the thumbnail and the thumbhash of a
 * photo, with the memory of a few hundred lines of it rather than of all its pixels.
 *
 * Usage: immich-thumbnail INPUT SIZE COLORSPACE [--process-invalid]
 *   SIZE        the shorter side of the result, in pixels (no larger than the photo)
 *   COLORSPACE  srgb or p3: the colours of the result, and of the files made from it
 *
 * Writes to stdout one line of JSON ({"width":..,"height":..,"channels":..}) and then the pixels: 8 bits per channel,
 * RGB or RGBA, upright (as its orientation tag says), in COLORSPACE.
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

	if (argc < 4 || argc > 5 ||
		(argc == 5 && strcmp(argv[4], "--process-invalid") != 0)) {
		fprintf(stderr, "Usage: immich-thumbnail INPUT SIZE srgb|p3 [--process-invalid]\n");
		return 2;
	}
	input = argv[1];
	size = atoi(argv[2]);
	colorspace = argv[3];
	process_invalid = argc == 5;
	if (size <= 0 || (strcmp(colorspace, "srgb") != 0 && strcmp(colorspace, "p3") != 0)) {
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

	scale = (double) size / VIPS_MIN(x->Xsize, x->Ysize);
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

	/* the photo has been read: the small result can be rotated in memory */
	if (!(t[7] = vips_image_copy_memory(x)))
		return fail("cannot read the photo: ");
	if (vips_autorot(t[7], &t[8], NULL))
		return fail("cannot rotate: ");
	x = t[8];

	if (!(pixels = vips_image_write_to_memory(x, &length)))
		return fail("cannot write the result: ");

	snprintf(header, sizeof(header), "{\"width\":%d,\"height\":%d,\"channels\":%d}\n",
		x->Xsize, x->Ysize, x->Bands);
	if (write_all(header, strlen(header)) || write_all(pixels, length)) {
		perror("immich-thumbnail: cannot write to stdout");
		return 1;
	}

	g_free(pixels);
	for (int i = 0; i < 10; i++)
		VIPS_UNREF(t[i]);
	VIPS_UNREF(in);
	vips_shutdown();

	return 0;
}
