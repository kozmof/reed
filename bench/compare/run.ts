/**
 * Cross-version performance comparison.
 *
 * Runs every workload in workloads.ts against two built Reed bundles, one
 * fresh process per (version, workload, size, round), alternating the version
 * order each round so machine drift lands evenly on both sides. Writes raw
 * samples as JSON and a Markdown summary to the output directory.
 *
 * Usage:
 *   node bench/compare/run.ts --base <dir|dist/reed.js> --head <dir|dist/reed.js>
 *     [--rounds 5] [--samples 10] [--warmup 2] [--budget 20000]
 *     [--only name,name] [--sizes small|all] [--cpu 2] [--out report]
 *
 * --cpu pins every worker to one core with taskset when it is available.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { workloads, type Workload } from "./workloads.ts";
import type { WorkerResult } from "./worker.ts";

const { values: args } = parseArgs({
  options: {
    base: { type: "string" },
    head: { type: "string" },
    rounds: { type: "string", default: "5" },
    samples: { type: "string", default: "10" },
    warmup: { type: "string", default: "2" },
    budget: { type: "string", default: "20000" },
    only: { type: "string" },
    sizes: { type: "string", default: "all" },
    cpu: { type: "string" },
    out: { type: "string", default: "report" },
    "worker-timeout": { type: "string", default: "900000" },
  },
});

if (!args.base || !args.head) {
  console.error("usage: run.ts --base <dir|dist> --head <dir|dist> [options]");
  process.exit(2);
}

function resolveDist(p: string): string {
  const candidate = p.endsWith(".js") ? p : join(p, "dist", "reed.js");
  const abs = resolve(candidate);
  if (!existsSync(abs)) throw new Error(`no build at ${abs}; run the build first`);
  return abs;
}

const versions = { base: resolveDist(args.base), head: resolveDist(args.head) } as const;
type Version = keyof typeof versions;

/** Changes inside ±NOISE are reported as unchanged even if the CI excludes 1. */
const NOISE = 0.05;

const rounds = Number(args.rounds);
const workerScript = resolve(import.meta.dirname, "worker.ts");
const only = args.only?.split(",").filter(Boolean);
const selected = workloads.filter((w) => !only || only.includes(w.name));
if (only) {
  const unknown = only.filter((n) => !workloads.some((w) => w.name === n));
  if (unknown.length) throw new Error(`unknown workloads: ${unknown.join(", ")}`);
}

const hasTaskset = (() => {
  if (args.cpu === undefined) return false;
  const ok = spawnSync("taskset", ["-V"]).status === 0;
  if (!ok) console.warn("taskset not found; running unpinned");
  return ok;
})();

// -----------------------------------------------------------------------------
// Statistics
// -----------------------------------------------------------------------------

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

const sortNum = (xs: readonly number[]) => [...xs].sort((a, b) => a - b);
const median = (xs: readonly number[]) => quantile(sortNum(xs), 0.5);

/** Seeded RNG so bootstrap intervals are reproducible for the same samples. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Percentile bootstrap CI for median(head) / median(base). */
function bootstrapRatio(base: readonly number[], head: readonly number[], iters = 2_000) {
  const r = rng(12345);
  const resampleMedian = (xs: readonly number[]) => {
    const out: number[] = [];
    for (let i = 0; i < xs.length; i++) out.push(xs[Math.floor(r() * xs.length)]!);
    return median(out);
  };
  const ratios: number[] = [];
  for (let i = 0; i < iters; i++) ratios.push(resampleMedian(head) / resampleMedian(base));
  const sorted = sortNum(ratios);
  return { lo: quantile(sorted, 0.025), hi: quantile(sorted, 0.975) };
}

// -----------------------------------------------------------------------------
// Execution
// -----------------------------------------------------------------------------

