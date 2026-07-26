#!/usr/bin/env bash
# Stamp a version into every file that carries one.
#
# The git tag is the source of truth for a release — none of this is meant to be
# committed. CI runs it after `npm ci` (package.json must still match
# package-lock.json when npm ci runs) and before anything that reads a version:
# vue-tsc, cargo, tauri-action.
#
#   scripts/set-version.sh 1.2.3
#   scripts/set-version.sh v1.2.3   # a leading v is stripped
set -euo pipefail

version="${1:?usage: set-version.sh <version>}"
version="${version#v}"

case "$version" in
  *[!0-9.a-zA-Z+-]* | '') echo "set-version: bad version '$version'" >&2; exit 1 ;;
esac

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

# Rewrite in place via a temp file: sed -i is spelled differently on GNU and BSD.
rewrite() {
  local file="$1"; shift
  "$@" < "$file" > "$file.tmp"
  mv "$file.tmp" "$file"
}

# sed rather than jq on the JSON, so the rest of the file keeps its formatting.
# Both files declare the package version as the first top-level "version" key.
for json in package.json src-tauri/tauri.conf.json; do
  rewrite "$json" awk -v v="$version" '
    !done && /^[[:space:]]*"version"[[:space:]]*:/ {
      sub(/:[[:space:]]*"[^"]*"/, ": \"" v "\""); done = 1
    }
    { print }
  '
done

# In a Cargo manifest only the first `version =` is the [package] one — later
# ones belong to dependency tables. Internal path deps do carry a version
# requirement, though, and it has to track the member version or Cargo stops
# resolving the workspace.
for manifest in Cargo.toml src-tauri/Cargo.toml rebase-core/Cargo.toml rebase-cli/Cargo.toml; do
  [ -f "$manifest" ] || continue
  rewrite "$manifest" awk -v v="$version" '
    !done && /^version[[:space:]]*=/ { print "version = \"" v "\""; done = 1; next }
    /^[[:space:]]*rebase(-core|-cli)?[[:space:]]*=.*path[[:space:]]*=/ {
      sub(/version[[:space:]]*=[[:space:]]*"[^"]*"/, "version = \"" v "\"")
    }
    { print }
  '
done

# Workspace members are pinned by version in Cargo.lock; refresh it so a later
# --locked build still agrees. Offline resolves from a warm registry cache; on a
# cold one cargo needs the index, so fall back.
cargo update --workspace --offline || cargo update --workspace

echo "set version to $version"
