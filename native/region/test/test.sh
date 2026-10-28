#!/usr/bin/env bash
# Builds immich-region for this machine (native/build-region.sh host) and compares the parts it decodes with whole images
# decoded by libheif, libjpeg-turbo and libpng (region-test.c), on photos of the test assets and long PNGs it makes.
# Then the app's bridge to it (region_jni.c), on this machine's JVM (RegionDecoderTest.java).
set -euo pipefail

REGION="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$REGION/../.." && pwd)"
WORK="${IMMICH_NATIVE_WORK:-$HOME/.cache/immich-native}"
"$REGION/../build-region.sh" host > "$WORK/region-host-build.log" 2>&1 || { tail -40 "$WORK/region-host-build.log"; exit 1; }
PREFIX="$WORK/region/host"

out="$(mktemp -d)"
trap 'rm -rf "${out:?}"' EXIT
# shellcheck disable=SC2046
gcc -std=c11 -D_DEFAULT_SOURCE -O2 -Wall -Wextra -Werror -o "$out/region-test" "$REGION"/*.c "$REGION/test/region-test.c" \
  -I"$REGION" \
  -I"$PREFIX/include" -L"$PREFIX/lib" -lheif -lde265 -lpng16 -ljpeg -llcms2 -lz -lstdc++ -lm -lpthread

assets="$REPO/e2e/test-assets/formats"
"$out/region-test" --make-png "$out/long-photo.png" 1200 9000 photo
"$out/region-test" --make-png "$out/long-text.png" 1080 20000 text
"$out/region-test" --make-png "$out/palette.png" 777 3000 palette
"$out/region-test" "$assets/heic/IMG_2682.heic" "$assets/motionphoto/samsung-one-ui-6.heic" \
  "$assets/motionphoto/pixel-8a.jpg" "$assets/motionphoto/samsung-one-ui-6.jpg" "$assets/jpg/el_torcal_rocks.jpg" \
  "$assets/png/density_plot.png" "$out/long-photo.png" "$out/long-text.png" "$out/palette.png"

# the app's bridge, built as the app builds it (CMakeLists.txt) but for this machine
java_home="$(dirname "$(dirname "$(readlink -f "$(command -v javac)")")")"
gcc -std=c11 -D_DEFAULT_SOURCE -O2 -Wall -Wextra -Werror -Wno-unused-parameter -shared -fPIC -fvisibility=hidden \
  -o "$out/libimmich_region.so" "$REPO/mobile/android/app/src/main/cpp/region_jni.c" "$REGION"/*.c \
  -I"$REGION" -I"$java_home/include" -I"$java_home/include/linux" \
  -I"$PREFIX/include" -L"$PREFIX/lib" -lheif -lde265 -ljpeg -llcms2 -lz -lstdc++ -lm -lpthread
java -Djava.library.path="$out" "$REGION/test/RegionDecoderTest.java" "$assets/jpg/el_torcal_rocks.jpg" \
  "$assets/heic/IMG_2682.heic" "$REGION/test/test.sh"
