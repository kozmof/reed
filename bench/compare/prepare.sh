#!/usr/bin/env bash
# Export a commit into a directory and build it, ready for run.ts.
#
# Usage: bash bench/compare/prepare.sh <git-ref> <out-dir>
#
# Uses `git archive` rather than a worktree so the export carries no git
# metadata. node_modules is symlinked from the current checkout, which is valid
# only while the ref's package.json/pnpm-lock.yaml dependencies match; the
# script refuses otherwise.
set -euo pipefail

ref="${1:?usage: prepare.sh <git-ref> <out-dir>}"
out="${2:?usage: prepare.sh <git-ref> <out-dir>}"
root="$(git rev-parse --show-toplevel)"

if ! git -C "$root" diff --quiet "$ref" HEAD -- pnpm-lock.yaml; then
  echo "pnpm-lock.yaml differs between $ref and HEAD; install dependencies in $out instead" >&2
  exit 1
fi

rm -rf "$out"
mkdir -p "$out"
git -C "$root" archive "$ref" | tar -x -C "$out"
ln -s "$root/node_modules" "$out/node_modules"
(cd "$out" && npx vite build --logLevel warn)
echo "built $(git -C "$root" rev-parse --short "$ref") -> $out/dist/reed.js"
