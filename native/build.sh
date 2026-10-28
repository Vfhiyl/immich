#!/usr/bin/env bash
# Builds the native libraries of the server from source, the way they are shipped: sharp's module and immich-thumbnail,
# each with libvips and every library it uses linked in statically (they depend on nothing but glibc), with our patches
# (patches/<library>/*.patch, applied in order). See README.md.
#
# Usage: native/build.sh [output directory]
#   IMMICH_NATIVE_WORK     where sources are downloaded and built (default: ~/.cache/immich-native)
#   IMMICH_NATIVE_JOBS     parallel jobs (default: the number of CPUs)
#   IMMICH_NATIVE_RELEASE  the name of the release, in the name of its archive (default: dev)
set -euo pipefail

NATIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="${IMMICH_NATIVE_WORK:-$HOME/.cache/immich-native}"
OUTPUT="$(mkdir -p "${1:-$WORK/output}" && cd "${1:-$WORK/output}" && pwd)"
JOBS="${IMMICH_NATIVE_JOBS:-$(nproc)}"
DOWNLOADS="$WORK/downloads"
BUILD="$WORK/build"
PREFIX="$WORK/prefix"
mkdir -p "$DOWNLOADS" "$BUILD" "$PREFIX/lib"

# C++ libraries ask for -lstdc++ (in their pkg-config files): the linker takes the static one from here rather than the
# shared one of the machine; and Rust ones (librsvg) ask for -lgcc_s, the unwinder, whose static form is libgcc_eh
ln -sf "$(g++ -print-file-name=libstdc++.a)" "$PREFIX/lib/libstdc++.a"
ln -sf "$(gcc -print-file-name=libgcc_eh.a)" "$PREFIX/lib/libgcc_s.a"

# --- the environment: nothing from the machine but the compiler and glibc ---

unset PKG_CONFIG_PATH CPATH C_INCLUDE_PATH CPLUS_INCLUDE_PATH LIBRARY_PATH LD_LIBRARY_PATH
export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig:$PREFIX/share/pkgconfig"
export PKG_CONFIG="pkg-config --static"
export PATH="$PREFIX/bin:$PATH"
FLAGS="-O2 -fPIC -ffunction-sections -fdata-sections"
export CFLAGS="$FLAGS" CXXFLAGS="$FLAGS"
export CPPFLAGS="-I$PREFIX/include"
export LDFLAGS="-L$PREFIX/lib -Wl,--gc-sections"
export MAKEFLAGS="-j$JOBS"

CMAKE_OPTIONS=(
  -G "Unix Makefiles"
  -DCMAKE_BUILD_TYPE=Release
  -DCMAKE_INSTALL_PREFIX="$PREFIX"
  -DCMAKE_INSTALL_LIBDIR=lib
  -DCMAKE_PREFIX_PATH="$PREFIX"
  -DBUILD_SHARED_LIBS=OFF
  -DCMAKE_POSITION_INDEPENDENT_CODE=ON
  # libraries and headers only from what we built
  -DCMAKE_FIND_ROOT_PATH="$PREFIX"
  -DCMAKE_FIND_ROOT_PATH_MODE_LIBRARY=ONLY
  -DCMAKE_FIND_ROOT_PATH_MODE_INCLUDE=ONLY
  -DCMAKE_FIND_ROOT_PATH_MODE_PACKAGE=ONLY
  -DCMAKE_FIND_ROOT_PATH_MODE_PROGRAM=NEVER
  -DBUILD_TESTING=OFF
)
MESON_OPTIONS=(
  --prefix="$PREFIX"
  --libdir=lib
  --default-library=static
  --buildtype=release
  -Db_staticpic=true
  --wrap-mode=nodownload
)
CONFIGURE_OPTIONS=(--prefix="$PREFIX" --enable-static --disable-shared --with-pic --disable-dependency-tracking)

# --- sources ---

# shellcheck source=native/common.sh
source "$NATIVE/common.sh"

# --- the libraries, in the order they depend on each other ---

