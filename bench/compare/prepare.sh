#!/usr/bin/env bash
# Export a commit into a directory and build it, ready for run.ts.
#
# Usage: bash bench/compare/prepare.sh <git-ref> <out-dir>
#
# Use git archive to export files without Git metadata. Reuse node_modules
# through a symlink to the current checkout. Reject the requested ref if its
# pnpm-lock.yaml differs from HEAD. Keep installed dependencies in sync
# with that lockfile before running.
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
