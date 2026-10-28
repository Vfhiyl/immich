#!/usr/bin/env bash
# Builds the libraries the app decodes parts of large images with (region/, see README.md), from the sources of
# sources.txt with our patches, as static libraries: zlib, libjpeg-turbo, lcms2, libde265 and libheif. It needs only
# curl, CMake and make (and the NDK for Android); the app's Android build runs it.
#
# Usage: native/build-region.sh TARGET [output directory]
#   TARGET  host (for the tests), android-arm64-v8a, android-armeabi-v7a or android-x86_64
#   IMMICH_NATIVE_WORK  where sources are downloaded and built (default: ~/.cache/immich-native)
#   ANDROID_NDK_HOME    the Android NDK (default: the one in ANDROID_HOME)
# The libraries and headers end up in the output directory (default: $IMMICH_NATIVE_WORK/region/TARGET), with
# `region.cmake`, which the app's build includes.
set -euo pipefail

NATIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${1:?Usage: build-region.sh host|android-arm64-v8a|android-armeabi-v7a|android-x86_64 [output]}"
WORK="${IMMICH_NATIVE_WORK:-$HOME/.cache/immich-native}"
JOBS="${IMMICH_NATIVE_JOBS:-$(nproc)}"
DOWNLOADS="$WORK/downloads"
BUILD="$WORK/region-build/$TARGET"
PREFIX="$(mkdir -p "${2:-$WORK/region/$TARGET}" && cd "${2:-$WORK/region/$TARGET}" && pwd)"
mkdir -p "$DOWNLOADS" "$BUILD" "$PREFIX/lib"

# shellcheck source=native/common.sh
source "$NATIVE/common.sh"

# --- the toolchain: the host's compiler, or the NDK's for an Android ABI (API 26, the app's minimum) ---

unset PKG_CONFIG_PATH CPATH C_INCLUDE_PATH CPLUS_INCLUDE_PATH LIBRARY_PATH LD_LIBRARY_PATH CC CXX
export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig"
export MAKEFLAGS="-j$JOBS"
FLAGS="-O2 -fPIC -ffunction-sections -fdata-sections"

CMAKE_OPTIONS=(
  -G "Unix Makefiles"
  -DCMAKE_BUILD_TYPE=Release
  -DCMAKE_INSTALL_PREFIX="$PREFIX"
  -DCMAKE_INSTALL_LIBDIR=lib
  -DCMAKE_PREFIX_PATH="$PREFIX"
  -DBUILD_SHARED_LIBS=OFF
  -DCMAKE_POSITION_INDEPENDENT_CODE=ON
  -DCMAKE_C_FLAGS="$FLAGS"
  -DCMAKE_CXX_FLAGS="$FLAGS"
  -DCMAKE_FIND_ROOT_PATH="$PREFIX"
  -DCMAKE_FIND_ROOT_PATH_MODE_LIBRARY=ONLY
  -DCMAKE_FIND_ROOT_PATH_MODE_INCLUDE=ONLY
  -DCMAKE_FIND_ROOT_PATH_MODE_PACKAGE=ONLY
  -DCMAKE_FIND_ROOT_PATH_MODE_PROGRAM=NEVER
  -DBUILD_TESTING=OFF
)

case "$TARGET" in
  host)
    CC=gcc
    CXX=g++
    ;;
  android-*)
    ABI="${TARGET#android-}"
    NDK="${ANDROID_NDK_HOME:-$(find "${ANDROID_HOME:?ANDROID_HOME or ANDROID_NDK_HOME must be set}/ndk" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -1)}"
    TOOLCHAIN="$(echo "$NDK"/toolchains/llvm/prebuilt/*)"
    case "$ABI" in
      arm64-v8a) TRIPLE=aarch64-linux-android ;;
      armeabi-v7a) TRIPLE=armv7a-linux-androideabi ;;
      x86_64) TRIPLE=x86_64-linux-android ;;
      *) echo "Unknown Android ABI $ABI" >&2; exit 1 ;;
    esac
    CC="$TOOLCHAIN/bin/${TRIPLE}26-clang"
    CXX="$TOOLCHAIN/bin/${TRIPLE}26-clang++"
    CMAKE_OPTIONS+=(-DCMAKE_TOOLCHAIN_FILE="$NDK/build/cmake/android.toolchain.cmake" -DANDROID_ABI="$ABI"
      -DANDROID_PLATFORM=android-26 -DANDROID_STL=c++_static)
    ;;
  *)
    echo "Unknown target $TARGET" >&2
    exit 1
    ;;