build_zlib-ng() {
  cmake -S . -B _build "${CMAKE_OPTIONS[@]}" -DZLIB_COMPAT=ON -DZLIB_ENABLE_TESTS=OFF -DWITH_GTEST=OFF
  cmake --build _build --target install
}

build_ffi() {
  ./configure "${CONFIGURE_OPTIONS[@]}" --disable-builddir --disable-multi-os-directory --disable-raw-api \
    --disable-structs --disable-docs
  make install
}

build_pcre2() {
  cmake -S . -B _build "${CMAKE_OPTIONS[@]}" -DPCRE2_BUILD_PCRE2GREP=OFF -DPCRE2_BUILD_TESTS=OFF -DPCRE2_SUPPORT_JIT=OFF
  cmake --build _build --target install
}

build_glib() {
  meson setup _build "${MESON_OPTIONS[@]}" --force-fallback-for=gvdb -Dintrospection=disabled -Dnls=disabled \
    -Dlibmount=disabled -Dselinux=disabled -Dxattr=false -Dsysprof=disabled -Dlibelf=disabled -Dtests=false \
    -Dglib_assert=false -Dglib_checks=false -Dglib_debug=disabled -Dman-pages=disabled -Ddocumentation=false
  meson install -C _build --tag bin-devel,devel
}

build_expat() {
  ./configure "${CONFIGURE_OPTIONS[@]}" --without-xmlwf --without-docbook --without-examples --without-tests
  make install
}

build_exif() {
  ./configure "${CONFIGURE_OPTIONS[@]}" --disable-nls --disable-docs
  make install
}

build_lcms() {
  meson setup _build "${MESON_OPTIONS[@]}" -Dtests=disabled -Djpeg=disabled -Dtiff=disabled
  meson install -C _build
}

build_highway() {
  cmake -S . -B _build "${CMAKE_OPTIONS[@]}" -DHWY_ENABLE_CONTRIB=OFF -DHWY_ENABLE_EXAMPLES=OFF -DHWY_ENABLE_TESTS=OFF \
    -DHWY_ENABLE_INSTALL=ON
  cmake --build _build --target install
}

# jpegli as libjpeg (libjpeg.so.62 interface), as in Immich's base image; it builds with libjpeg-turbo's sources (a
# submodule, which the archive of jpegli does not have)
build_jpegli() {
  local turbo="$BUILD/libjpeg-turbo"
  (unpack libjpeg-turbo)
  rm -rf third_party/libjpeg-turbo
  ln -s "$turbo" third_party/libjpeg-turbo
  cmake -S . -B _build "${CMAKE_OPTIONS[@]}" -DJPEGLI_ENABLE_DOXYGEN=OFF -DJPEGLI_ENABLE_MANPAGES=OFF \
    -DJPEGLI_ENABLE_BENCHMARK=OFF -DJPEGLI_ENABLE_TOOLS=OFF -DJPEGLI_ENABLE_DEVTOOLS=OFF -DJPEGLI_ENABLE_FUZZERS=OFF \
    -DJPEGLI_ENABLE_JNI=OFF -DJPEGLI_ENABLE_OPENEXR=OFF -DJPEGLI_ENABLE_SJPEG=OFF -DJPEGLI_ENABLE_SKCMS=OFF \
    -DJPEGLI_FORCE_SYSTEM_HWY=ON -DJPEGLI_FORCE_SYSTEM_LCMS2=ON -DJPEGLI_ENABLE_JPEGLI_LIBJPEG=ON \
    -DJPEGLI_INSTALL_JPEGLI_LIBJPEG=ON -DJPEGLI_LIBJPEG_LIBRARY_SOVERSION=62 -DJPEGLI_LIBJPEG_LIBRARY_VERSION=62.3.0 \
    -DLIBJPEG_TURBO_VERSION_NUMBER=2001005 -DJPEGLI_ENABLE_HWY_AVX3=ON -DJPEGLI_ENABLE_HWY_AVX3_ZEN4=ON
  cmake --build _build --target install
  # the static libjpeg only (patches/jpegli/0003), which the others find through pkg-config
  rm -f "${PREFIX:?}"/lib/libjpeg.so*
  cat > "$PREFIX/lib/pkgconfig/libjpeg.pc" <<EOF
prefix=$PREFIX
libdir=\${prefix}/lib
includedir=\${prefix}/include

Name: libjpeg
Description: jpegli, with the interface of libjpeg 6.2
Version: 6.2.0
Libs: -L\${libdir} -ljpeg
Libs.private: -lhwy -lstdc++ -lpthread -lm
Cflags: -I\${includedir}
EOF
}

