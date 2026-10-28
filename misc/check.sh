#!/usr/bin/env bash
#
# Runs every check of a change in one go and stops at the first failure:
#   formatting, lint and types; database schema and generated SQL; unit, medium, contract and end-to-end tests; the web
#   app.
#
# Usage: misc/check.sh [--quick]     --quick skips the medium, contract and end-to-end tests
#        misc/fix.sh first formats the changed files and applies the lint fixes that can be applied
#
# Needs: Node and pnpm with dependencies installed (`pnpm install`), ffmpeg, redis-server, oazapfts (the version
# pinned in mise.toml), uv (the version pinned in machine-learning/mise.toml) with Python 3.12 and Flutter on PATH, OPENAPI_GENERATOR_JAR (the openapi-generator-cli jar), a JDK and the
# Android SDK at ANDROID_HOME (Gradle downloads the rest from Maven Central, or a mirror set in an init script), and
# a C/C++ toolchain, meson (>= 1.11), cmake, nasm, Rust with cargo-c (native/README.md) to build the native libraries,
# PostgreSQL with the vector extension at CHECK_POSTGRES_URL (a server URL without database name,
# default postgres://postgres:postgres@localhost:5432). Playwright downloads its Chromium (of the version
# @playwright/test pins) the first time the pages are tested in a browser. Nothing here needs Docker.

set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
server="$repo/server"
e2e="$repo/e2e"
postgres="${CHECK_POSTGRES_URL:-postgres://postgres:postgres@localhost:5432}"
quick=false
[[ "${1:-}" == "--quick" ]] && quick=true

work="$(mktemp -d)"
check_db="immich_check_$$"
trap 'psql "$postgres/postgres" -qc "DROP DATABASE IF EXISTS $check_db WITH (FORCE)" >/dev/null 2>&1 || true; rm -rf "$work" "$server/.check"; remove_orphans' EXIT

# tests leave exiftool processes of this repository behind (upstream's medium tests end their workers without
# stopping it): remove the ones whose parent is gone
remove_orphans() {
  local pid
  for pid in $(pgrep -f "$repo/node_modules/.*/exiftool -stay_open" || true); do
    if [[ "$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')" == "1" ]]; then
      kill "$pid" 2>/dev/null || true
    fi
  done
}

results=()
step() {
  local name="$1"
  shift
  local started=$SECONDS
  printf '\n==> %s\n' "$name"
  # a subshell run as a plain command: in a condition (`if`, `||`, `&&`) bash ignores `set -e`, so a step of several
  # commands would only fail when its last command does
  local status
  set +e
  (
    set -e
    "$@"
  ) >"$work/step.log" 2>&1
  status=$?
  set -e
  if [[ $status -eq 0 ]]; then
    results+=("ok    $name ($((SECONDS - started))s)")
  else
    tail -n 80 "$work/step.log"
    results+=("FAIL  $name ($((SECONDS - started))s)")
    summary
    exit 1
  fi
}

summary() {
  printf '\n==> Summary\n'
  printf '%s\n' "${results[@]}"
}

bin() {
  echo "$1/node_modules/.bin/$2"
}

# --- static checks ---

server_format() { cd "$server" && "$(bin "$server" prettier)" --check src test; }
server_lint() { cd "$server" && "$(bin "$server" eslint)" "src/**/*.ts" "test/**/*.ts" --max-warnings 0; }
server_types() { cd "$server" && "$(bin "$server" tsc)" --noEmit; }

# the end-to-end project also holds upstream suites that need Docker, so only the storage backend suite is checked
e2e_files=(
  src/storage-backends.ts src/specs/storage-backends src/specs/storage-backends-web vitest.storage-backends.config.ts
  playwright.storage-backends.config.ts
)
e2e_format() { cd "$e2e" && "$(bin "$e2e" prettier)" --check "${e2e_files[@]}"; }
e2e_lint() { cd "$e2e" && "$(bin "$e2e" eslint)" "${e2e_files[@]}" --max-warnings 0; }
e2e_types() { cd "$e2e" && "$(bin "$e2e" tsc)" --noEmit; }

# the pages of this fork (the others are upstream's); the examples of storage backends are checked by the unit tests
docs_format() {
  cd "$repo/docs"
  "$(bin "$repo/docs" prettier)" --check docs/administration/storage-backends.md \
    docs/administration/machine-learning-models.md docs/administration/jobs-workers.md \
    docs/administration/native-libraries.md
}

