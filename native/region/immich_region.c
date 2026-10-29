#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "region_private.h"

int ir_sampled(int length, int sample)
{
	return (length + sample - 1) / sample;
}

/* The point of the upright image that shows the point (`s`, `t`) of the stored one, `width` x `height` */
static void to_upright(int orientation, int width, int height, int s, int t, int *u, int *v)
{
	switch (orientation) {
	case 2: *u = width - 1 - s; *v = t; break;
	case 3: *u = width - 1 - s; *v = height - 1 - t; break;
	case 4: *u = s; *v = height - 1 - t; break;
	case 5: *u = t; *v = s; break;
	case 6: *u = height - 1 - t; *v = s; break;
	case 7: *u = height - 1 - t; *v = width - 1 - s; break;
	case 8: *u = t; *v = width - 1 - s; break;
	default: *u = s; *v = t; break;
	}
}

int ir_box_init(ir_box *box, int x, int y, int factor, int width, int height, int band, uint8_t *out, size_t stride,
	int orientation)
{
	box->x = x;
	box->y = y;
	box->factor = factor;
	box->width = width;
	box->height = height;
	/* the rows of averages a band of rows of the image touches, and the one being added to */
	box->rows = band / factor + 2 < height ? band / factor + 2 : height;
	box->first = 0;
	box->out = out;
	box->stride = stride;
	box->orientation = orientation;
	box->sums = calloc((size_t) width * box->rows * 5, sizeof(uint32_t));
	return box->sums ? 0 : -1;
}

/* Writes the averages of the first row not written yet, and empties its place for the row after the last kept */
static void write_row(ir_box *box)
{
	const int row = box->first++;
	uint32_t *sum = box->sums + (size_t) (row % box->rows) * box->width * 5;
	for (int column = 0; column < box->width; column++, sum += 5) {
		int u = column, v = row;
		if (box->orientation != 1)
			to_upright(box->orientation, box->width, box->height, column, row, &u, &v);
		uint8_t *out = box->out + box->stride * v + (size_t) u * 4;
		const uint32_t n = sum[4] ? sum[4] : 1;
		for (int c = 0; c < 4; c++)
			out[c] = (uint8_t) ((sum[c] + n / 2) / n);
		memset(sum, 0, 5 * sizeof(uint32_t));
	}
}

void ir_box_add(ir_box *box, int x, int y, const uint8_t *rgba, int count)
{
	const int row = (y - box->y) / box->factor;
	/* (a row before those kept cannot come: see `band`) */
	if (y < box->y || row >= box->height || row < box->first)
		return;
	while (row >= box->first + box->rows)
		write_row(box);
	uint32_t *sums = box->sums + (size_t) (row % box->rows) * box->width * 5;
	for (int i = 0; i < count; i++) {
		const int px = x + i;
		if (px < box->x)
			continue;
		const int column = (px - box->x) / box->factor;
		if (column >= box->width)
			break;
		uint32_t *sum = sums + (size_t) column * 5;
		const uint8_t *p = rgba + (size_t) i * 4;
		sum[0] += p[0];
		sum[1] += p[1];
		sum[2] += p[2];
		sum[3] += p[3];
		sum[4]++;
	}
}

void ir_box_finish(ir_box *box)
{
	while (box->first < box->height)
		write_row(box);
}

void ir_box_free(ir_box *box)
{
	free(box->sums);
	box->sums = NULL;
}

void ir_fail(ir_image *image, const char *format, ...)
{
	if (!image->error || image->error_size == 0)
		return;
	va_list args;
	va_start(args, format);
	vsnprintf(image->error, image->error_size, format, args);
	va_end(args);
}

static cmsHPROFILE srgb_profile(void)
{
	return cmsCreate_sRGBProfile();
}

static void set_transform(ir_image *image, cmsHPROFILE profile)
{
	if (!profile)
		return;
	/* the tests compare pixels with other decoders, which convert no colours */
	if (getenv("IMMICH_REGION_KEEP_COLOURS")) {
		cmsCloseProfile(profile);
		return;
	}
	if (cmsGetColorSpace(profile) == cmsSigRgbData) {
		cmsHPROFILE srgb = srgb_profile();
		image->transform = cmsCreateTransform(profile, TYPE_RGBA_8, srgb, TYPE_RGBA_8, INTENT_PERCEPTUAL,
			cmsFLAGS_COPY_ALPHA);
		cmsCloseProfile(srgb);
	}
	cmsCloseProfile(profile);
}

