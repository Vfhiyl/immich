# What native/build.sh and native/build-region.sh share: the sources (sources.txt), our patches (patches/<name>/), and
# building a library only when it, its patches or how it is built changed. Sourced with NATIVE, DOWNLOADS, BUILD and
# PREFIX set.

source_field() { # name field
  awk -F'|' -v name="$1" -v field="$2" '!/^#/ && $1 == name { print $field }' "$NATIVE/sources.txt"
}

version_of() { source_field "$1" 2; }

# Downloads (once) and unpacks the source of a library into $BUILD/<name>, checks it, and applies our patches
unpack() {
  local name="$1" url sha256 archive directory
  url="$(source_field "$name" 3)"
  sha256="$(source_field "$name" 4)"
  [[ -n "$url" ]] || { echo "No source for $name in sources.txt" >&2; exit 1; }
  archive="$DOWNLOADS/$name-$(version_of "$name").${url##*.}"
  if [[ ! -f "$archive" ]]; then
    curl --fail --silent --show-error --location --retry 3 -o "$archive.part" "$url"
    mv "$archive.part" "$archive"
  fi
  echo "$sha256  $archive" | sha256sum --check --quiet

  directory="$BUILD/$name"
  rm -rf "${directory:?}"
  mkdir -p "$directory"
  tar --no-same-owner --strip-components=1 -xf "$archive" -C "$directory"
  cd "$directory"
  local patch
  for patch in "$NATIVE/patches/$name"/*.patch; do
    [[ -e "$patch" ]] || continue
    echo "Applying $(basename "$patch")"
    patch --quiet --forward --strip=1 < "$patch"
  done
}

# Builds a library unless the same source, patches and build script (and BUILD_KEY, if set) built it already, and
# nothing it may depend on (the libraries before it) was built again
REBUILT=false
build() {
  local name="$1" stamp
  stamp="$PREFIX/.built-$name"
  local key
  key="$(source_field "$name" 4) $( [[ $name == jpegli ]] && source_field libjpeg-turbo 4) $(cat "$NATIVE/patches/$name"/*.patch 2>/dev/null | sha256sum) $(declare -f "build_$name" | sha256sum)${BUILD_KEY:+ $BUILD_KEY}"
  if [[ $REBUILT == false && -f "$stamp" && "$(cat "$stamp")" == "$key" ]]; then
    return
  fi
  REBUILT=true
  echo "==> $name $(version_of "$name")"
  (unpack "$name" && "build_$name")
  echo "$key" > "$stamp"
}
