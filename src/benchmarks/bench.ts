#!/usr/bin/env node
/**
 * Reed Document Store — Standalone Benchmark Harness
 *
 * Measures wall-clock time for the most performance-sensitive operations.
 * Each benchmark prints a summary line and flags regressions against a soft
 * threshold (10× slower than the baseline expectation).
 *
 * Usage:
 *   npm run bench
 *
 * The harness uses Node.js `performance.now()` (which wraps HPET / TSC on
 * most systems) rather than vitest so it can run in CI without the test
 * infrastructure overhead.
 *
 * Coverage:
 *   1. Large-document initial load (1 MB prose)
 *   2. Sequential inserts — 10 000 single-char inserts into a 1 MB document
 *   3. Mixed line-ending inserts (CRLF into LF document and vice-versa)
 *   4. Rapid undo sequences — 500 consecutive undos
 *   5. Reconciliation threshold — full reconcile after 1 000 lazy inserts
 *   6. Line-number lookup — O(log n) getLineStartOffset on a 50 000-line doc
 */

import { performance } from "perf_hooks";
import { createDocumentStoreWithEvents } from "../store/features/store.ts";
import { createInitialState } from "../store/core/state.ts";
import { DocumentActions } from "../store/features/actions.ts";
import { byteOffset } from "../types/branded.ts";
import { getLineStartOffset } from "../store/core/line-index.ts";
import { generateLargeContent } from "../test-utils/large-content.ts";

// ---------------------------------------------------------------------------
// Harness utilities
// ---------------------------------------------------------------------------

interface BenchResult {
  label: string;
  medianMs: number;
  threshold: number;
  passed: boolean;
}

const results: BenchResult[] = [];

/**
 * Run `fn` for `iterations` iterations, repeat `runs` times, return the median.
 */
function bench(fn: () => void, iterations = 1, runs = 3): number {
  // Warm-up
  fn();

  const samples: number[] = [];
  for (let r = 0; r < runs; r++) {
    const t0 = performance.now();
    for (let i = 0; i < iterations; i++) fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

function record(label: string, medianMs: number, threshold: number): void {
  const passed = medianMs < threshold;
  const marker = passed ? "✓" : "✗";
  const perOp = medianMs < 1 ? ` (${(medianMs * 1000).toFixed(1)} µs)` : "";
  console.log(
    `  ${marker} ${label}: ${medianMs.toFixed(1)} ms${perOp}  [threshold: ${threshold} ms]`,
  );
  results.push({ label, medianMs, threshold, passed });
}

// ---------------------------------------------------------------------------
// Benchmark suite
// ---------------------------------------------------------------------------

console.log("\nReed Document Store — Benchmark Suite\n");

// ── 1. Large-document initial load ──────────────────────────────────────────

console.log("1. Large-document initial load");
{
  const content = generateLargeContent({ lineCount: 10_000, pattern: "prose", seed: 1 });
  const ms = bench(
    () => {
      createInitialState({ content });
    },
    1,
    5,
  );
  record("createInitialState (10 k lines)", ms, 500);
}

// ── 2. Sequential inserts into a large document ─────────────────────────────

console.log("\n2. Sequential inserts (1 000 single-char inserts)");
{
  const content = generateLargeContent({ lineCount: 5_000, pattern: "prose", seed: 2 });
  const ITERS = 1_000;
  const ms = bench(
    () => {
      const store = createDocumentStoreWithEvents({ content });
      for (let i = 0; i < ITERS; i++) {
        store.dispatch(DocumentActions.insert(byteOffset(i), "x"));
      }
    },
    1,
    3,
  );
  record(`${ITERS} inserts into 5k-line doc`, ms, 2_000);
}

// ── 3. Mixed line-ending inserts ─────────────────────────────────────────────

console.log("\n3. Mixed line-ending inserts");
{
  const lfContent = "line one\nline two\nline three\n".repeat(500);
  const ITERS = 200;
  // Insert CRLF sequences into an LF document (normalizeInsertedLineEndings: false
  // so the insert goes in raw — this exercises the rebuild-on-CRLF path).
  const ms = bench(
    () => {
      const store = createDocumentStoreWithEvents({ content: lfContent });
      let pos = 9; // after "line one\n"
      for (let i = 0; i < ITERS; i++) {
        store.dispatch(DocumentActions.insert(byteOffset(pos), "\r\n"));
        pos += 2;
      }
    },
    1,
    3,
  );
  record(`${ITERS} CRLF inserts into LF doc (rebuild path)`, ms, 1_000);
}

// ── 4. Rapid undo sequences ──────────────────────────────────────────────────

console.log("\n4. Rapid undo sequences");
{
  const EDITS = 500;

  const ms = bench(
    () => {
      const store = createDocumentStoreWithEvents({ content: "Hello World" });
      // Build up EDITS insertions
      for (let i = 0; i < EDITS; i++) {
        store.dispatch(DocumentActions.insert(byteOffset(0), "a"));
      }
      // Undo all of them
      for (let i = 0; i < EDITS; i++) {
        store.dispatch(DocumentActions.undo());
      }
    },
    1,
    3,
  );
  record(`${EDITS} inserts + ${EDITS} undos`, ms, 2_000);
}

// ── 5. Reconciliation after lazy inserts ─────────────────────────────────────

console.log("\n5. Reconciliation after lazy inserts");
{
  const content = generateLargeContent({ lineCount: 2_000, pattern: "prose", seed: 5 });
  const store = createDocumentStoreWithEvents({ content });
  // Perform 200 lazy inserts (all go through lazy path)
  for (let i = 0; i < 200; i++) {
    store.dispatch(DocumentActions.insert(byteOffset(0), "x\n"));
  }
  const ms = bench(
    () => {
      store.reconcileNow();
    },
    1,
    3,
  );
  record("reconcileNow after 200 lazy inserts (2k-line doc)", ms, 500);
}

// ── 6. O(log n) line-number lookup ───────────────────────────────────────────

console.log("\n6. O(log n) line-number lookup");
{
  const content = generateLargeContent({ lineCount: 50_000, pattern: "uniform", seed: 6 });
  const state = createInitialState({ content });
  const LOOKUPS = 10_000;
  const lineCount = state.lineIndex.lineCount;

  const ms = bench(
    () => {
      for (let i = 0; i < LOOKUPS; i++) {
        const lineNum = (i * 7) % lineCount; // deterministic spread
        getLineStartOffset(state.lineIndex.root, lineNum);
      }
    },
    1,
    3,
  );
  record(`${LOOKUPS} getLineStartOffset lookups (50k-line doc)`, ms, 200);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const passed = results.filter((r) => r.passed).length;
const total = results.length;
const failed = results.filter((r) => !r.passed);

console.log(`\n────────────────────────────────────`);
console.log(`Results: ${passed}/${total} passed`);

if (failed.length > 0) {
  console.log("\nFailed benchmarks:");
  for (const f of failed) {
    console.log(`  ✗ ${f.label}: ${f.medianMs.toFixed(1)} ms (threshold: ${f.threshold} ms)`);
  }
  process.exit(1);
} else {
  console.log("All benchmarks within threshold.");
  process.exit(0);
}
