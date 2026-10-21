#!/usr/bin/env bash
#
# Runs every check of a change in one go and stops at the first failure:
#   formatting, lint and types; database schema and generated SQL; unit, medium, contract and end-to-end tests.
#
# Usage: misc/check.sh [--quick]     --quick skips the medium, contract and end-to-end tests
#
# Needs: Node and pnpm with dependencies installed (`pnpm install`), ffmpeg, redis-server and oazapfts (the version
# pinned in mise.toml) on PATH, and
# PostgreSQL with the vector extension at CHECK_POSTGRES_URL (a server URL without database name,
# default postgres://postgres:postgres@localhost:5432). Nothing here needs Docker.

set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
server="$repo/server"
e2e="$repo/e2e"
postgres="${CHECK_POSTGRES_URL:-postgres://postgres:postgres@localhost:5432}"
quick=false
[[ "${1:-}" == "--quick" ]] && quick=true

work="$(mktemp -d)"
check_db="immich_check_$$"
trap 'psql "$postgres/postgres" -qc "DROP DATABASE IF EXISTS $check_db WITH (FORCE)" >/dev/null 2>&1 || true; rm -rf "$work" "$server/.check"' EXIT

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
e2e_files=(src/storage-backends.ts src/specs/storage-backends vitest.storage-backends.config.ts)
e2e_format() { cd "$e2e" && "$(bin "$e2e" prettier)" --check "${e2e_files[@]}"; }
e2e_lint() { cd "$e2e" && "$(bin "$e2e" eslint)" "${e2e_files[@]}" --max-warnings 0; }

# --- build, schema and generated SQL ---

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
  E2E_STORAGE_POSTGRES_URL="$postgres" "$(bin "$e2e" vitest)" --run --config vitest.storage-backends.config.ts
}

step 'server: formatting' server_format
step 'server: lint' server_lint
step 'server: types' server_types
step 'e2e: formatting' e2e_format
step 'e2e: lint' e2e_lint
step 'server: build' server_build
step 'schema: migrations and drift' schema
step 'server: generated SQL is up to date' generated_sql
step 'open-api: specification and SDK are up to date' open_api
step 'server: unit tests' unit
if [[ "$quick" == false ]]; then
  step 'server: medium tests' medium
  step 'server: blob store contract tests' contract
  step 'e2e: storage backends' end_to_end
fi

summary
