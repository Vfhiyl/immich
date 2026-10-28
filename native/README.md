# Native libraries

The server reads and writes images with [libvips](https://github.com/libvips/libvips), through [sharp](https://github.com/lovell/sharp). This fork does not use a libvips that comes with sharp's prebuilt packages, with the base image, or with the machine: it builds libvips and every library it uses from source, with its own patches, and links them statically into two files that depend on nothing but glibc:

| File | What it is |
|---|---|
| `lib/sharp-linux-x64.node` | sharp's native module (the version the server uses), with libvips inside |
| `bin/immich-thumbnail` | a program that makes the image the preview, the thumbnail and the thumbhash of a photo are made from ([thumbnail/immich-thumbnail.c](thumbnail/immich-thumbnail.c)) |

Why: **memory**. The server ran on whatever libvips it found, which decoded a photo whole before making it smaller: about 500 MB for a 48 MP photo, 700 MB for 200 MP. With these libraries a photo is read once, from top to bottom, and a HEIC photo of a phone a row of tiles at a time: 48 MP photos take about 80 MB, a 200 MP HEIC of a Galaxy S24 Ultra 110 MB, a 133 MP HEIC 160 MB (the memory depends on the width of the photo, not on all its pixels). immich-thumbnail works in strips of 16 lines instead of libvips' 128, which keeps an eighth of the lines in memory and makes the same pixels as fast. The colours and pixels of the results are those of before (within the rounding of a few pixels; the tests compare them).

## What is in it

`sources.txt` lists every library, its version (a release, or the revision Immich's base image pins) and the SHA-256 of its source archive, which the build checks. The formats are those of Immich's base image: JPEG (jpegli), PNG, WebP, GIF, HEIC and AVIF (libheif with libde265 and dav1d), JPEG XL, JPEG 2000, camera RAW (LibRaw), SVG (librsvg), and through ImageMagick TIFF, PSD, BMP and the others.

## Patches

Every change to a library is a patch in `patches/<library>/`, applied in order, with what it changes and why at its top.

| Patch | What it changes |
|---|---|
| `libvips/0001` | Camera files that are JPEG or HEIF containers are read by their own loaders, not by LibRaw (from libvips, not yet released; Immich's base image applies it too). |
| `libvips/0002` | The manual pages, translations, tests and fuzzers are not built. |
| `libvips/0003` | **HEIF images made of tiles (the photos of phones) are decoded a row of tiles at a time**, instead of whole: a 48 MP photo takes the memory of one row of tiles (12 MB), not of all its pixels (150 MB). |
| `libvips/0004` | **HEIF and AVIF are decoded with one thread of the codec**: libde265 and dav1d took a thread per processor, each with frames of its own (a 20 MP AVIF took 540 MB on 32 processors, 380 MB now). |
| `heif/0001` | libheif gave the wrong position for the tiles of a rotated photo (the part of the last tile inside the image instead of the part beyond it); not fixed upstream. `libvips/0003` places the tiles by it. |
| `jpegli/0001`, `0002` | From Immich's base image: an empty DHT marker is written correctly; a broken ICC profile is a warning, not an error. |
| `jpegli/0003` | jpegli's libjpeg is built as a static library too. |
| `imagemagick/0001` | ImageMagick reads no configuration from the machine; its built-in policy is Immich's (no delegates, no coders that read other files or URLs, no SVG), and it keeps images beyond 256 MiB in a memory map and beyond 512 MiB on disk, with one thread. |
| `sharp/0001` | sharp loads only the module built here, and fails with a message if it is not installed, instead of falling back to a prebuilt one. pnpm applies it to the JavaScript of sharp (`patchedDependencies`). |

## Building

`native/build.sh [output directory]` downloads the sources (into `~/.cache/immich-native`), checks them, applies the patches and builds; then it checks that the two files need nothing but glibc and packs them, with these sources and patches, into `immich-native-<release>-linux-x64.tar.gz`. Only what changed is built again (the libraries after a changed one too).

It needs a C and C++ compiler (GCC), make, cmake, nasm, autoconf, automake, libtool, gperf, pkg-config, meson (1.11 or later) with ninja, Rust (1.92 or later) with [cargo-c](https://github.com/lu-zero/cargo-c), and Node.js (for its headers). Nothing else of the machine is used: pkg-config and cmake only find what the build installed, and libstdc++ and the unwinder are linked statically.

`server/bin/install-native <directory or archive> [root]` installs the files: sharp's module where sharp loads a module built from source (`node_modules/sharp/src/build/Release`), in every copy of sharp below `root` (default: the server; in the repository the web app uses sharp too, when it is built), and `immich-thumbnail` in `server/native/bin`. It checks that the archive was built for the version of sharp in use, and that sharp loads it. `misc/check.sh` builds and installs them before the tests.

## Decoding parts of large images (the app)

The app shows very large images (photos of 100 MP and more, long screenshots) by decoding only the part on the screen, at the scale it is shown, with decoders it brings: `region/` (C, for Android and iOS) over libheif with libde265, libjpeg-turbo, zlib and lcms2, which `build-region.sh <target>` builds as static libraries from `sources.txt` with our patches (`host` for the tests, `android-arm64-v8a`, `android-armeabi-v7a`, `android-x86_64`).

- HEIC made of tiles (the photos of phones): only the tiles of the part are decoded (libheif places the tiles of rotated photos by `heif/0001`).
- JPEG: rows are decoded from the top, only the columns of the part, made smaller by the DCT where it can.
- PNG: opening the image decodes it once and keeps an entry into its compressed data about every megabyte of rows (as zlib's zran.c), with the row before it; a part is decoded from the entry before it.

Colours are converted to sRGB from the embedded profile, and the orientation is applied. `region/test/test.sh` (in `misc/check.sh`) compares the parts with whole images decoded by libheif, libjpeg-turbo and libpng: the same pixels at full size, their averages when smaller. Measured on a server's processor: a screen of 1080 × 2400 at the bottom of a 200 MP HEIC in 0.17 s and 96 MB at most, where decoding it whole takes 3.7 s and 870 MB.

## Releasing

Docker images install the release named in `release.txt` (its URL and SHA-256). Releases are built on Rocky Linux 8 (glibc 2.28, the oldest that Node.js 24 runs on), so that they run on every Linux that runs the server:

1. Run the workflow _Native libraries_ (`.github/workflows/native.yml`) with the name of the release, e.g. `8.18.7-1`.
2. Publish its artifact (the archive and its `.sha256`) as a release of the repository, with the tag `native-<release>`.
3. Put the URL of the archive and its SHA-256 in `release.txt`.

Without Docker, download the archive of the release, check its SHA-256, and run `server/bin/install-native` with it after `pnpm install` (or build it yourself with `native/build.sh`).

## Licences and patents

The libraries keep their licences (libvips, libheif, libde265, glib and others are LGPL; the archive has their sources list and our patches, so that they can be built again and linked with other versions). The archive includes a decoder of HEVC (libde265), which HEIC photos need. HEVC is covered by patents in some countries; whoever deploys the server is responsible for what their use of it requires. We provide the program and its code.
