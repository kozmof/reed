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

## Targeted streaming and cache workloads

Compare commit `59520f7` with its parent using the workloads added for its streaming
and cache changes. Build both refs with `prepare.sh`, then select these workloads.

```bash
pnpm bench:compare --base /tmp/reed-base --head /tmp/reed-head \
  --only chunk-slow-fetch,viewport-prefetch,chunk-column-cache-edits,chunk-fragmented-evict-reload
```

| Workload                        | Scenario                                                                                                        | Measurements                                                                  |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `chunk-slow-fetch`              | Load 8 or 32 chunks with one fetch delayed by 40 ms                                                             | First readable chunk, total load time, peak concurrent fetches, notifications |
| `viewport-prefetch`             | Load one viewport chunk and prefetch 4 or 16 chunks on each side                                                | Viewport readiness, total load time, notifications                            |
| `chunk-column-cache-edits`      | Warm column indexes on 64 or 512 chunk-backed Unicode lines, then perform 128 edits with distant column queries | Elapsed time, heap growth, retained heap                                      |
| `chunk-fragmented-evict-reload` | Evict and reload 256 or 1,024 chunks twice, with one quarter pinned by attentions and another quarter by edits  | Elapsed time, heap growth, retained heap                                      |

The cache workload includes enough edits to exercise periodic cache compaction.
The eviction workload includes refused evictions and reloads chunks in reverse
order to exercise insertion between existing pieces. Both workloads check their
results and compare document checksums across versions.

The asynchronous workloads report phase timings and counters in an additional
table. The main timing still covers the complete operation. Notification counts
and timings are excluded from checksums so versions can differ in scheduling
while producing the same document. The additional table shows medians without
confidence intervals. Use its timings as measurements from this controlled
scenario. The fetch delay does not model a particular storage service.

To add another measurement, define `metrics(fixture)` on a workload and return a
record of finite numbers. Include the unit in each timing's name, such as
`first readable (ms)`. The worker collects metrics after timing and heap sampling,
and stores one value per timed sample in the JSON report.
