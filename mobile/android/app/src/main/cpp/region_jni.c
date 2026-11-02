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

// Opens the image of a file descriptor (of the media store), which it duplicates: the caller may close its own. With a
// width and height (else 0), to decode it at about that size: a HEIF's thumbnail if one is that large.
JNIEXPORT jlong JNICALL
Java_app_alextran_immich_images_RegionDecoder_openFd(
    JNIEnv *env, jclass clazz, jint fd, jint width, jint height, jintArray size) {
  char error[256] = "";
  ir_image *image = ir_open_fd_for(fd, width, height, error, sizeof(error));
  if (image == NULL) {
    throw_io(env, error);
    return 0;
  }
  const jint dimensions[2] = {ir_width(image), ir_height(image)};
  (*env)->SetIntArrayRegion(env, size, 0, 2, dimensions);
  return (jlong) (intptr_t) image;
}

// A flag to cancel a decode with (see decodeCancellable), cleared; free it with freeCancel. Returns 0 out of memory.
JNIEXPORT jlong JNICALL
Java_app_alextran_immich_images_RegionDecoder_newCancel(JNIEnv *env, jclass clazz) {
  return (jlong) (intptr_t) calloc(1, sizeof(int));
}

// Sets the flag, from any thread: the decode that watches it stops between rows or tiles
JNIEXPORT void JNICALL
Java_app_alextran_immich_images_RegionDecoder_cancel(JNIEnv *env, jclass clazz, jlong flag) {
  *(volatile int *) (intptr_t) flag = 1;
}

JNIEXPORT void JNICALL
Java_app_alextran_immich_images_RegionDecoder_freeCancel(JNIEnv *env, jclass clazz, jlong flag) {
  free((void *) (intptr_t) flag);
}

static jlong decode(JNIEnv *env, jlong handle, jint x, jint y, jint width, jint height, jint sample,
    const volatile int *cancel, jintArray info);

// Decodes a part, `sample` times smaller, into a malloc'd RGBA buffer (freed by Dart, like NativeBuffer's), writing
// {width, height, rowBytes} into `info`. Returns the buffer, or throws IOException.
JNIEXPORT jlong JNICALL
Java_app_alextran_immich_images_RegionDecoder_decode(
    JNIEnv *env, jclass clazz, jlong handle, jint x, jint y, jint width, jint height, jint sample, jintArray info) {
  return decode(env, handle, x, y, width, height, sample, NULL, info);
}

// As decode, stopping (IOException "cancelled") once the flag of newCancel is set
JNIEXPORT jlong JNICALL
Java_app_alextran_immich_images_RegionDecoder_decodeCancellable(JNIEnv *env, jclass clazz, jlong handle, jint x,
    jint y, jint width, jint height, jint sample, jlong flag, jintArray info) {
  return decode(env, handle, x, y, width, height, sample, (const volatile int *) (intptr_t) flag, info);
}

static jlong decode(JNIEnv *env, jlong handle, jint x, jint y, jint width, jint height, jint sample,
    const volatile int *cancel, jintArray info) {
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
  if (ir_decode_cancellable(image, x, y, width, height, sample, rgba, stride, cancel, error, sizeof(error)) != 0) {
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