void ir_set_profile(ir_image *image, const void *icc, size_t size)
{
	cmsHPROFILE profile = cmsOpenProfileFromMem(icc, (cmsUInt32Number) size);
	if (!profile)
		return;
	/* an sRGB profile changes nothing */
	char description[64] = "";
	cmsGetProfileInfoASCII(profile, cmsInfoDescription, "en", "US", description, sizeof(description));
	if (strstr(description, "sRGB")) {
		cmsCloseProfile(profile);
		return;
	}
	set_transform(image, profile);
}

void ir_set_primaries(ir_image *image, int primaries)
{
	/* CICP colour primaries (ITU-T H.273): 1 BT.709 (sRGB), 9 BT.2020, 12 Display P3; D65 white */
	cmsCIExyYTRIPLE triple;
	switch (primaries) {
	case 9:
		triple = (cmsCIExyYTRIPLE) { { 0.708, 0.292, 1 }, { 0.170, 0.797, 1 }, { 0.131, 0.046, 1 } };
		break;
	case 12:
		triple = (cmsCIExyYTRIPLE) { { 0.680, 0.320, 1 }, { 0.265, 0.690, 1 }, { 0.150, 0.060, 1 } };
		break;
	default:
		return;
	}
	cmsCIExyY d65 = { 0.3127, 0.3290, 1 };
	/* the sRGB curve */
	cmsFloat64Number parameters[5] = { 2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045 };
	cmsToneCurve *curve = cmsBuildParametricToneCurve(NULL, 4, parameters);
	cmsToneCurve *curves[3] = { curve, curve, curve };
	set_transform(image, cmsCreateRGBProfile(&d65, &triple, curves));
	cmsFreeToneCurve(curve);
}

static int exif_read16(const uint8_t *p, int little)
{
	return little ? p[0] | p[1] << 8 : p[0] << 8 | p[1];
}

static uint32_t exif_read32(const uint8_t *p, int little)
{
	return little ? (uint32_t) p[0] | (uint32_t) p[1] << 8 | (uint32_t) p[2] << 16 | (uint32_t) p[3] << 24
				  : (uint32_t) p[0] << 24 | (uint32_t) p[1] << 16 | (uint32_t) p[2] << 8 | (uint32_t) p[3];
}

int ir_exif_orientation(const uint8_t *exif, size_t size)
{
	if (size >= 6 && !memcmp(exif, "Exif\0\0", 6)) {
		exif += 6;
		size -= 6;
	}
	if (size < 8)
		return 1;
	const int little = exif[0] == 'I';
	const uint32_t ifd = exif_read32(exif + 4, little);
	if (ifd + 2 > size)
		return 1;
	const int entries = exif_read16(exif + ifd, little);
	for (int i = 0; i < entries; i++) {
		const uint8_t *entry = exif + ifd + 2 + i * 12;
		if (entry + 12 > exif + size)
			break;
		if (exif_read16(entry, little) == 0x0112) {
			const int value = exif_read16(entry + 8, little);
			return value >= 1 && value <= 8 ? value : 1;
		}
	}
	return 1;
}

FILE *ir_file(ir_image *image)
{
	const int fd = fcntl(image->fd, F_DUPFD_CLOEXEC, 0);
	if (fd < 0)
		return NULL;
	FILE *file = lseek(fd, 0, SEEK_SET) == 0 ? fdopen(fd, "rb") : NULL;
	if (!file)
		close(fd);
	return file;
}

/* Opens the image of `fd`, which it owns from now on */
static ir_image *open_owned(int fd, char *error, size_t error_size)
{
	ir_image *image = calloc(1, sizeof(ir_image));
	if (!image) {
		close(fd);
		snprintf(error, error_size, "out of memory");
		return NULL;
	}
	image->fd = fd;
	image->orientation = 1;
	image->band = 1;
	image->error = error;
	image->error_size = error_size;

	uint8_t magic[16] = { 0 };
	const ssize_t read = pread(fd, magic, sizeof(magic), 0);
	int status;
	if (read >= 3 && magic[0] == 0xff && magic[1] == 0xd8 && magic[2] == 0xff)
		status = ir_open_jpeg(image);
	else if (read >= 8 && !memcmp(magic, "\x89PNG\r\n\x1a\n", 8))
		status = ir_open_png(image);
	else if (read >= 12 && !memcmp(magic + 4, "ftyp", 4))
		status = ir_open_heif(image);
	else {
		snprintf(error, error_size, read < 0 ? "cannot read the file: %s" : "not a format that can be decoded in parts",
			strerror(errno));
		status = -1;
	}
	if (status) {
		ir_close(image);
		return NULL;
	}
	image->error = NULL;
	return image;
}

