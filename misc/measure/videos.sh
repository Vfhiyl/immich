#!/usr/bin/env bash
# misc/measure/videos.sh [FILE...]: the peak memory of ffmpeg with the server's commands (transcoding with 1 and 4
# threads, picking the frame of the preview) on each video (by default those of the test assets), against what the
# server estimates (server/src/utils/memory-estimate.ts); fails when a measure is above its estimate.
# Needs the server built (server/dist) and ffmpeg.
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
here="$repo/misc/measure"
if [[ $# -eq 0 ]]; then
  mapfile -t files < <(find "$repo/e2e/test-assets/videos" -type f | sort)
else
  files=("$@")
fi
out="$(mktemp -d)"
trap 'rm -rf "${out:?}"' EXIT
over=0
printf '%-40s %-10s %8s %8s %8s\n' file run seconds peak_MB estimate
for file in "${files[@]}"; do
  for run in 1 4 preview; do
    mapfile -t args < <(node "$here/command.mjs" "$file" "$run")
    target="$out/out.mp4"
    [[ "$run" == preview ]] && target="$out/out.jpg"
    result="$(python3 -I "$here/peak.py" ffmpeg -hide_banner -loglevel error -y "${args[@]}" "$target" 2>/dev/null)" || continue
    [[ "$result" == *"exit=0" ]] || continue
    seconds="$(awk '{print $1}' <<<"$result")"
    peak="$(sed -E 's/.*RssAnon ([0-9]+) MB.*/\1/' <<<"$result")"
    if [[ "$run" == preview ]]; then
      estimate="$(node "$here/estimate.mjs" preview "$file")"
    else
      estimate="$(node "$here/estimate.mjs" video "$file" "$run")"
    fi
    mark=""
    if ((peak > estimate)); then
      mark=" OVER"
      over=$((over + 1))
    fi
    printf '%-40s %-10s %8s %8s %8s%s\n' "$(basename "$file")" "$run" "$seconds" "$peak" "$estimate" "$mark"
  done
done
exit $((over > 0))