esac
export CC CXX
# libraries built by another compiler are built again
BUILD_KEY="$("$CC" --version | head -1)"

# --- the libraries ---

build_zlib-ng() {
  cmake -S . -B _build "${CMAKE_OPTIONS[@]}" -DZLIB_COMPAT=ON -DZLIB_ENABLE_TESTS=OFF -DWITH_GTEST=OFF
  cmake --build _build --target install
}

build_jpeg-turbo() {
  cmake -S . -B _build "${CMAKE_OPTIONS[@]}" -DENABLE_SHARED=OFF -DWITH_TURBOJPEG=OFF -DWITH_TOOLS=OFF
  cmake --build _build --target install
}

build_lcms() {
  cmake -S . -B _build "${CMAKE_OPTIONS[@]}" -DLCMS2_BUILD_SHARED=OFF -DLCMS2_BUILD_TOOLS=OFF -DLCMS2_BUILD_TESTS=OFF \
    -DLCMS2_WITH_THREADS=OFF
  cmake --build _build --target install
}

build_de265() {
  cmake -S . -B _build "${CMAKE_OPTIONS[@]}" -DENABLE_SDL=OFF -DENABLE_DECODER=OFF -DENABLE_ENCODER=OFF
  cmake --build _build --target install
}

# decoding only, HEVC only (HEIC); with our patches (patches/heif)
build_heif() {
  cmake -S . -B _build "${CMAKE_OPTIONS[@]}" -DENABLE_PLUGIN_LOADING=OFF -DWITH_EXAMPLES=OFF -DBUILD_DOCUMENTATION=OFF \
    -DWITH_LIBDE265=ON -DWITH_DAV1D=OFF -DWITH_AOM_DECODER=OFF -DWITH_AOM_ENCODER=OFF -DWITH_X265=OFF \
    -DWITH_SvtEnc=OFF -DWITH_RAV1E=OFF -DWITH_KVAZAAR=OFF -DWITH_OpenJPEG_DECODER=OFF -DWITH_OpenJPEG_ENCODER=OFF \
    -DWITH_FFMPEG_DECODER=OFF -DWITH_JPEG_DECODER=OFF -DWITH_JPEG_ENCODER=OFF -DWITH_UNCOMPRESSED_CODEC=OFF \
    -DWITH_LIBSHARPYUV=OFF -DWITH_GDK_PIXBUF=OFF -DENABLE_PARALLEL_TILE_DECODING=OFF
  cmake --build _build --target install
}

# libpng only for the tests (region/test.sh decode PNGs with it, to compare)
build_png() {
  ./configure --prefix="$PREFIX" --enable-static --disable-shared --with-pic --disable-dependency-tracking \
    --disable-tools --without-binconfigs CPPFLAGS="-I$PREFIX/include" LDFLAGS="-L$PREFIX/lib"
  # (it installs a link to its configuration script there)
  mkdir -p "$PREFIX/bin"
  make install
}

LIBRARIES=(zlib-ng jpeg-turbo lcms de265 heif)
[[ "$TARGET" == host ]] && LIBRARIES+=(png)
for library in "${LIBRARIES[@]}"; do
  build "$library"
done

# what the app's CMake needs: the static libraries, in the order they link
cat > "$PREFIX/region.cmake" <<EOF
# written by native/build-region.sh
set(IMMICH_REGION_INCLUDE "$PREFIX/include")
set(IMMICH_REGION_LIBRARIES
  "$PREFIX/lib/libheif.a" "$PREFIX/lib/libde265.a" "$PREFIX/lib/libjpeg.a" "$PREFIX/lib/liblcms2.a" "$PREFIX/lib/libz.a")
EOF
echo "Built $PREFIX"
