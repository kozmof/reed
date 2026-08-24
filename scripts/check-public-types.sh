#!/usr/bin/env bash
set -euo pipefail

if grep -l 'types/cost-doc' dist/api/*.d.ts >/dev/null; then
  echo "ERROR: public API declarations expose internal cost types" >&2
  grep -n 'types/cost-doc' dist/api/*.d.ts >&2
  exit 1
fi

echo "OK: public API declarations do not expose internal cost types"