build_png() {
  ./configure "${CONFIGURE_OPTIONS[@]}" --disable-tools --without-binconfigs
  make install
}

build_webp() {
  ./configure "${CONFIGURE_OPTIONS[@]}" --enable-libwebpmux --enable-libwebpdemux --disable-libwebpdecoder \
    --disable-gl --disable-sdl --disable-png --disable-jpeg --disable-tiff --disable-gif --disable-wic
  make install bin_PROGRAMS= noinst_PROGRAMS= man_MANS=
}

build_de265() {
  cmake -S . -B _build "${CMAKE_OPTIONS[@]}" -DENABLE_SDL=OFF -DENABLE_DECODER=OFF -DENABLE_ENCODER=OFF
  cmake --build _build --target install
}

build_dav1d() {
  meson setup _build "${MESON_OPTIONS[@]}" -Denable_tools=false -Denable_tests=false -Denable_examples=false
  meson install -C _build
}

# decoding only: the server makes no HEIF or AVIF files
build_heif() {
  cmake -S . -B _build "${CMAKE_OPTIONS[@]}" -DENABLE_PLUGIN_LOADING=OFF -DWITH_EXAMPLES=OFF -DBUILD_DOCUMENTATION=OFF \
    -DWITH_LIBDE265=ON -DWITH_DAV1D=ON -DWITH_AOM_DECODER=OFF -DWITH_AOM_ENCODER=OFF -DWITH_X265=OFF -DWITH_SvtEnc=OFF \
    -DWITH_RAV1E=OFF -DWITH_KVAZAAR=OFF -DWITH_OpenJPEG_DECODER=OFF -DWITH_OpenJPEG_ENCODER=OFF -DWITH_FFMPEG_DECODER=OFF \
    -DWITH_JPEG_DECODER=OFF -DWITH_JPEG_ENCODER=OFF -DWITH_UNCOMPRESSED_CODEC=ON -DWITH_LIBSHARPYUV=OFF \
    -DWITH_GDK_PIXBUF=OFF -DENABLE_PARALLEL_TILE_DECODING=ON
  cmake --build _build --target install
}

build_brotli() {
  cmake -S . -B _build "${CMAKE_OPTIONS[@]}" -DBROTLI_DISABLE_TESTS=ON
  cmake --build _build --target install
}

build_jxl() {
  cmake -S . -B _build "${CMAKE_OPTIONS[@]}" -DJPEGXL_ENABLE_DOXYGEN=OFF -DJPEGXL_ENABLE_MANPAGES=OFF \
    -DJPEGXL_ENABLE_BENCHMARK=OFF -DJPEGXL_ENABLE_EXAMPLES=OFF -DJPEGXL_ENABLE_TOOLS=OFF -DJPEGXL_ENABLE_JPEGLI=OFF \
    -DJPEGXL_ENABLE_JNI=OFF -DJPEGXL_ENABLE_SJPEG=OFF -DJPEGXL_ENABLE_OPENEXR=OFF -DJPEGXL_ENABLE_SKCMS=OFF \
    -DJPEGXL_ENABLE_PLUGINS=OFF -DJPEGXL_ENABLE_VIEWERS=OFF -DJPEGXL_ENABLE_FUZZERS=OFF -DJPEGXL_ENABLE_DEVTOOLS=OFF \
    -DJPEGXL_FORCE_SYSTEM_BROTLI=ON -DJPEGXL_FORCE_SYSTEM_HWY=ON -DJPEGXL_FORCE_SYSTEM_LCMS2=ON \
    -DJPEGXL_ENABLE_TRANSCODE_JPEG=OFF -DJPEGXL_STATIC=OFF -DJPEGXL_BUNDLE_LIBPNG=OFF
  cmake --build _build --target install
}

