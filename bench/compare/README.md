# Cross-version performance comparison

Use this harness to compare Reed's performance between two commits. Both builds
run the same workloads through the public API.

## Run it

Use Node 22.18 or later for native TypeScript type stripping. Build both commits, then pass their checkout directories or bundle paths to the comparison command.

```bash
# 1. Build both commits. Each export shares this checkout's node_modules.
bash bench/compare/prepare.sh 0321d08 /tmp/reed-base
bash bench/compare/prepare.sh HEAD    /tmp/reed-head

# 2. Compare. Writes report/perf-compare-<time>.{md,json}.
pnpm bench:compare --base /tmp/reed-base --head /tmp/reed-head

# Quick pass: first size only, fewer rounds, selected workloads.
pnpm bench:compare --base /tmp/reed-base --head /tmp/reed-head \
  --rounds 2 --samples 3 --sizes small --only undo-redo,attention-query
```

Options:

| Flag               | Default  | Meaning                                                                     |
| ------------------ | -------- | --------------------------------------------------------------------------- |
| `--rounds`         | 5        | Worker processes per version per cell, alternating base/head order          |
| `--samples`        | 10       | Timed samples per process                                                   |
| `--warmup`         | 2        | Untimed samples per process. Skipped once a sample exceeds 1 s              |
| `--budget`         | 20000    | Per-process time budget in ms. Sampling stops after 3 samples once exceeded |
| `--sizes`          | `all`    | `small` runs only each workload's first size                                |
| `--only`           | all      | Comma-separated workload names                                              |
| `--cpu`            | none     | Pin workers to this core with `taskset`                                     |
| `--out`            | `report` | Output directory                                                            |
| `--worker-timeout` | 900000   | Maximum time per worker process in ms                                       |

`prepare.sh` replaces its output directory and shares this checkout's `node_modules`. Use a disposable output path. The requested commit must have the same `pnpm-lock.yaml` as `HEAD`, and installed dependencies must match that lockfile.

## Method

- Every (version, workload, size, round) runs in a fresh `node --expose-gc`
  process, so one version's JIT and heap state never affect the other's.
- Rounds alternate base→head and head→base so drift lands on both sides.
- Fixtures are built outside the timed interval. A GC runs before each sample.
- The reported change is median(head) / median(base) with a 95% bootstrap
  confidence interval. The verdict is `faster` or `SLOWER` only when the
  interval excludes 1 ± 5%.
- Every workload returns a checksum of its output. The run exits non-zero if
  base and head disagree, unless the workload declares `outputMayDiffer`.
- The "alloc" column reports heap growth during the timed run. The "retained"
  column reports heap growth remaining after garbage collection.

## Adding a workload

Add an entry to `workloads.ts`. Use only the `R` module object, never `src/`
imports, so the workload runs against any build. Keep mutations inside the fixture returned by `prepare`. Return a checksum from `run`.