function runWorker(version: Version, w: Workload, size: number): WorkerResult {
  const nodeArgs = [
    "--expose-gc",
    "--no-warnings",
    workerScript,
    versions[version],
    w.name,
    String(size),
    args.samples!,
    args.warmup!,
    args.budget!,
  ];
  const [cmd, cmdArgs] = hasTaskset
    ? ["taskset", ["-c", args.cpu!, process.execPath, ...nodeArgs]]
    : [process.execPath, nodeArgs];
  const out = execFileSync(cmd, cmdArgs as string[], {
    encoding: "utf8",
    timeout: Number(args["worker-timeout"]),
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const line = out.trim().split("\n").at(-1)!;
  return JSON.parse(line) as WorkerResult;
}

interface Cell {
  workload: string;
  covers: string;
  unit: string;
  size: number;
  outputMayDiffer?: string;
  raw: Record<Version, WorkerResult[]>;
  error?: string;
}

const cells: Cell[] = [];
const startedAt = new Date();

for (const w of selected) {
  const sizes = args.sizes === "small" ? w.sizes.slice(0, 1) : w.sizes;
  for (const size of sizes) {
    const cell: Cell = {
      workload: w.name,
      covers: w.covers,
      unit: w.unit,
      size,
      raw: { base: [], head: [] },
      ...(w.outputMayDiffer ? { outputMayDiffer: w.outputMayDiffer } : {}),
    };
    cells.push(cell);
    process.stderr.write(`${w.name} @ ${size}: `);
    try {
      for (let r = 0; r < rounds; r++) {
        const order: Version[] = r % 2 === 0 ? ["base", "head"] : ["head", "base"];
        for (const v of order) {
          cell.raw[v].push(runWorker(v, w, size));
          process.stderr.write(v === "base" ? "b" : "h");
        }
      }
      process.stderr.write(` ${summarize(cell).line}\n`);
    } catch (err) {
      cell.error = err instanceof Error ? err.message.split("\n")[0] : String(err);
      process.stderr.write(` ERROR ${cell.error}\n`);
    }
  }
}

// -----------------------------------------------------------------------------
// Reporting
// -----------------------------------------------------------------------------

interface Summary {
  baseMs: number;
  headMs: number;
  baseP95: number;
  headP95: number;
  ratio: number;
  ci: { lo: number; hi: number };
  verdict: string;
  baseAlloc: number;
  headAlloc: number;
  baseRetained: number;
  headRetained: number;
  samples: Record<Version, number>;
  output: string;
  line: string;
}

function summarize(cell: Cell): Summary {
  const all = (v: Version, k: "times" | "allocatedBytes" | "retainedBytes") =>
    cell.raw[v].flatMap((r) => r[k]);
  const bt = all("base", "times");
  const ht = all("head", "times");
  const baseMs = median(bt);
  const headMs = median(ht);
  const ratio = headMs / baseMs;
  const ci = bootstrapRatio(bt, ht);
  const verdict = ci.hi < 1 - NOISE ? "faster" : ci.lo > 1 + NOISE ? "SLOWER" : "~ same";

  const baseSums = new Set(cell.raw.base.map((r) => r.checksum));
  const headSums = new Set(cell.raw.head.map((r) => r.checksum));
  const same = baseSums.size === 1 && headSums.size === 1 && [...baseSums][0] === [...headSums][0];
  const output = same ? "match" : cell.outputMayDiffer ? "differs (expected)" : "MISMATCH";

  const s: Summary = {
    baseMs,
    headMs,
    baseP95: quantile(sortNum(bt), 0.95),
    headP95: quantile(sortNum(ht), 0.95),
    ratio,
    ci,
    verdict,
    baseAlloc: median(all("base", "allocatedBytes")),
    headAlloc: median(all("head", "allocatedBytes")),
    baseRetained: median(all("base", "retainedBytes")),
    headRetained: median(all("head", "retainedBytes")),
    samples: { base: bt.length, head: ht.length },
    output,
    line: "",
  };
  s.line = `${fmtMs(baseMs)} → ${fmtMs(headMs)}  ${fmtRatio(ratio)} [${ci.lo.toFixed(2)}–${ci.hi.toFixed(2)}] ${verdict} (${output})`;
  return s;
}

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(2)} s`;
  if (ms >= 10) return `${ms.toFixed(1)} ms`;
  return `${ms.toFixed(2)} ms`;
}

function fmtRatio(r: number): string {
  if (!Number.isFinite(r)) return "—";
  return r < 1 ? `${(1 / r).toFixed(2)}× faster` : `${r.toFixed(2)}× slower`;
}

function fmtBytes(b: number): string {
  if (!Number.isFinite(b)) return "—";
  const abs = Math.abs(b);
  if (abs >= 1 << 20) return `${(b / (1 << 20)).toFixed(1)} MiB`;
  if (abs >= 1 << 10) return `${(b / (1 << 10)).toFixed(0)} KiB`;
  return `${b} B`;
}

const git = (cwd: string, ...a: string[]) => {
  const r = spawnSync("git", ["-c", "safe.directory=*", ...a], { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "unknown";
};

const meta = {
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  base: versions.base,
  head: versions.head,
  repoHead: git(process.cwd(), "rev-parse", "--short", "HEAD"),
  rounds,
  samplesPerRound: Number(args.samples),
  warmup: Number(args.warmup),
  budgetMs: Number(args.budget),
  pinnedCpu: hasTaskset ? args.cpu : null,
};

const rows = cells.map((c) => ({ cell: c, s: c.error ? null : summarize(c) }));

const md: string[] = [];
md.push(`# Performance comparison: base vs head`, "");
md.push(`- Base: \`${meta.base}\``);
md.push(`- Head: \`${meta.head}\``);
md.push(`- Node ${meta.node}, ${meta.platform}, CPU pin: ${meta.pinnedCpu ?? "none"}`);
md.push(
  `- ${rounds} alternating rounds × up to ${meta.samplesPerRound} samples per version (warm-up ${meta.warmup}, budget ${meta.budgetMs} ms per process)`,
);
md.push(`- Started ${meta.startedAt}, finished ${meta.finishedAt}`, "");
md.push(
  `Ratio is median(head) / median(base) with a 95% bootstrap CI. A change counts only when the CI excludes 1 ± ${NOISE * 100}%. "Alloc" is heap growth during the timed run; "retained" is what survives a GC afterwards.`,
  "",
);
md.push(
  "| Workload | Size | Base | Head | Change | 95% CI | Verdict | Alloc base → head | Retained base → head | Output |",
);
md.push("|---|---:|---:|---:|---:|---|---|---|---|---|");
for (const { cell, s } of rows) {
  if (!s) {
    md.push(
      `| ${cell.workload} | ${cell.size.toLocaleString("en-US")} | — | — | — | — | ERROR: ${cell.error} | | | |`,
    );
    continue;
  }
  md.push(
    `| ${cell.workload} | ${cell.size.toLocaleString("en-US")} | ${fmtMs(s.baseMs)} | ${fmtMs(s.headMs)} | ${fmtRatio(s.ratio)} | ${s.ci.lo.toFixed(2)}–${s.ci.hi.toFixed(2)} | ${s.verdict} | ${fmtBytes(s.baseAlloc)} → ${fmtBytes(s.headAlloc)} | ${fmtBytes(s.baseRetained)} → ${fmtBytes(s.headRetained)} | ${s.output} |`,
  );
}
md.push("", "## Workloads", "");
for (const w of selected) {
  md.push(
    `- **${w.name}** — ${w.unit}. Covers: ${w.covers}.${w.outputMayDiffer ? ` Output differs by design: ${w.outputMayDiffer}.` : ""}`,
  );
}

const outDir = resolve(args.out!);
mkdirSync(outDir, { recursive: true });
const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
const jsonPath = join(outDir, `perf-compare-${stamp}.json`);
const mdPath = join(outDir, `perf-compare-${stamp}.md`);
writeFileSync(
  jsonPath,
  JSON.stringify({ meta, cells: rows.map(({ cell, s }) => ({ ...cell, summary: s })) }, null, 2),
);
writeFileSync(mdPath, md.join("\n") + "\n");
console.log(md.join("\n"));
console.error(`\nwrote ${mdPath}\nwrote ${jsonPath}`);

const mismatches = rows.filter((r) => r.s?.output === "MISMATCH" || r.cell.error);
process.exit(mismatches.length ? 1 : 0);