build_openjpeg() {
  cmake -S . -B _build "${CMAKE_OPTIONS[@]}" -DBUILD_CODEC=OFF -DBUILD_DOC=OFF
  cmake --build _build --target install
}

build_tiff() {
  cmake -S . -B _build "${CMAKE_OPTIONS[@]}" -DCMath_HAVE_LIBC_POW=ON -Dtiff-tools=OFF -Dtiff-tests=OFF -Dtiff-contrib=OFF -Dtiff-docs=OFF \
    -Dtiff-cxx=OFF -Djbig=OFF -Dlerc=OFF -Dlibdeflate=OFF -Dlzma=OFF -Dzstd=OFF -Dwebp=OFF -Dtiff-opengl=OFF
  cmake --build _build --target install
}

# camera RAW files (libvips' dcrawload); no OpenMP, whose threads would each take memory
build_raw() {
  autoreconf --install --force
  ./configure "${CONFIGURE_OPTIONS[@]}" --disable-examples --disable-openmp --enable-jpeg --enable-zlib --enable-lcms \
    --disable-jasper
  make install
}

# the formats libvips does not read itself (TIFF, PSD, BMP, ...), as in Immich's base image; it reads no configuration from
# the machine (zero configuration: the policy is built in, see patches/imagemagick). Q16 without HDRI: 16 bits
# per channel, which keep 16 bit TIFF and PSD files as they are, in half the memory of HDRI's floats
build_imagemagick() {
  ./configure "${CONFIGURE_OPTIONS[@]}" --without-modules --enable-zero-configuration --with-quantum-depth=16 \
    --disable-hdri --disable-openmp \
    --disable-opencl --without-magick-plus-plus --without-perl --without-x --without-utilities --disable-docs \
    --with-jpeg --with-png --with-tiff --with-webp --with-openjp2 --with-lcms --with-zlib --with-heic --with-jxl \
    --with-raw --without-bzlib --without-lzma --without-zstd --without-xml --without-fontconfig --without-freetype \
    --without-djvu --without-fftw --without-flif --without-fpx --without-gslib --without-gvc --without-jbig \
    --without-lqr --without-openexr --without-pango --without-raqm --without-rsvg --without-wmf --without-uhdr \
    --without-dmr --without-dps --without-jemalloc --without-tcmalloc --without-umem
  make install
}

build_xml2() {
  meson setup _build "${MESON_OPTIONS[@]}" -Dminimum=true
  meson install -C _build
}

build_freetype() {
  meson setup _build "${MESON_OPTIONS[@]}" -Dzlib=enabled -Dpng=enabled -Dbrotli=disabled -Dbzip2=disabled \
    -Dharfbuzz=disabled -Dtests=disabled
  meson install -C _build
}

build_fontconfig() {
  meson setup _build "${MESON_OPTIONS[@]}" -Dcache-build=disabled -Ddoc=disabled -Dnls=disabled -Dtests=disabled \
    -Dtools=disabled
  meson install -C _build
}

build_harfbuzz() {
  meson setup _build "${MESON_OPTIONS[@]}" -Dgobject=disabled -Dicu=disabled -Dtests=disabled -Dintrospection=disabled \
    -Ddocs=disabled -Dbenchmark=disabled -Dutilities=disabled -Draster=disabled -Dvector=disabled -Dsubset=disabled \
    -Dgpu=disabled -Dgpu_demo=disabled -Dcairo=disabled -Dchafa=disabled -Dfreetype=enabled
  meson install -C _build
}

build_pixman() {
  meson setup _build "${MESON_OPTIONS[@]}" -Dlibpng=disabled -Dgtk=disabled -Dopenmp=disabled -Dtests=disabled \
    -Ddemos=disabled
  meson install -C _build
}

