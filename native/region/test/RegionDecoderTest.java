// The app's bridge to immich-region (mobile/android/app/src/main/cpp/region_jni.c), run on this machine's JVM: the
// natives of RegionDecoder (RegionImagesImpl.kt) are declared again here, with the same class and package.
// Usage: java -Djava.library.path=DIR RegionDecoderTest.java JPEG HEIC NOT-AN-IMAGE
package app.alextran.immich.images;

import java.io.IOException;

public class RegionDecoderTest {
  static void check(boolean condition, String what) {
    if (!condition) {
      throw new AssertionError(what);
    }
  }

  static void decodes(String path) throws IOException {
    int[] size = new int[2];
    long image = RegionDecoder.open(path, size);
    check(image != 0 && size[0] > 0 && size[1] > 0, "opens " + path);
    int[] info = new int[3];
    // the bottom right corner, made 3 times smaller (sizes rounded up)
    int width = Math.min(500, size[0]);
    int height = Math.min(301, size[1]);
    long pixels = RegionDecoder.decode(image, size[0] - width, size[1] - height, width, height, 3, info);
    check(pixels != 0, "decodes a part of " + path);
    check(info[0] == (width + 2) / 3 && info[1] == (height + 2) / 3 && info[2] == info[0] * 4,
      "the size of the part of " + path + ": " + info[0] + "x" + info[1] + ", " + info[2]);
    try {
      RegionDecoder.decode(image, size[0] - width + 1, 0, width, height, 1, info);
      check(false, "a part beyond the image of " + path + " fails");
    } catch (IOException e) {
      check(e.getMessage().contains("not within the image"), "why a part beyond the image fails: " + e.getMessage());
    }
    RegionDecoder.close(image);
    System.out.println("ok " + path + " " + size[0] + "x" + size[1]);
  }

  public static void main(String[] args) throws IOException {
    System.loadLibrary("immich_region");
    decodes(args[0]);
    decodes(args[1]);
    try {
      RegionDecoder.open(args[2], new int[2]);
      check(false, "opening " + args[2] + " fails");
    } catch (IOException e) {
      check(e.getMessage().contains("not a format"), "why opening " + args[2] + " fails: " + e.getMessage());
    }
    try {
      RegionDecoder.open(args[2] + ".missing", new int[2]);
      check(false, "opening a missing file fails");
    } catch (IOException e) {
      check(e.getMessage().startsWith("cannot open"), "why opening a missing file fails: " + e.getMessage());
    }
    System.out.println("ok errors");
  }
}

class RegionDecoder {
  static native long open(String path, int[] size) throws IOException;

  static native long decode(long handle, int x, int y, int width, int height, int sample, int[] info)
    throws IOException;

  static native void close(long handle);
}
