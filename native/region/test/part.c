/* part FILE SAMPLE X Y W H OUT: decodes a part (W 0: the whole) with colours converted to sRGB; writes its width and
 * height, those of the image, and its RGBA pixels to OUT (for compare-libvips.mjs) */
#include <stdio.h>
#include <stdlib.h>
#include "immich_region.h"
int main(int argc, char **argv) {
  if (argc != 8) {
    fprintf(stderr, "usage: part FILE SAMPLE X Y W H OUT\n");
    return 2;
  }
  char error[256];
  ir_image *image = ir_open(argv[1], error, sizeof error);
  if (!image) { fprintf(stderr, "open: %s\n", error); return 1; }
  int s = atoi(argv[2]), x = atoi(argv[3]), y = atoi(argv[4]), w = atoi(argv[5]), h = atoi(argv[6]);
  if (w <= 0) { w = ir_width(image); h = ir_height(image); }
  int ow = ir_sampled(w, s), oh = ir_sampled(h, s);
  unsigned char *out = malloc((size_t) ow * oh * 4);
  if (ir_decode(image, x, y, w, h, s, out, (size_t) ow * 4, error, sizeof error)) { fprintf(stderr, "decode: %s\n", error); return 1; }
  FILE *f = fopen(argv[7], "wb");
  int dims[4] = { ow, oh, ir_width(image), ir_height(image) };
  fwrite(dims, sizeof dims, 1, f);
  fwrite(out, 1, (size_t) ow * oh * 4, f);
  fclose(f);
  return 0;
}