build_cairo() {
  meson setup _build "${MESON_OPTIONS[@]}" -Dquartz=disabled -Dfreetype=enabled -Dfontconfig=enabled -Dpng=enabled \
    -Dzlib=enabled -Dtee=disabled -Dxcb=disabled -Dxlib=disabled -Dtests=disabled -Dspectre=disabled \
    -Dsymbol-lookup=disabled -Dglib=enabled
  meson install -C _build
}

build_fribidi() {
  meson setup _build "${MESON_OPTIONS[@]}" -Ddocs=false -Dbin=false -Dtests=false
  meson install -C _build
}

build_pango() {
  meson setup _build "${MESON_OPTIONS[@]}" -Ddocumentation=false -Dbuild-testsuite=false -Dbuild-examples=false \
    -Dintrospection=disabled -Dfontconfig=enabled -Dfreetype=enabled -Dcairo=enabled -Dlibthai=disabled \
    -Dxft=disabled -Dsysprof=disabled
  meson install -C _build
}

# Rust (cargo) builds it, with the crates of its Cargo.lock (checked by their checksums)
build_rsvg() {
  export CARGO_HOME="$WORK/cargo"
  # Rust does not understand pkg-config's --static
  PKG_CONFIG=pkg-config meson setup _build "${MESON_OPTIONS[@]}" -Dintrospection=disabled -Dpixbuf=disabled \
    -Dpixbuf-loader=disabled -Drsvg-convert=disabled -Ddocs=disabled -Dvala=disabled -Dtests=false -Davif=disabled
  meson install -C _build
}

# a static library, linked into each of our programs (sharp's module and immich-thumbnail) with the libraries it uses:
# each program is one file that depends on nothing but glibc, with its own copy of libstdc++ (C++ exceptions do not
# cross between two copies of libstdc++ in two shared libraries)
build_libvips() {
  meson setup _build "${MESON_OPTIONS[@]}" -Ddeprecated=false -Dexamples=false -Dcplusplus=true -Dmodules=disabled \
    -Dintrospection=disabled -Dauto_features=disabled \
    -Dexif=enabled -Djpeg=enabled -Dpng=enabled -Dwebp=enabled -Dheif=enabled -Djpeg-xl=enabled -Dlcms=enabled \
    -Dhighway=enabled -Dzlib=enabled -Dopenjpeg=enabled -Draw=enabled -Dmagick=enabled -Dmagick-package=MagickCore \
    -Drsvg=enabled -Dnsgif=true -Dppm=false -Danalyze=false -Dradiance=false
  meson install -C _build
  # (earlier builds made it a shared library)
  rm -f "${PREFIX:?}"/lib/libvips*.so*
}

LIBRARIES=(zlib-ng ffi pcre2 glib expat exif lcms highway jpegli png webp de265 dav1d heif brotli jxl openjpeg
  tiff raw imagemagick xml2 freetype fontconfig harfbuzz pixman cairo fribidi pango rsvg libvips)


# --- the programs that use it ---

# only the entry points of a Node.js module are exported: nothing of the libraries inside can clash with others
cat > "$BUILD/node-module.map" <<'EOF'
{ global: napi_register_module_v1; node_api_module_get_api_version_v1; local: *; };
EOF

