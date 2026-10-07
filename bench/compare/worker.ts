/**
 * Runs one workload at one size against one built Reed bundle and prints a
 * single JSON line to stdout. The orchestrator spawns a fresh process per
 * (version, workload, size, round) so JIT and heap state never leak between
 * versions.
 *
 * Usage:
 *   node --expose-gc bench/compare/worker.ts <dist/reed.js> <workload> <size> <samples> <warmup> <budgetMs>
 *
 * Sampling stops early once timed work exceeds `budgetMs` and at least
 * MIN_SAMPLES were taken, so a pathological baseline cannot stall the run.
 * Warm-up is skipped for samples slower than SELF_WARMING_MS, which are long
 * enough to reach optimized code on their own.
 */

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { getHeapStatistics } from "node:v8";
import { findWorkload, type Checksum, type ReedModule } from "./workloads.ts";

export interface WorkerResult {
  workload: string;
  size: number;
  /** Wall-clock milliseconds per timed sample. */
  times: number[];
  /** Heap bytes still reachable after `run`, relative to the prepared fixture. */
  retainedBytes: number[];
  /** Heap growth during `run` before collection, an allocation proxy. */
  allocatedBytes: number[];
  checksum: string;
}

const MIN_SAMPLES = 3;
const SELF_WARMING_MS = 1_000;

const [distPath, workloadName, sizeArg, samplesArg, warmupArg, budgetArg] = process.argv.slice(2);
if (!distPath || !workloadName || !sizeArg) {
  console.error("usage: worker.ts <dist> <workload> <size> [samples] [warmup]");
  process.exit(2);
}

const heapUsed = () => getHeapStatistics().used_heap_size;

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) {
  console.error("worker.ts must run with --expose-gc");
  process.exit(2);
}

const R = (await import(pathToFileURL(resolve(distPath)).href)) as ReedModule;
const workload = findWorkload(workloadName);
const size = Number(sizeArg);
const samples = Number(samplesArg ?? 10);
let warmup = Number(warmupArg ?? 2);
const budgetMs = Number(budgetArg ?? 20_000);
let spentMs = 0;

const result: WorkerResult = {
  workload: workloadName,
  size,
  times: [],
  retainedBytes: [],
  allocatedBytes: [],
  checksum: "",
};

// Keeps the latest output alive until its retained size is measured.
let sink: Checksum | undefined;

for (let i = 0; i < warmup + samples; i++) {
  if (result.times.length >= MIN_SAMPLES && spentMs > budgetMs) break;
  const fixture = workload.prepare(R, size);
  gc();
  const before = heapUsed();

  const t0 = performance.now();
  sink = await workload.run(R, fixture, size);
  const elapsed = performance.now() - t0;

  const peak = heapUsed();
  gc();
  const after = heapUsed();

  const checksum = typeof sink === "function" ? sink() : sink;
  if (result.checksum && result.checksum !== checksum) {
    throw new Error(`non-deterministic checksum: ${result.checksum} vs ${checksum}`);
  }
  result.checksum = checksum;

  if (i < warmup && elapsed > SELF_WARMING_MS) warmup = i;
  if (i >= warmup) {
    spentMs += elapsed;
    result.times.push(elapsed);
    result.allocatedBytes.push(Math.max(0, peak - before));
    result.retainedBytes.push(after - before);
  }
  workload.cleanup?.(fixture);
}

sink = undefined;
process.stdout.write(JSON.stringify(result) + "\n");
// Idle schedulers or loaders may hold timers open.
process.exit(0);
