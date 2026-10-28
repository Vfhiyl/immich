# Native Libraries

The server reads and writes images with libvips, through sharp. It does not use a libvips installed on the machine or one that comes with sharp's prebuilt packages: libvips and every library it uses are built from source with changes of our own, mostly to use less memory, and shipped as two files that depend on nothing but glibc (Linux x64 only):

- sharp's native module, with libvips inside;
- `immich-thumbnail`, a program that makes the image the preview, the thumbnail and the thumbhash of a photo are made from. It reads the photo once, from top to bottom, keeping only the lines it still needs, and runs in a process of its own, which gives all of its memory back when it is done.

A 48 MP photo takes about 80 MB to make its preview from, instead of about 250 to 500 MB; a 200 MP HEIC photo of a phone about 110 MB instead of about 900 MB. HEIC photos of phones are decoded a row of tiles at a time.

The sources, the patches (each says what it changes and why) and how to build them are in [`native/`](https://github.com/Vfhiyl/immich/tree/feat/object-storage/native) of the repository.

## Installing

The Docker image installs them. Without Docker, download the archive of the release named in `native/release.txt` of the repository, check its SHA-256, and install it after `pnpm install`:

```bash
server/bin/install-native immich-native-<release>-linux-x64.tar.gz
```

or build it from source with `native/build.sh` (see `native/README.md`). The server does not start without them.

## Patents and licences

The libraries include a decoder of HEVC (libde265), which HEIC photos need. HEVC is covered by patents in some countries. **Whoever deploys the server is responsible for what their use of it requires**; this project provides the program and its code. The libraries keep their licences (several are LGPL); the archive lists their sources and includes our patches, so that they can be built again.
