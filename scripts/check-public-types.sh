#!/usr/bin/env bash
#
# Guard the public declaration surface.
#
# `dist/index.d.ts` and `dist/api/*.d.ts` are what a consumer's type-checker
# reads. This script fails the build when they expose the internal cost algebra
# or test helpers.
#
# It deliberately does NOT reject references to `store/core` or `store/features`.
# The public namespaces are assembled by re-exporting those modules, `files`
# ships all of `dist`, and the CI `package` job type-checks a real consumer
# against the packed tarball — so those references resolve and are by design.
# What must not escape is the `$prove` / `LogCost` cost algebra, which would
# force consumers to depend on internal complexity annotations, and anything
# from `test-utils`, which is not packaged at all.
#
# Run standalone against a different tree with DIST_DIR, and self-test with
# `bash scripts/check-public-types.sh --self-test`.

set -euo pipefail

dist_dir=${DIST_DIR:-dist}

# Patterns that must never appear in a public declaration file, each with the
# reason reported when it does.
declare -a forbidden_patterns=(
  'types/cost-doc|the internal cost-doc module'
  'LogCost|the LogCost cost wrapper'
  'LinearCost|the LinearCost cost wrapper'
  'ConstCost|the ConstCost cost wrapper'
  'CostDoc|internal cost-algebra types'
  'test-utils|test helpers that are not packaged'
)

check_dist() {
  local dir=$1
  local -a public_files=()

  if [[ -f $dir/index.d.ts ]]; then
    public_files+=("$dir/index.d.ts")
  fi
  while IFS= read -r -d '' file; do
    public_files+=("$file")
  done < <(find "$dir/api" -name '*.d.ts' -print0 2>/dev/null)

  if [[ ${#public_files[@]} -eq 0 ]]; then
    echo "ERROR: no public declaration files found under $dir" >&2
    return 1
  fi

  local failed=0
  for entry in "${forbidden_patterns[@]}"; do
    local pattern=${entry%%|*}
    local reason=${entry#*|}
    if grep -n "$pattern" "${public_files[@]}" >/dev/null 2>&1; then
      echo "ERROR: public API declarations expose $reason" >&2
      grep -n "$pattern" "${public_files[@]}" >&2
      failed=1
    fi
  done

  return "$failed"
}

self_test() {
  local tmp
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' RETURN

  # Negative fixture: a clean surface must pass.
  mkdir -p "$tmp/clean/api"
  echo 'export declare const a: number;' >"$tmp/clean/index.d.ts"
  echo 'export declare const b: string;' >"$tmp/clean/api/query.d.ts"
  if ! DIST_DIR="$tmp/clean" check_dist "$tmp/clean" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: a clean declaration surface was rejected" >&2
    return 1
  fi

  # Positive fixtures: each forbidden pattern must be caught.
  for entry in "${forbidden_patterns[@]}"; do
    local pattern=${entry%%|*}
    local case_dir="$tmp/leak"
    rm -rf "$case_dir"
    mkdir -p "$case_dir/api"
    echo 'export declare const a: number;' >"$case_dir/index.d.ts"
    echo "export declare const leak: $pattern;" >"$case_dir/api/query.d.ts"
    if check_dist "$case_dir" >/dev/null 2>&1; then
      echo "SELF-TEST FAILED: a leak of '$pattern' was not detected" >&2
      return 1
    fi
  done

  # A missing surface must be an error, not a silent pass.
  mkdir -p "$tmp/empty"
  if check_dist "$tmp/empty" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: an empty dist directory was accepted" >&2
    return 1
  fi

  echo "OK: check-public-types self-test passed"
}

if [[ ${1:-} == "--self-test" ]]; then
  self_test
  exit $?
fi

if check_dist "$dist_dir"; then
  echo "OK: public API declarations expose no cost algebra or test helpers"
else
  exit 1
fi