# the web app, against the SDK built from the generated client (see open_api)
web="$repo/web"
web_format() { cd "$web" && "$(bin "$web" prettier)" --cache --check . && cd "$repo" && "$(bin "$repo" prettier)" --check i18n/; }
# the tailwind rules wait for a worker (synckit), whose default timeout a busy machine exceeds
web_lint() { cd "$web" && SYNCKIT_TIMEOUT=120000 "$(bin "$web" eslint)" . --max-warnings 0 --concurrency 6; }
web_types() {
  cd "$repo" && pnpm --filter @immich/sdk build
  cd "$web"
  "$(bin "$web" svelte-kit)" sync
  "$(bin "$web" tsc)" --noEmit
  "$(bin "$web" svelte-check)" --no-tsconfig --fail-on-warnings --compiler-warnings 'state_referenced_locally:ignore'
}
# in English, which some tests expect dates and numbers in
web_unit() { cd "$web" && LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 "$(bin "$web" vitest)" --run; }
# served by the server in the end-to-end tests in a browser
web_build() { cd "$web" && "$(bin "$web" vite)" build; }

# the CLI, against the SDK built for the web app; built for the end-to-end tests, which run it
cli="$repo/packages/cli"
cli_check() {
  cd "$cli"
  "$(bin "$cli" prettier)" --check .
  "$(bin "$cli" eslint)" 'src/**/*.ts' --max-warnings 0
  "$(bin "$cli" tsc)" --noEmit
  "$(bin "$cli" vitest)" --run
  "$(bin "$cli" vite)" build
}

# the machine learning service, with upstream's checks (machine-learning/mise.toml), on the CPU build; uv installs the
# locked dependencies into machine-learning/.venv, with the Python of mise.toml (3.12, rather than the 3.13 of
# .python-version) found on PATH rather than downloaded
ml="$repo/machine-learning"
ml_check() {
  cd "$ml"
  unset VIRTUAL_ENV
  export UV_PYTHON_DOWNLOADS=never UV_PYTHON=3.12
  uv sync --locked --extra cpu
  uv run ruff format --check immich_ml scripts test_main.py conftest.py
  uv run ruff check immich_ml scripts test_main.py conftest.py
  uv run mypy --strict immich_ml/ scripts/ test_main.py conftest.py
  uv run pytest --cov=immich_ml --cov-report term-missing
}

# the mobile app, against the Dart client generated from the API description (not tracked, like upstream); needs
# Flutter (the version pinned in mobile/mise.toml) and openapi-generator-cli on PATH
mobile="$repo/mobile"
mobile_codegen() {
  # the generator jar of the version upstream pins (open-api/openapitools.json), never downloaded here
  : "${OPENAPI_GENERATOR_JAR:?set OPENAPI_GENERATOR_JAR to openapi-generator-cli-<version>.jar}"
  local tools="$work/openapi-generator"
  mkdir -p "$tools"
  printf '#!/usr/bin/env sh\nexec java -jar "%s" "$@"\n' "$OPENAPI_GENERATOR_JAR" >"$tools/openapi-generator-cli"
  chmod +x "$tools/openapi-generator-cli"
  local before="$work/mobile-before.diff"
  mobile_changes >"$before"
  cd "$repo/open-api" && PATH="$tools:$PATH" bash bin/generate-dart-sdk.sh
  cd "$mobile"
  flutter pub get --enforce-lockfile
  dart run build_runner build --delete-conflicting-outputs
  dart format lib/routing/router.gr.dart
  dart run drift_dev make-migrations
  dart run drift_dev schema generate --data-classes --companions drift_schemas/main/ test/drift/main/generated/
  find pigeon -name '*.dart' -print0 | xargs -0 -n1 -P4 -I{} dart run pigeon --input {}
  dart format lib/platform/
  dart run easy_localization:generate -S ../i18n
  dart format lib/generated/codegen_loader.g.dart
  dart run bin/generate_keys.dart
  dart format lib/generated/translations.g.dart
  # nothing generated is tracked: what generating changed is a change of the sources
  mobile_changes | diff -u "$before" - >&2
}
# the changes of the mobile app's tracked files, and its untracked files, against the last commit
mobile_changes() {
  git -C "$repo" diff --binary -- mobile
  git -C "$repo" status --porcelain --untracked-files=all -- mobile
}
# what upstream formats (mise run format)
mobile_format() {
  cd "$mobile"
  find lib tool -name '*.dart' -not -name '*.g.dart' -not -name '*.drift.dart' -not -name '*.gr.dart' -print0 |
    xargs -0 dart format --set-exit-if-changed --output=none
}
mobile_analyze() { cd "$mobile" && dart analyze --fatal-infos; }
# in English, like the web app
mobile_unit() { cd "$mobile" && LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 flutter test --reporter=compact; }
# the main timeline with 400 000 server photos: a page anywhere in milliseconds
mobile_timeline_scale() {
  cd "$mobile" && IMMICH_TIMELINE_SCALE=400000 flutter test test/medium/scale/main_timeline_scale_test.dart
}
# the native code of the Android app: its unit tests, and the app built (with the Dart code compiled into it)
mobile_android() {
  : "${ANDROID_HOME:?set ANDROID_HOME to the Android SDK}"
  cd "$mobile/android" && ./gradlew --quiet :app:testDebugUnitTest :app:assembleDebug
}

