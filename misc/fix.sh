#!/usr/bin/env bash
#
# Formats the files changed since the last commit (and new ones) and applies the lint fixes that can be applied, in
# each package, with the tools and settings of that package: run before misc/check.sh, whose formatting and lint steps
# then pass unless something needs a hand.
#
# Usage: misc/fix.sh

set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

changed() {
  git -C "$repo/$1" diff --name-only --relative HEAD -- .
  git -C "$repo/$1" ls-files --others --exclude-standard
}

for package in server web e2e packages/cli; do
  mapfile -t files < <(changed "$package" | sort -u | while read -r file; do [[ -f "$repo/$package/$file" ]] && echo "$file"; done)
  [[ ${#files[@]} -eq 0 ]] && continue
  cd "$repo/$package"
  mapfile -t formatted < <(printf '%s\n' "${files[@]}" | grep -E '\.(ts|mts|js|mjs|svelte|json|md|css|html|yaml|yml)$' || true)
  mapfile -t linted < <(printf '%s\n' "${files[@]}" | grep -E '\.(ts|svelte)$' || true)
  if [[ ${#formatted[@]} -gt 0 ]]; then
    ./node_modules/.bin/prettier --write --log-level warn "${formatted[@]}"
  fi
  if [[ ${#linted[@]} -gt 0 ]]; then
    SYNCKIT_TIMEOUT=120000 ./node_modules/.bin/eslint --fix "${linted[@]}" || true
  fi
done

cd "$repo"
mapfile -t i18n < <(git diff --name-only HEAD -- i18n)
if [[ ${#i18n[@]} -gt 0 ]]; then
  ./node_modules/.bin/prettier --write --log-level warn "${i18n[@]}"
fi
mapfile -t docs < <(git diff --name-only --relative HEAD -- docs/docs/administration/storage-backends.md)
if [[ ${#docs[@]} -gt 0 ]]; then
  web/node_modules/.bin/prettier --write --log-level warn "${docs[@]}"
fi
mapfile -t dart < <({ git diff --name-only HEAD -- mobile/lib mobile/tool mobile/test; git ls-files --others --exclude-standard -- mobile/lib mobile/tool mobile/test; } | grep '\.dart$' | grep -vE '\.(g|drift|gr)\.dart$' || true)
if [[ ${#dart[@]} -gt 0 ]] && command -v dart >/dev/null; then
  dart format "${dart[@]}" >/dev/null
fi
