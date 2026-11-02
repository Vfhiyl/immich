#!/usr/bin/env bash
# misc/measure/images.sh [FILE...]: the peak memory of immich-thumbnail making the preview of each photo, and its
# full-size image (by default the photos of the test assets, and of test-image/ with MEASURE_SAMPLES=1), against what
# the server estimates it to be
# (server/src/utils/memory-estimate.ts): a photo measured above its estimate is marked, and the script fails.
# Needs the server built (server/dist) and the native libraries installed (server/native).
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
program="$repo/server/native/bin/immich-thumbnail"
here="$repo/misc/measure"
if [[ $# -eq 0 ]]; then
  folders=("$repo/e2e/test-assets/formats")
  [[ "${MEASURE_SAMPLES:-}" == 1 && -d "$repo/test-image" ]] && folders+=("$repo/test-image")
  mapfile -t files < <(find "${folders[@]}" -type f \
    \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' -o -iname '*.heic' -o -iname '*.heif' -o -iname '*.avif' \
    -o -iname '*.jxl' -o -iname '*.webp' -o -iname '*.dng' -o -iname '*.cr2' -o -iname '*.cr3' -o -iname '*.nef' \
    -o -iname '*.arw' -o -iname '*.raf' -o -iname '*.rw2' \) 2>/dev/null | sort)
else
  files=("$@")
fi
out="$(mktemp -d)"
trap 'rm -rf "${out:?}"' EXIT
over=0
printf '%-60s %8s %8s %8s\n' file seconds peak_MB estimate
for file in "${files[@]}"; do
  for whole in "" whole; do
    size=1440
    [[ -n "$whole" ]] && size=0
    result="$(python3 -I "$here/peak.py" "$program" "$file" "$size" p3 --output "$out/x.v" 2>/dev/null)" || continue
    [[ "$result" == *"exit=0" ]] || continue
    seconds="$(awk '{print $1}' <<<"$result")"
    peak="$(sed -E 's/.*RssAnon ([0-9]+) MB.*/\1/' <<<"$result")"
    estimate="$(node "$here/estimate.mjs" image "$file" "$whole")"
    mark=""
    if ((peak > estimate)); then
      mark=" OVER"
      over=$((over + 1))
    fi
    printf '%-60s %8s %8s %8s%s\n' "$(basename "$file")${whole:+ (whole)}" "$seconds" "$peak" "$estimate" "$mark"
  done
done
exit $((over > 0))