# --- build, schema and generated SQL ---

# the app decodes parts of large images with native/region, built for this machine and compared with whole decodes
native_region() { "$repo/native/region/test/test.sh"; }

# the native libraries (libvips in sharp's module, immich-thumbnail), built from the sources and patches in native/
# (only what changed is built again) and installed for every sharp of the repository, which loads nothing else
native() {
  local output="${IMMICH_NATIVE_WORK:-$HOME/.cache/immich-native}/output"
  "$repo/native/build.sh" "$output"
  "$server/bin/install-native" "$output" "$repo"
}

server_build() { cd "$server" && "$(bin "$server" nest)" build; }

schema() {
  cd "$server"
  psql "$postgres/postgres" -qc "CREATE DATABASE $check_db" >/dev/null
  local sql_tools
  sql_tools="$(bin "$server" sql-tools)"
  "$sql_tools" migrations verify-order
  "$sql_tools" -u "$postgres/$check_db" migrations run
  # generating a migration from the built schema must find nothing to change
  "$sql_tools" -u "$postgres/$check_db" migrations generate .check/Drift | tee "$work/drift.log"
  grep -q 'No changes detected' "$work/drift.log"
}

generated_sql() {
  cd "$server"
  DB_URL="$postgres/$check_db" DB_VECTOR_EXTENSION=pgvector node ./dist/bin/sync-sql.js
  git diff --exit-code -- src/queries
  test -z "$(git ls-files --others --exclude-standard -- src/queries)"
}

# the API description and the TypeScript SDK generated from it; the Dart SDK of the app is not tracked
open_api() {
  cd "$server"
  node ./dist/bin/sync-open-api.js
  cd "$repo"
  oazapfts --optimistic --argumentStyle=object --useEnumType --allSchemas open-api/immich-openapi-specs.json \
    packages/sdk/src/fetch-client.ts
  git diff --exit-code -- open-api/immich-openapi-specs.json packages/sdk/src/fetch-client.ts
}

# --- tests ---

# run from outside the repository: some tests resolve relative paths against the working directory, which must not
# be below the media location the tests use (/data)
unit() { cd "$work" && "$(bin "$server" vitest)" --config "$server/test/vitest.config.mjs" --run; }

medium() {
  cd "$server"
  MEDIUM_TEST_POSTGRES_URL="$postgres" "$(bin "$server" vitest)" --config test/vitest.config.medium.postgres.mjs --run
}

# blob store contract against S3 services that are downloaded (pinned, verified) and started by the tests
contract() { cd "$server" && "$(bin "$server" vitest)" --config test/vitest.config.contract.mjs --run; }

end_to_end() {
  cd "$e2e"
  # the resumable upload client of the mobile app runs against the server too
  E2E_DART="$(command -v dart)" E2E_STORAGE_POSTGRES_URL="$postgres" "$(bin "$e2e" vitest)" --run \
    --config vitest.storage-backends.config.ts
}

# the pages of storage backends in a browser, against a server that serves the built web app
end_to_end_web() {
  cd "$e2e"
  "$(bin "$e2e" playwright)" install --only-shell chromium
  E2E_STORAGE_POSTGRES_URL="$postgres" "$(bin "$e2e" playwright)" test --config playwright.storage-backends.config.ts
}

step 'native: libraries built and installed' native
step "native: the app's decoding of parts of images" native_region
step 'server: formatting' server_format
step 'server: lint' server_lint
step 'server: types' server_types
step 'e2e: formatting' e2e_format
step 'e2e: lint' e2e_lint
step 'e2e: types' e2e_types
step 'docs: formatting' docs_format
step 'server: build' server_build
step 'schema: migrations and drift' schema
step 'server: generated SQL is up to date' generated_sql
step 'open-api: specification and SDK are up to date' open_api
step 'server: unit tests' unit
step 'web: formatting' web_format
step 'web: lint' web_lint
step 'web: types' web_types
step 'web: unit tests' web_unit
step 'web: build' web_build
step 'cli: formatting, lint, types, unit tests and build' cli_check
step 'machine-learning: formatting, lint, types and unit tests' ml_check
step 'mobile: generated code' mobile_codegen
step 'mobile: formatting' mobile_format
step 'mobile: analysis' mobile_analyze
step 'mobile: unit tests' mobile_unit
step 'mobile: timeline at scale' mobile_timeline_scale
step 'mobile: Android app' mobile_android
if [[ "$quick" == false ]]; then
  step 'server: medium tests' medium
  remove_orphans
  step 'server: blob store contract tests' contract
  step 'e2e: storage backends' end_to_end
  step 'e2e: storage pages in a browser' end_to_end_web
fi

summary