# sharp's native module, with libvips and everything it uses linked in; the sources of sharp are those of the version
# the server uses
build_sharp() {
  (unpack node-addon-api)
  local node_include
  node_include="${IMMICH_NATIVE_NODE_INCLUDE:-$(node -p "require('path').resolve(process.execPath, '../../include/node')")}"
  [[ -f "$node_include/node_api.h" ]] || { echo "No Node.js headers in $node_include" >&2; exit 1; }
  # shellcheck disable=SC2046
  g++ -std=c++17 -O2 -fPIC -fexceptions -Wall -shared -o "sharp-linux-x64.node" src/*.cc \
    -I"$BUILD/node-addon-api" -I"$node_include" $(pkg-config --cflags vips-cpp) \
    -DNAPI_VERSION=9 -DNODE_ADDON_API_DISABLE_DEPRECATED -DNODE_API_SWALLOW_UNTHROWABLE_EXCEPTIONS \
    -DG_DISABLE_ASSERT -DG_DISABLE_CAST_CHECKS -DG_DISABLE_CHECKS -D_GLIBCXX_USE_CXX11_ABI=1 \
    -L"$PREFIX/lib" $(pkg-config --static --libs vips-cpp) -static-libstdc++ -static-libgcc \
    -Wl,--gc-sections -Wl,-s -Wl,-z,nodelete -Wl,--exclude-libs,ALL -Wl,--version-script="$BUILD/node-module.map"
  cp sharp-linux-x64.node "$PREFIX/lib/"
}

for library in "${LIBRARIES[@]}" sharp; do
  build "$library"
done

# our program that makes the image the thumbnails are made from (see thumbnail/immich-thumbnail.c)
mkdir -p "$BUILD/thumbnail"
# shellcheck disable=SC2046
gcc -std=c11 -O2 -Wall -Werror -c -o "$BUILD/thumbnail/immich-thumbnail.o" "$NATIVE/thumbnail/immich-thumbnail.c" \
  $(pkg-config --cflags vips)
# shellcheck disable=SC2046
g++ -o "$BUILD/thumbnail/immich-thumbnail" "$BUILD/thumbnail/immich-thumbnail.o" -L"$PREFIX/lib" \
  $(pkg-config --static --libs vips) -static-libstdc++ -static-libgcc -Wl,--gc-sections -Wl,-s

# --- the package ---

# nothing but glibc, which every Linux has
check_needed() {
  local file="$1" dependency
  for dependency in $(readelf -d "$file" | awk '/NEEDED/ { gsub(/[][]/, "", $5); print $5 }'); do
    case "$dependency" in
      libc.so.* | libm.so.* | libpthread.so.* | libdl.so.* | librt.so.* | ld-linux-*) ;;
      *) echo "$file depends on $dependency, which is not part of glibc" >&2; exit 1 ;;
    esac
  done
}
check_needed "$PREFIX/lib/sharp-linux-x64.node"
check_needed "$BUILD/thumbnail/immich-thumbnail"

rm -rf "${OUTPUT:?}/lib" "${OUTPUT:?}/bin" "${OUTPUT:?}/include"
mkdir -p "$OUTPUT/lib" "$OUTPUT/bin"
cp "$PREFIX/lib/sharp-linux-x64.node" "$OUTPUT/lib/"
cp "$BUILD/thumbnail/immich-thumbnail" "$OUTPUT/bin/"
{
  echo "{"
  # (sharp.versions.vips is the version of libvips)
  for library in "${LIBRARIES[@]}" sharp; do
    echo "  \"${library/#libvips/vips}\": \"$(version_of "$library")\","
  done
  echo "  \"patches\": [$(cd "$NATIVE/patches" && find . -name '*.patch' | sort | sed 's|^\./||; s|.*|"&"|' | paste -sd,)]"
  echo "}"
} > "$OUTPUT/versions.json"

# the archive of a release: the programs, and how they were made (the sources are those of sources.txt, with these
# patches; see README.md)
RELEASE="${IMMICH_NATIVE_RELEASE:-dev}"
rm -rf "${OUTPUT:?}/source"
mkdir -p "$OUTPUT/source"
cp -r "$NATIVE/README.md" "$NATIVE/sources.txt" "$NATIVE/build.sh" "$NATIVE/common.sh" "$NATIVE/patches" "$NATIVE/thumbnail" \
  "$OUTPUT/source/"
tar --owner=0 --group=0 --sort=name -czf "$OUTPUT/immich-native-$RELEASE-linux-x64.tar.gz" -C "$OUTPUT" \
  lib bin versions.json source
echo "Built $OUTPUT/immich-native-$RELEASE-linux-x64.tar.gz"
