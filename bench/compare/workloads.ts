/**
 * Workloads for the cross-version performance comparison.
 *
 * Every workload touches Reed only through the public module object passed in
 * as `R`, so the same code drives any built `dist/reed.js`. A workload's
 * `prepare` builds a fresh fixture before timing starts. `run` performs the
 * timed work and returns a checksum to detect output differences between versions.
 * Return a function when computing the checksum requires substantial work, such
 * as reading the document. The worker evaluates that function after timing stops.
 */

import type * as Reed from "../../src/index.ts";
import { generateLargeContent, makeDeterministicRng } from "../../test-utils/large-content.ts";

export type ReedModule = typeof Reed;

/** A checksum, or a function that computes it after timing stops. */
export type Checksum = string | (() => string);

export interface Workload<F = any> {
  /** Stable identifier used on the command line and in reports. */
  readonly name: string;
  /** Commits or areas this workload is meant to cover. */
  readonly covers: string;
  /** Size parameter values (usually line counts) to sweep. */
  readonly sizes: readonly number[];
  /** Meaning of the size parameter in reports. */
  readonly unit: string;
  /** Explain an expected output difference between versions. */
  readonly outputMayDiffer?: string;
  prepare(R: ReedModule, size: number): F;
  run(R: ReedModule, fixture: F, size: number): Checksum | Promise<Checksum>;
  cleanup?(fixture: F): void;
  /** Additional counters or timings, collected outside the timed interval. */
  metrics?(fixture: F): Record<string, number>;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const contentCache = new Map<string, string>();

function prose(lines: number, seed = 1): string {
  const key = `prose:${lines}:${seed}`;
  let content = contentCache.get(key);
  if (content === undefined) {
    content = generateLargeContent({ lineCount: lines, pattern: "prose", seed });
    contentCache.set(key, content);
  }
  return content;
}

/** FNV-1a over a string, enough to detect divergent output across versions. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

function docChecksum(R: ReedModule, state: Reed.DocumentState): string {
  return `${hash(R.scan.getValue(state.pieceTable))}:${R.query.getLength(state.pieceTable)}`;
}

function store(R: ReedModule, content: string, reconcileMode: "idle" | "sync" | "none" = "none") {
  return R.store.createDocumentStoreWithEvents({ content, reconcileMode });
}

type Store = ReturnType<typeof store>;

const off = (n: number) => n as Reed.ByteOffset;

/**
 * Apply `count` single-character inserts at deterministic random positions.
 * Timestamps are fixed and far apart so history never coalesces entries and
 * both versions record the same undo stack.
 */
function fragment(R: ReedModule, s: Store, count: number, seed: number): void {
  const rng = makeDeterministicRng(seed);
  for (let i = 0; i < count; i++) {
    const len = R.query.getLength(s.getSnapshot().pieceTable);
    const at = off(Math.floor(rng() * len));
    s.dispatch(R.store.DocumentActions.insert(at, "x", undefined, (i + 1) * 1e7));
  }
}

const disposeStore = (s: Store) => s.dispose();

// -----------------------------------------------------------------------------
// Workloads
// -----------------------------------------------------------------------------

export const workloads: readonly Workload[] = [
  {
    name: "load",
    covers: "c39c51e text metrics, 4c34b8e",
    sizes: [10_000, 100_000],
    unit: "lines",
    prepare: (_R, n) => prose(n),
    run(R, content) {
      const s = R.store.createDocumentStore({ content });
      return String(R.query.getLineCount(s.getSnapshot()));
    },
  },
  {
    name: "insert-random",
    covers: "4c34b8e, 826e819 localized edits",
    sizes: [10_000, 100_000],
    unit: "lines (1,000 inserts)",
    prepare: (R, n) => store(R, prose(n)),
    run(R, s) {
      fragment(R, s, 1_000, 7);
      return () => docChecksum(R, s.getSnapshot());
    },
    cleanup: disposeStore,
  },
  {
    name: "delete-fragmented",
    covers: "a53d768 rb deletion, 40d9b60 range deletion",
    sizes: [10_000, 100_000],
    unit: "lines (2,000 deletes over 4,000-insert tree)",
    prepare(R, n) {
      const s = store(R, prose(n));
      fragment(R, s, 4_000, 11);
      return s;
    },
    run(R, s) {
      const rng = makeDeterministicRng(13);
      for (let i = 0; i < 2_000; i++) {
        const len = R.query.getLength(s.getSnapshot().pieceTable);
        const start = Math.floor(rng() * (len - 2));
        s.dispatch(R.store.DocumentActions.delete(off(start), off(start + 1), undefined, 0));
      }
      return () => docChecksum(R, s.getSnapshot());
    },
    cleanup: disposeStore,
  },
  {
    name: "delete-range-large",
    covers: "40d9b60 range deletion",
    sizes: [10_000, 100_000],
    unit: "lines (100 deletes of ~0.5% each)",
    prepare(R, n) {
      const s = store(R, prose(n));
      fragment(R, s, 2_000, 17);
      return s;
    },
    run(R, s) {
      const rng = makeDeterministicRng(19);
      for (let i = 0; i < 100; i++) {
        const len = R.query.getLength(s.getSnapshot().pieceTable);
        const span = Math.max(1, Math.floor(len * 0.005));
        const start = Math.floor(rng() * (len - span));
        s.dispatch(R.store.DocumentActions.delete(off(start), off(start + span), undefined, 0));
      }
      return () => docChecksum(R, s.getSnapshot());
    },
    cleanup: disposeStore,
  },
  {
    name: "batch-insert",
    covers: "40d9b60 snapshot edits",
    sizes: [10_000, 100_000],
    unit: "lines (1 batch of 1,000 inserts)",
    prepare: (R, n) => store(R, prose(n)),
    run(R, s) {
      const actions = [];
      for (let i = 0; i < 1_000; i++) {
        actions.push(R.store.DocumentActions.insert(off(i * 37), "y", undefined, 0));
      }
      s.batch(actions);
      return () => docChecksum(R, s.getSnapshot());
    },
    cleanup: disposeStore,
  },
  {
    name: "getValue-fragmented",
    covers: "e9cd405 scanning",
    sizes: [10_000, 100_000],
    unit: "lines (after 2,000 edits)",
    prepare(R, n) {
      const s = store(R, prose(n));
      fragment(R, s, 2_000, 23);
      return s;
    },
    run(R, s) {
      const value = R.scan.getValue(s.getSnapshot().pieceTable);
      return () => hash(value);
    },
    cleanup: disposeStore,
  },
  {
    name: "setValue-small-change",
    covers: "e9cd405 replacement, 7828864",
    sizes: [10_000, 100_000],
    unit: "lines",
    prepare(R, n) {
      const content = prose(n);
      const mid = content.length >> 1;
      const next = content.slice(0, mid) + "CHANGED" + content.slice(mid + 40);
      return { state: R.store.createDocumentStore({ content }).getSnapshot(), next };
    },
    run(R, f) {
      const next = R.diff.setValue(f.state, f.next);
      return () => docChecksum(R, next);
    },
  },
  {
    name: "setValue-unchanged",
    covers: "0c71fa5 unchanged-value",
    sizes: [10_000, 100_000],
    unit: "lines",
    prepare(R, n) {
      const content = prose(n);
      // Copy so identity shortcuts cannot skip the comparison.
      return {
        state: R.store.createDocumentStore({ content }).getSnapshot(),
        next: (" " + content).slice(1),
      };
    },
    run(R, f) {
      const next = R.diff.setValue(f.state, f.next);
      return () => docChecksum(R, next);
    },
  },
  {
    name: "setValueWithDiff",
    covers: "7828864 Myers trace, 6a344c5 diff memory",
    sizes: [500, 2_000],
    unit: "lines (scattered edits)",
    prepare(R, n) {
      const content = prose(n);
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i += 50) lines[i] = `edited ${i}`;
      return {
        state: R.store.createDocumentStore({ content }).getSnapshot(),
        next: lines.join("\n"),
      };
    },
    run(R, f) {
      const next = R.diff.setValueWithDiff(f.state, f.next);
      return () => docChecksum(R, next);
    },
  },
  {
    name: "reconcile",
    covers: "7828864 reconciliation, a7f74ac",
    sizes: [10_000, 100_000],
    unit: "lines (after 500 lazy inserts)",
    prepare(R, n) {
      const s = store(R, prose(n));
      const rng = makeDeterministicRng(29);
      for (let i = 0; i < 500; i++) {
        const len = R.query.getLength(s.getSnapshot().pieceTable);
        s.dispatch(
          R.store.DocumentActions.insert(off(Math.floor(rng() * len)), "a\nb", undefined, 0),
        );
      }
      return s;
    },
    run(R, s) {
      return String(R.query.getLineCount(s.reconcileNow()));
    },
    cleanup: disposeStore,
  },
  {
    name: "idle-edits-to-reconciled",
    covers: "4348e97 bounded idle maintenance, c39c51e",
    sizes: [10_000, 100_000],
    unit: "lines (500 edits then whenReconciled)",
    prepare: (R, n) => store(R, prose(n), "idle"),
    async run(R, s) {
      const rng = makeDeterministicRng(31);
      for (let i = 0; i < 500; i++) {
        const len = R.query.getLength(s.getSnapshot().pieceTable);
        s.dispatch(
          R.store.DocumentActions.insert(off(Math.floor(rng() * len)), "q\n", undefined, 0),
        );
      }
      const done = await s.whenReconciled();
      return String(R.query.getLineCount(done));
    },
    cleanup: disposeStore,
  },
  {
    name: "viewport-render",
    covers: "0c71fa5 rendering",
    sizes: [10_000, 100_000],
    unit: "lines (1,000 viewports of 60 lines)",
    prepare(R, n) {
      const s = store(R, prose(n));
      fragment(R, s, 500, 37);
      return s.reconcileNow();
    },
    run(R, state, n) {
      let acc = 0;
      for (let i = 0; i < 1_000; i++) {
        const res = R.rendering.getVisibleLines(state, {
          startLine: (i * 97) % (n - 60),
          visibleLineCount: 60,
          overscan: 5,
        });
        acc += res.lines.length;
      }
      return String(acc);
    },
  },
  {
    name: "long-line-viewport",
    covers: "826e819 long-line rendering bounds",
    sizes: [100_000, 1_000_000],
    unit: "chars on a single line (200 viewport reads)",
    outputMayDiffer:
      "base has no startColumn/maxColumns and returns the whole line; head returns a 200-column window",
    prepare(R, n) {
      const content = "abcdefghij".repeat(n / 10);
      return R.store.createDocumentStore({ content }).getSnapshot();
    },
    run(R, state, n) {
      let acc = 0;
      for (let i = 0; i < 200; i++) {
        const res = R.rendering.getVisibleLines(state, {
          startLine: 0,
          visibleLineCount: 1,
          startColumn: (i * 4_999) % (n - 200),
          maxColumns: 200,
        });
        acc += res.lines[0]?.content.length ?? 0;
      }
      return String(acc);
    },
  },
  {
    name: "long-line-position",
    covers: "826e819 long-line rendering bounds",
    sizes: [100_000, 1_000_000],
    unit: "chars on a single line (1,000 column↔position conversions)",
    prepare(R, n) {
      const content = "abcdefghij".repeat(n / 10);
      return R.store.createDocumentStore({ content }).getSnapshot();
    },
    run(R, state, n) {
      let acc = 0;
      for (let i = 0; i < 1_000; i++) {
        acc += R.rendering.lineColumnToPosition(state, 0, (i * 7_919) % n) ?? 0;
        acc += R.rendering.positionToLineColumn(state, off((i * 6_007) % n))?.column ?? 0;
      }
      return String(acc);
    },
  },
  {
    name: "undo-redo",
    covers: "0c71fa5 history, a976ee1",
    sizes: [10_000, 100_000],
    unit: "lines (300 undos + 300 redos)",
    prepare(R, n) {
      const s = store(R, prose(n));
      fragment(R, s, 300, 41);
      return s;
    },
    run(R, s) {
      for (let i = 0; i < 300; i++) s.dispatch(R.store.DocumentActions.undo());
      for (let i = 0; i < 300; i++) s.dispatch(R.store.DocumentActions.redo());
      return () => docChecksum(R, s.getSnapshot());
    },
    cleanup: disposeStore,
  },
  {
    name: "attention-edit",
    covers: "4348e97 shared annotation indexes, 6a344c5, 40d9b60",
    sizes: [100, 1_000, 5_000],
    unit: "annotations (500 edits on a 10k-line doc)",
    prepare(R, a) {
      const s = store(R, prose(10_000));
      const len = R.query.getLength(s.getSnapshot().pieceTable);
      const rng = makeDeterministicRng(43);
      for (let i = 0; i < a; i++) {
        const start = Math.floor(rng() * (len - 50));
        s.dispatch(R.store.DocumentActions.createAttention(off(start), off(start + 20)));
      }
      return s;
    },
    run(R, s) {
      const rng = makeDeterministicRng(47);
      for (let i = 0; i < 500; i++) {
        const len = R.query.getLength(s.getSnapshot().pieceTable);
        const p = Math.floor(rng() * (len - 10));
        if (i % 2 === 0) s.dispatch(R.store.DocumentActions.insert(off(p), "zz", undefined, 0));
        else s.dispatch(R.store.DocumentActions.delete(off(p), off(p + 3), undefined, 0));
      }
      return () => docChecksum(R, s.getSnapshot());
    },
    cleanup: disposeStore,
  },
  {
    name: "attention-query",
    covers: "40d9b60 annotation queries, 7828864 identity indexing",
    sizes: [100, 1_000, 5_000],
    unit: "annotations (2,000 overlap queries on a fragmented 10k-line doc)",
    prepare(R, a) {
      const s = store(R, prose(10_000));
      fragment(R, s, 1_000, 53);
      const len = R.query.getLength(s.getSnapshot().pieceTable);
      const rng = makeDeterministicRng(59);
      for (let i = 0; i < a; i++) {
        const start = Math.floor(rng() * (len - 50));
        s.dispatch(R.store.DocumentActions.createAttention(off(start), off(start + 20)));
      }
      return s.getSnapshot();
    },
    run(R, state) {
      const len = R.query.getLength(state.pieceTable);
      const rng = makeDeterministicRng(61);
      let acc = 0;
      for (let i = 0; i < 2_000; i++) {
        const start = Math.floor(rng() * (len - 500));
        acc += R.attention.findAttentionsOverlapping(
          state.attention,
          state.pieceTable.root,
          start,
          start + 500,
        ).length;
      }
      return String(acc);
    },
  },
  {
    name: "apply-remote",
    covers: "6a344c5 remote range transforms",
    sizes: [10_000, 100_000],
    unit: "lines (300 remote batches × 4 changes, 200 annotations)",
    prepare(R, n) {
      const s = store(R, prose(n));
      const len = R.query.getLength(s.getSnapshot().pieceTable);
      const rng = makeDeterministicRng(67);
      for (let i = 0; i < 200; i++) {
        const start = Math.floor(rng() * (len - 50));
        s.dispatch(R.store.DocumentActions.createAttention(off(start), off(start + 20)));
      }
      return s;
    },
    run(R, s) {
      const rng = makeDeterministicRng(71);
      for (let i = 0; i < 300; i++) {
        const len = R.query.getLength(s.getSnapshot().pieceTable);
        const changes: Reed.RemoteChange[] = [];
        for (let k = 0; k < 4; k++) {
          const p = Math.floor(rng() * (len - 100));
          changes.push(
            k % 2 === 0
              ? { type: "insert", start: off(p), text: "rr" }
              : { type: "delete", start: off(p), length: 2 as Reed.ByteLength },
          );
        }
        s.dispatch(R.store.DocumentActions.applyRemote(changes));
      }
      return () => docChecksum(R, s.getSnapshot());
    },
    cleanup: disposeStore,
  },
  {
    name: "chunk-load-evict",
    covers: "a7f74ac compaction lookups, 6eb361c",
    sizes: [250, 1_000],
    unit: "chunks of 4 KiB (load all, evict half)",
    prepare(R, n) {
      const chunkSize = 4_096;
      const s = R.store.createDocumentStore({
        chunkSize,
        totalFileSize: n * chunkSize,
        reconcileMode: "none",
      });
      const line = "chunk line of text\n";
      const chunk = new TextEncoder().encode(
        line.repeat(Math.ceil(chunkSize / line.length)).slice(0, chunkSize),
      );
      return { s, chunk };
    },
    run(R, { s, chunk }, n) {
      for (let i = 0; i < n; i++) s.dispatch(R.store.DocumentActions.loadChunk(i, chunk));
      for (let i = 0; i < n; i += 2) s.dispatch(R.store.DocumentActions.evictChunk(i));
      const st = s.getSnapshot();
      // In 2.0.0, getLineCount counted resident lines before getResidentLineCount was added.
      const resident = R.query.getResidentLineCount ?? R.query.getLineCount;
      return `${st.pieceTable.chunkMap.size}:${resident(st)}`;
    },
    cleanup: (f) => f.s.dispose(),
  },
  {
    name: "chunk-slow-fetch",
    covers: "59520f7 progressive batches and bounded fetch concurrency",
    sizes: [8, 32],
    unit: "chunks of 128 bytes (one fetch delayed by 40 ms)",
    prepare(R, n) {
      const s = R.store.createDocumentStore({ chunkSize: 128, reconcileMode: "none" });
      const chunks = Array.from({ length: n }, (_, i) =>
        new TextEncoder().encode(String.fromCharCode(65 + (i % 26)).repeat(127) + "\n"),
      );
      const metrics = {
        "first readable (ms)": 0,
        "total load (ms)": 0,
        "peak concurrent fetches": 0,
        notifications: 0,
      };
      let active = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const manager = R.createChunkManager(
        s,
        {
          async loadChunk(index) {
            active++;
            metrics["peak concurrent fetches"] = Math.max(
              metrics["peak concurrent fetches"],
              active,
            );
            try {
              if (index === n - 1)
                await new Promise<void>((resolve) => {
                  timer = setTimeout(resolve, 40);
                });
              else await Promise.resolve();
              return chunks[index]!;
            } finally {
              active--;
            }
          },
        },
        { maxLoadedChunks: n },
      );
      return { s, manager, metrics, clearTimer: () => clearTimeout(timer) };
    },
    async run(R, f, n) {
      const start = performance.now();
      let firstReadable = false;
      const unsubscribe = f.s.subscribe(() => {
        f.metrics.notifications++;
        if (!firstReadable && f.s.getSnapshot().pieceTable.chunkMap.has(0)) {
          const text = R.query.getText(f.s.getSnapshot().pieceTable, off(0), off(1));
          if (text !== "A") throw new Error("fast chunk was not readable");
          f.metrics["first readable (ms)"] = performance.now() - start;
          firstReadable = true;
        }
      });
      try {
        await f.manager.ensureLoadedMany(Array.from({ length: n }, (_, i) => i));
        f.metrics["total load (ms)"] = performance.now() - start;
        if (!firstReadable || f.s.getSnapshot().pieceTable.chunkMap.size !== n)
          throw new Error("batch did not load every chunk");
        return () => docChecksum(R, f.s.getSnapshot());
      } finally {
        unsubscribe();
      }
    },
    metrics: (f) => f.metrics,
    cleanup(f) {
      f.clearTimer();
      f.manager.dispose();
      f.s.dispose();
    },
  },
  {
    name: "viewport-prefetch",
    covers: "59520f7 batched viewport prefetch notifications",
    sizes: [4, 16],
    unit: "prefetched chunks per viewport side (one visible chunk, 128-byte chunks)",
    prepare(R, n) {
      const total = 2 * n + 1;
      const s = R.store.createDocumentStore({ chunkSize: 128, reconcileMode: "none" });
      const chunks = Array.from({ length: total }, (_, i) =>
        new TextEncoder().encode(String.fromCharCode(65 + (i % 26)).repeat(127) + "\n"),
      );
      const loader = R.createStreamingDocumentLoader(
        s,
        { loadChunk: async (index) => chunks[index]! },
        chunks.map((data, chunkIndex) => ({ chunkIndex, byteLength: data.length, lineCount: 1 })),
        { prefetchWindowSize: n, chunkManagerConfig: { maxLoadedChunks: total } },
      );
      return {
        s,
        loader,
        metrics: { notifications: 0, "viewport ready (ms)": 0, "total load (ms)": 0 },
      };
    },
    async run(R, f, n) {
      const start = performance.now();
      let loaded!: () => void;
      const done = new Promise<void>((resolve) => {
        loaded = resolve;
      });
      const unsubscribe = f.s.subscribe(() => {
        f.metrics.notifications++;
        if (f.s.getSnapshot().pieceTable.chunkMap.size === 2 * n + 1) loaded();
      });
      try {
        await f.loader.setViewport(n, n);
        f.metrics["viewport ready (ms)"] = performance.now() - start;
        await done;
        f.metrics["total load (ms)"] = performance.now() - start;
        return () => docChecksum(R, f.s.getSnapshot());
      } finally {
        unsubscribe();
      }
    },
    metrics: (f) => f.metrics,
    cleanup(f) {
      f.loader.dispose();
      f.s.dispose();
    },
  },
  {
    name: "chunk-column-cache-edits",
    covers: "59520f7 lazy line offset cache migration and compaction",
    sizes: [64, 512],
    unit: "cached chunk-backed Unicode lines (128 edits with distant column queries)",
    prepare(R, n) {
      const line = "漢😀x".repeat(2048) + "\n";
      const bytes = new TextEncoder().encode(line.repeat(n));
      const s = R.store.createDocumentStore({ chunkSize: bytes.length, reconcileMode: "none" });
      s.dispatch(R.store.DocumentActions.loadChunk(0, bytes));
      for (let i = 0; i < n; i++) {
        if (R.rendering.lineColumnToPosition(s.getSnapshot(), i, 6000) === null)
          throw new Error("cache warm-up could not locate line");
      }
      return s;
    },
    run(R, s, n) {
      let acc = 0;
      for (let i = 0; i < 128; i++) {
        s.dispatch(R.store.DocumentActions.insert(off(0), "x", undefined, i * 1e7));
        const state = s.getSnapshot();
        const line = n - 1 - (i % 8);
        const position = R.rendering.lineColumnToPosition(state, line, 6000);
        if (position === null) throw new Error("edited line could not be located");
        const expected = line * (2048 * 8 + 1) + i + 1 + 12000;
        if (position !== expected) throw new Error("cached column offset is incorrect");
        acc += position;
        const converted = R.rendering.positionToLineColumn(state, position);
        if (converted?.line !== line || converted.column !== 6000)
          throw new Error("cached column round trip is incorrect");
      }
      return () => acc + ":" + docChecksum(R, s.getSnapshot());
    },
    cleanup: (s) => s.dispose(),
  },
  {
    name: "chunk-fragmented-evict-reload",
    covers: "59520f7 subtree chunk summaries and shared attention endpoint index",
    sizes: [256, 1024],
    unit: "64-byte chunks (2 eviction/reload cycles with edits and attention pins)",
    prepare(R, n) {
      const chunk = new TextEncoder().encode("1234567\n".repeat(8));
      const s = R.store.createDocumentStore({
        chunkSize: 64,
        totalFileSize: n * 64,
        reconcileMode: "none",
      });
      s.dispatch(
        R.store.DocumentActions.loadChunks(
          Array.from({ length: n }, (_, chunkIndex) => ({ chunkIndex, data: chunk })),
        ),
      );
      // One quarter of chunks are pinned by attentions, another quarter by edits.
      for (let i = 0; i < n; i += 4)
        for (let j = 0; j < 4; j++)
          s.dispatch(
            R.store.DocumentActions.createAttention(
              off(i * 64 + j * 2 + 1),
              off(i * 64 + j * 2 + 2),
            ),
          );
      // Descending offsets keep every insertion inside its intended chunk.
      for (let i = n - 3; i >= 0; i -= 4)
        for (let j = 4; j >= 1; j--)
          s.dispatch(R.store.DocumentActions.insert(off(i * 64 + j * 8), "x", undefined, 0));
      return { s, chunk };
    },
    run(R, { s, chunk }, n) {
      for (let cycle = 0; cycle < 2; cycle++) {
        for (let i = 0; i < n; i++) s.dispatch(R.store.DocumentActions.evictChunk(i));
        if (s.getSnapshot().pieceTable.chunkMap.size !== n / 2)
          throw new Error("eviction did not preserve exactly the pinned chunks");
        // Reverse reload order exercises insertion into the middle of the tree.
        for (let i = n - 1; i >= 0; i--)
          if (i % 4 >= 2) s.dispatch(R.store.DocumentActions.loadChunk(i, chunk));
        if (s.getSnapshot().pieceTable.chunkMap.size !== n)
          throw new Error("reload did not restore all chunks");
      }
      return () => {
        const state = s.getSnapshot();
        for (const id of state.attention.attentions.keys())
          if (R.attention.resolveAttention(state.pieceTable.root, state.attention, id) === null)
            throw new Error("eviction left a dangling attention");
        return docChecksum(R, state) + ":" + state.attention.attentions.size;
      };
    },
    cleanup: (f) => f.s.dispose(),
  },
  {
    name: "checkpoint-roundtrip",
    covers: "1c33690 checkpoint, 5f56306",
    sizes: [10_000, 100_000],
    unit: "lines (encode + decode)",
    prepare(R, n) {
      const s = store(R, prose(n));
      fragment(R, s, 200, 73);
      return s.reconcileNow();
    },
    run(R, state) {
      const json = R.checkpoint.encode(state);
      const restored = R.checkpoint.decode(json);
      return () => docChecksum(R, restored);
    },
  },
];

export function findWorkload(name: string): Workload {
  const w = workloads.find((x) => x.name === name);
  if (!w) throw new Error(`unknown workload: ${name}`);
  return w;
}
