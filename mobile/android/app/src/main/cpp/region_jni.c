#include <jni.h>
#include <stdint.h>
#include <stdlib.h>

#include "immich_region.h"

// The bridge to native/region, which decodes a part of a very large image (see RegionDecoder.kt).

static void throw_io(JNIEnv *env, const char *message) {
  jclass exception = (*env)->FindClass(env, "java/io/IOException");
  if (exception != NULL) {
    (*env)->ThrowNew(env, exception, message);
  }
}

// Opens the image at `path`, writing its upright {width, height} into `size`. Returns the image, or throws IOException.
JNIEXPORT jlong JNICALL
Java_app_alextran_immich_images_RegionDecoder_open(JNIEnv *env, jclass clazz, jstring path, jintArray size) {
  const char *chars = (*env)->GetStringUTFChars(env, path, NULL);
  if (chars == NULL) {
    return 0;
  }
  char error[256] = "";
  ir_image *image = ir_open(chars, error, sizeof(error));
  (*env)->ReleaseStringUTFChars(env, path, chars);
  if (image == NULL) {
    throw_io(env, error);
    return 0;
  }
  const jint dimensions[2] = {ir_width(image), ir_height(image)};
  (*env)->SetIntArrayRegion(env, size, 0, 2, dimensions);
  return (jlong) (intptr_t) image;
}

// Decodes a part, `sample` times smaller, into a malloc'd RGBA buffer (freed by Dart, like NativeBuffer's), writing
// {width, height, rowBytes} into `info`. Returns the buffer, or throws IOException.
JNIEXPORT jlong JNICALL
Java_app_alextran_immich_images_RegionDecoder_decode(
    JNIEnv *env, jclass clazz, jlong handle, jint x, jint y, jint width, jint height, jint sample, jintArray info) {
  ir_image *image = (ir_image *) (intptr_t) handle;
  if (sample < 1 || width < 1 || height < 1) {
    throw_io(env, "invalid part");
    return 0;
  }
  const int out_width = ir_sampled(width, sample);
  const int out_height = ir_sampled(height, sample);
  const size_t stride = (size_t) out_width * 4;
  uint8_t *rgba = malloc(stride * (size_t) out_height);
  if (rgba == NULL) {
    throw_io(env, "out of memory");
    return 0;
  }
  char error[256] = "";
  if (ir_decode(image, x, y, width, height, sample, rgba, stride, error, sizeof(error)) != 0) {
    free(rgba);
    throw_io(env, error);
    return 0;
  }
  const jint dimensions[3] = {out_width, out_height, (jint) stride};
  (*env)->SetIntArrayRegion(env, info, 0, 3, dimensions);
  return (jlong) (intptr_t) rgba;
}

JNIEXPORT void JNICALL
Java_app_alextran_immich_images_RegionDecoder_close(JNIEnv *env, jclass clazz, jlong handle) {
  ir_close((ir_image *) (intptr_t) handle);
}
