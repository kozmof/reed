#!/usr/bin/env bash
set -euo pipefail
archive=${1:?usage: check-package-contents.sh <package.tgz>}
required_paths=(package/package.json package/README.md package/LICENCE package/dist/reed.js package/dist/index.d.ts)
for required_path in "${required_paths[@]}"; do
  if ! tar -tzf "$archive" "$required_path" >/dev/null 2>&1; then
    echo "ERROR: package is missing $required_path" >&2
    exit 1
  fi
done
unexpected=$(tar -tzf "$archive" | awk '$0 != "package/package.json" && $0 != "package/README.md" && $0 != "package/LICENCE" && $0 !~ /^package\/dist\// { print }')
if [[ -n $unexpected ]]; then
  echo "ERROR: package contains unexpected paths:" >&2
  echo "$unexpected" >&2
  exit 1
fi
echo "OK: required package files are present and all payload files are allowed"