ir_image *ir_open(const char *path, char *error, size_t error_size)
{
	const int fd = open(path, O_RDONLY | O_CLOEXEC);
	if (fd < 0) {
		snprintf(error, error_size, "cannot open %s: %s", path, strerror(errno));
		return NULL;
	}
	return open_owned(fd, error, error_size);
}

ir_image *ir_open_fd(int fd, char *error, size_t error_size)
{
	const int own = fcntl(fd, F_DUPFD_CLOEXEC, 0);
	if (own < 0) {
		snprintf(error, error_size, "cannot open the file: %s", strerror(errno));
		return NULL;
	}
	return open_owned(own, error, error_size);
}

static int rotated(const ir_image *image)
{
	return image->orientation >= 5;
}

int ir_width(const ir_image *image)
{
	return rotated(image) ? image->stored_height : image->stored_width;
}

int ir_height(const ir_image *image)
{
	return rotated(image) ? image->stored_width : image->stored_height;
}

/* The point of the stored image shown at (`u`, `v`) of the upright one (EXIF orientations) */
static void to_stored(int orientation, int stored_width, int stored_height, int u, int v, int *s, int *t)
{
	switch (orientation) {
	case 2: *s = stored_width - 1 - u; *t = v; break;
	case 3: *s = stored_width - 1 - u; *t = stored_height - 1 - v; break;
	case 4: *s = u; *t = stored_height - 1 - v; break;
	case 5: *s = v; *t = u; break;
	case 6: *s = v; *t = stored_height - 1 - u; break;
	case 7: *s = stored_width - 1 - v; *t = stored_height - 1 - u; break;
	case 8: *s = stored_width - 1 - v; *t = u; break;
	default: *s = u; *t = v; break;
	}
}

int ir_decode(ir_image *image, int x, int y, int width, int height, int sample, uint8_t *rgba, size_t stride,
	char *error, size_t error_size)
{
	image->error = error;
	image->error_size = error_size;
	if (sample < 1 || width < 1 || height < 1 || x < 0 || y < 0 || x + width > ir_width(image) ||
		y + height > ir_height(image)) {
		ir_fail(image, "the part %d,%d %dx%d (by %d) is not within the image", x, y, width, height, sample);
		return -1;
	}

	/* the part of the stored image */
	int s0, t0, s1, t1;
	to_stored(image->orientation, image->stored_width, image->stored_height, x, y, &s0, &t0);
	to_stored(image->orientation, image->stored_width, image->stored_height, x + width - 1, y + height - 1, &s1,
		&t1);
	const int sx = s0 < s1 ? s0 : s1;
	const int sy = t0 < t1 ? t0 : t1;
	const int sw = abs(s1 - s0) + 1;
	const int sh = abs(t1 - t0) + 1;

	ir_box box;
	if (ir_box_init(&box, sx, sy, sample, ir_sampled(sw, sample), ir_sampled(sh, sample), image->band, rgba, stride,
			image->orientation)) {
		ir_fail(image, "out of memory");
		return -1;
	}
	int status = image->format->decode(image, sx, sy, sw, sh, sample, &box);
	if (status == 0) {
		ir_box_finish(&box);
		const int out_width = ir_sampled(width, sample);
		const int out_height = ir_sampled(height, sample);
		if (image->transform)
			for (int v = 0; v < out_height; v++)
				cmsDoTransform(image->transform, rgba + stride * v, rgba + stride * v, (cmsUInt32Number) out_width);
	}
	ir_box_free(&box);
	image->error = NULL;
	return status;
}

void ir_close(ir_image *image)
{
	if (!image)
		return;
	if (image->format && image->format->close)
		image->format->close(image);
	if (image->transform)
		cmsDeleteTransform(image->transform);
	close(image->fd);
	free(image);
}
