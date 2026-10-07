/**
 * Workloads for the cross-version performance comparison.
 *
 * Every workload touches Reed only through the public module object passed in
 * as `R`, so the same code drives any built `dist/reed.js`. A workload's
 * `prepare` builds a fresh fixture outside the timed interval; `run` is the
 * timed work and returns a checksum that must match across versions, which
 * proves both versions did the same work.
 */

import type * as Reed from "../../src/index.ts";
import { generateLargeContent, makeDeterministicRng } from "../../test-utils/large-content.ts";

export type ReedModule = typeof Reed;

export interface Workload<F = any> {
  /** Stable identifier used on the command line and in reports. */
  readonly name: string;
  /** Commits or areas this workload is meant to cover. */
  readonly covers: string;
  /** Size parameter values (usually line counts) to sweep. */
  readonly sizes: readonly number[];
  /** Human-readable meaning of the size parameter. */
  readonly unit: string;
  /** Set when the versions legitimately produce different output; explains why. */
  readonly outputMayDiffer?: string;
  prepare(R: ReedModule, size: number): F;
  run(R: ReedModule, fixture: F, size: number): string | Promise<string>;
  cleanup?(fixture: F): void;
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
      return docChecksum(R, s.getSnapshot());
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
      return docChecksum(R, s.getSnapshot());
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
      return docChecksum(R, s.getSnapshot());
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
      return docChecksum(R, s.getSnapshot());
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
      return hash(R.scan.getValue(s.getSnapshot().pieceTable));
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
    run: (R, f) => docChecksum(R, R.diff.setValue(f.state, f.next)),
  },
  {
    name: "setValue-unchanged",
    covers: "0c71fa5 unchanged-value",
    sizes: [10_000, 100_000],
    unit: "lines",
    prepare(R, n) {
      const content = prose(n);
      // Copy so identity shortcuts cannot skip the comparison.
      return { state: R.store.createDocumentStore({ content }).getSnapshot(), next: (" " + content).slice(1) };
    },
    run: (R, f) => docChecksum(R, R.diff.setValue(f.state, f.next)),
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
    run: (R, f) => docChecksum(R, R.diff.setValueWithDiff(f.state, f.next)),
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
        s.dispatch(R.store.DocumentActions.insert(off(Math.floor(rng() * len)), "a\nb", undefined, 0));
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
        s.dispatch(R.store.DocumentActions.insert(off(Math.floor(rng() * len)), "q\n", undefined, 0));
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
      return docChecksum(R, s.getSnapshot());
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
      return docChecksum(R, s.getSnapshot());
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
      return docChecksum(R, s.getSnapshot());
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
      const chunk = new TextEncoder().encode(line.repeat(Math.ceil(chunkSize / line.length)).slice(0, chunkSize));
      return { s, chunk };
    },
    run(R, { s, chunk }, n) {
      for (let i = 0; i < n; i++) s.dispatch(R.store.DocumentActions.loadChunk(i, chunk));
      for (let i = 0; i < n; i += 2) s.dispatch(R.store.DocumentActions.evictChunk(i));
      const st = s.getSnapshot();
      return `${st.pieceTable.chunkMap.size}:${R.query.getResidentLineCount(st)}`;
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
      return docChecksum(R, R.checkpoint.decode(json));
    },
  },
];

export function findWorkload(name: string): Workload {
  const w = workloads.find((x) => x.name === name);
  if (!w) throw new Error(`unknown workload: ${name}`);
  return w;
}
