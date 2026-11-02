# Measuring the memory of heavy work

The server starts heavy work (decoding a photo for its files, running ffmpeg) when the memory it is estimated to take is available (`server/src/utils/memory-estimate.ts`, see the jobs page of the documentation). The estimates come from measures of these scripts, which `misc/check.sh` runs on the test assets: a measure above its estimate fails, and the estimates are to be raised (after a new version of a decoder or of ffmpeg, say).

- `images.sh [FILE...]`: immich-thumbnail making the preview and the full-size image of photos (`MEASURE_SAMPLES=1` adds the samples of `test-image/`).
- `videos.sh [FILE...]`: ffmpeg with the server's commands, transcoding with 1 and 4 threads and picking the frame of the preview.
- `peak.py PROGRAM ARGS...`: the time and the peak memory (anonymous, and of mapped files) of a program.

They need the server built (`server/dist`), the native libraries installed (`server/native`) and ffmpeg. Measures are of anonymous memory (what cannot be given back but to swap), on the machine they run on: more cores make some of them larger (the threads of ffmpeg), which the estimates cover by the threads.
