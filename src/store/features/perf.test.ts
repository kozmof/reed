/**
 * Large-file performance tests for the Reed document store.
 *
 * Each test measures wall-clock time and asserts it stays within a generous
 * threshold that will catch catastrophic regressions (≥ 10×) without being
 * brittle on slower CI hardware.
 *
 * Run in isolation to get the cleanest numbers:
 *   npm run test:perf
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createDocumentStore } from './store.ts';
import { createInitialState } from '../core/state.ts';
import { DocumentActions } from './actions.ts';
import { byteOffset } from '../../types/branded.ts';
import { query } from '../../api/query.ts';
import { rebuildLineIndex, getLineStartOffset, getCharStartOffset } from '../core/line-index.ts';
import { getText } from '../core/piece-table.ts';
import { generateLargeContent, makeDeterministicRng } from '../../test-utils/large-content.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface BenchOptions {
  /** Number of measured runs; median is returned. */
  runs?: number;
  /** Number of unmeasured warm-up runs. */
  warmupRuns?: number;
}

const STABLE_READ_BENCH: Readonly<BenchOptions> = Object.freeze({ runs: 3, warmupRuns: 1 });

const utf8Encoder = new TextEncoder();

function utf8ByteLength(text: string): number {
  return utf8Encoder.encode(text).length;
}

/** Measure wall-clock ms for `iterations` calls and return median across runs. */
function bench(fn: () => void, iterations = 1, options: BenchOptions = {}): number {
  const runs = Math.max(1, Math.floor(options.runs ?? 1));
  const warmupRuns = Math.max(0, Math.floor(options.warmupRuns ?? 0));

  for (let run = 0; run < warmupRuns; run++) {
    for (let i = 0; i < iterations; i++) fn();
  }

  const samples: number[] = [];
  for (let run = 0; run < runs; run++) {
    const t0 = performance.now();
    for (let i = 0; i < iterations; i++) fn();
    samples.push(performance.now() - t0);
  }

  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

/**
 * Assert elapsed ms is below `thresholdMs` and print a summary line.
 * The label format keeps output scannable: "[PERF] label: 12.3 ms / 1000 iters".
 */
function assertPerf(label: string, elapsedMs: number, thresholdMs: number, iterations = 1): void {
  const perOp = iterations > 1 ? ` (${(elapsedMs / iterations).toFixed(3)} ms/op)` : '';
  console.log(`[PERF] ${label}: ${elapsedMs.toFixed(1)} ms${iterations > 1 ? ` / ${iterations} iters${perOp}` : ''}`);
  expect(elapsedMs, `${label} exceeded ${thresholdMs} ms`).toBeLessThan(thresholdMs);
}

// ---------------------------------------------------------------------------
// Shared fixtures (generated once)
// ---------------------------------------------------------------------------

const LINES_SM = 10_000;
const LINES_MD = 50_000;
const LINES_LG = 900_000;

let content_sm: string;   // ~10k lines ASCII prose
let content_md: string;   // ~50k lines
let content_lg: string;   // ~100k lines

beforeAll(() => {
  content_sm = generateLargeContent({ lineCount: LINES_SM, pattern: 'prose', seed: 1 });
  content_md = generateLargeContent({ lineCount: LINES_MD, pattern: 'prose', seed: 2 });
  content_lg = generateLargeContent({ lineCount: LINES_LG, pattern: 'prose', seed: 3 });
});

// ---------------------------------------------------------------------------
// 1. Initial load — createInitialState
// ---------------------------------------------------------------------------

describe('Load: createInitialState', () => {
  it(`loads ${LINES_SM.toLocaleString()}-line document`, () => {
    let state: ReturnType<typeof createInitialState>;
    const ms = bench(() => { state = createInitialState({ content: content_sm }); });
    assertPerf(`createInitialState (${LINES_SM.toLocaleString()} lines)`, ms, 3_000);
    // Sanity: line count matches
    expect(state!.lineIndex.lineCount).toBe(LINES_SM);
  });

  it(`loads ${LINES_MD.toLocaleString()}-line document`, () => {
    let state: ReturnType<typeof createInitialState>;
    const ms = bench(() => { state = createInitialState({ content: content_md }); });
    assertPerf(`createInitialState (${LINES_MD.toLocaleString()} lines)`, ms, 6_000);
    expect(state!.lineIndex.lineCount).toBe(LINES_MD);
  });

  it(`loads ${LINES_LG.toLocaleString()}-line document`, () => {
    let state: ReturnType<typeof createInitialState>;
    const ms = bench(() => { state = createInitialState({ content: content_lg }); });
    assertPerf(`createInitialState (${LINES_LG.toLocaleString()} lines)`, ms, 10_000);
    expect(state!.lineIndex.lineCount).toBe(LINES_LG);
  });
});

// ---------------------------------------------------------------------------
// 2. Line index queries — O(log n)
// ---------------------------------------------------------------------------

describe('Line index queries (O(log n))', () => {
  const ITERS = 10_000;

  it(`getLineStartOffset × ${ITERS.toLocaleString()} on ${LINES_LG.toLocaleString()}-line index`, () => {
    const state = createInitialState({ content: content_lg });
    const root = state.lineIndex.root;
    const lineCount = state.lineIndex.lineCount;
    const totalBytes = state.pieceTable.totalLength;
    const rng = makeDeterministicRng(99);
    const ms = bench(() => {
      const line = Math.floor(rng() * lineCount);
      getLineStartOffset(root, line);
    }, ITERS, STABLE_READ_BENCH);
    assertPerf(`getLineStartOffset (${LINES_LG.toLocaleString()} lines)`, ms, 1_000, ITERS);

    expect(getLineStartOffset(root, 0)).toBe(0);
    const lastLineStart = getLineStartOffset(root, lineCount - 1);
    expect(lastLineStart).toBeGreaterThanOrEqual(0);
    expect(lastLineStart).toBeLessThan(totalBytes);
  });

  it(`findLineByNumber × ${ITERS.toLocaleString()} on ${LINES_LG.toLocaleString()}-line index`, () => {
    const state = createInitialState({ content: content_lg });
    const rng = makeDeterministicRng(100);
    const lineCount = state.lineIndex.lineCount;
    const ms = bench(() => {
      const line = Math.floor(rng() * lineCount);
      query.findLineByNumber(state, line);
    }, ITERS, STABLE_READ_BENCH);
    assertPerf(`findLineByNumber (${LINES_LG.toLocaleString()} lines)`, ms, 1_000, ITERS);

    expect(query.findLineByNumber(state, Math.floor(lineCount / 2))).not.toBeNull();
  });

  it(`findLineAtPosition × ${ITERS.toLocaleString()} on ${LINES_LG.toLocaleString()}-line index`, () => {
    const state = createInitialState({ content: content_lg });
    const totalBytes = state.pieceTable.totalLength;
    const rng = makeDeterministicRng(101);
    const ms = bench(() => {
      const pos = byteOffset(Math.floor(rng() * totalBytes));
      query.findLineAtPosition(state, pos);
    }, ITERS, STABLE_READ_BENCH);
    assertPerf(`findLineAtPosition (${LINES_LG.toLocaleString()} lines)`, ms, 1_000, ITERS);

    const probe = query.findLineAtPosition(state, byteOffset(Math.floor(totalBytes / 2)));
    expect(probe).not.toBeNull();
    expect(probe!.lineNumber).toBeGreaterThanOrEqual(0);
    expect(probe!.lineNumber).toBeLessThan(state.lineIndex.lineCount);
  });

  it(`getLineCount × ${ITERS.toLocaleString()} is O(1)`, () => {
    const state = createInitialState({ content: content_lg });
    const ms = bench(() => { query.getLineCount(state); }, ITERS, STABLE_READ_BENCH);
    assertPerf(`getLineCount (O(1))`, ms, 100, ITERS);
    expect(query.getLineCount(state)).toBe(LINES_LG);
  });
});

// ---------------------------------------------------------------------------
// 3. Piece table reads — getText
// ---------------------------------------------------------------------------

describe('Piece table reads (getText)', () => {
  it('reads full 100k-line document', () => {
    const state = createInitialState({ content: content_lg });
    const total = state.pieceTable.totalLength;
    let result = '';
    const ms = bench(() => {
      result = getText(state.pieceTable, byteOffset(0), byteOffset(total));
    });
    assertPerf(`getText full doc (${LINES_LG.toLocaleString()} lines)`, ms, 2_000);
    expect(result).toBe(content_lg);
  });

  it('reads 1 000 × 200-byte slice (random positions)', () => {
    const ITERS = 1_000;
    const SLICE = 200;
    const state = createInitialState({ content: content_lg });
    const total = state.pieceTable.totalLength;
    const rng = makeDeterministicRng(200);
    const ms = bench(() => {
      const start = Math.floor(rng() * (total - SLICE));
      getText(state.pieceTable, byteOffset(start), byteOffset(start + SLICE));
    }, ITERS, STABLE_READ_BENCH);
    assertPerf(`getText 200-byte slice`, ms, 1_000, ITERS);

    const probeStart = Math.floor(total / 3);
    const probe = getText(state.pieceTable, byteOffset(probeStart), byteOffset(probeStart + SLICE));
    expect(probe.length).toBe(SLICE);
  });
});

// ---------------------------------------------------------------------------
// 4. Edits — insert / delete
// ---------------------------------------------------------------------------

describe('Edits via store.dispatch', () => {
  it('1 000 appends (end-of-document inserts)', () => {
    const ITERS = 1_000;
    const store = createDocumentStore({ content: content_md });
    const ms = bench(() => {
      const len = store.getSnapshot().pieceTable.totalLength;
      store.dispatch(DocumentActions.insert(byteOffset(len), 'x'));
    }, ITERS);
    assertPerf(`append × ${ITERS}`, ms, 5_000, ITERS);
    expect(store.getSnapshot().pieceTable.totalLength).toBe(content_md.length + ITERS);
  });

  it('1 000 prepends (beginning inserts)', () => {
    const ITERS = 1_000;
    const store = createDocumentStore({ content: content_md });
    const ms = bench(() => {
      store.dispatch(DocumentActions.insert(byteOffset(0), 'x'));
    }, ITERS);
    assertPerf(`prepend × ${ITERS}`, ms, 5_000, ITERS);
    expect(store.getSnapshot().pieceTable.totalLength).toBe(content_md.length + ITERS);
  });

  it('1 000 inserts at document midpoint', () => {
    const ITERS = 1_000;
    const store = createDocumentStore({ content: content_md });
    const ms = bench(() => {
      const len = store.getSnapshot().pieceTable.totalLength;
      const mid = byteOffset(Math.floor(len / 2));
      store.dispatch(DocumentActions.insert(mid, 'x'));
    }, ITERS);
    assertPerf(`midpoint insert × ${ITERS}`, ms, 5_000, ITERS);
    expect(store.getSnapshot().pieceTable.totalLength).toBe(content_md.length + ITERS);
  });

  it('1 000 random-position single-byte deletes', () => {
    const ITERS = 1_000;
    // Pre-build a large store so deletes can run without exhausting content
    const store = createDocumentStore({ content: content_lg });
    const rng = makeDeterministicRng(400);
    const ms = bench(() => {
      const len = store.getSnapshot().pieceTable.totalLength;
      if (len < 2) return;
      const start = Math.floor(rng() * (len - 1));
      store.dispatch(DocumentActions.delete(byteOffset(start), byteOffset(start + 1)));
    }, ITERS);
    assertPerf(`random delete × ${ITERS}`, ms, 5_000, ITERS);
    expect(store.getSnapshot().pieceTable.totalLength).toBe(content_lg.length - ITERS);
  });
});

// ---------------------------------------------------------------------------
// 5. Reconciliation
// ---------------------------------------------------------------------------

describe('Reconciliation', () => {
  it('reconcileNow after 500 inserts on 50k-line document', () => {
    const EDITS = 500;
    const store = createDocumentStore({ content: content_md });

    // Apply edits without reconciling
    for (let i = 0; i < EDITS; i++) {
      const len = store.getSnapshot().pieceTable.totalLength;
      store.dispatch(DocumentActions.insert(byteOffset(len), `line${i}\n`));
    }

    const ms = bench(() => { store.reconcileNow(); });
    assertPerf(`reconcileNow after ${EDITS} edits`, ms, 10_000);

    const state = store.getSnapshot();
    expect(state.lineIndex.dirtyRanges.length).toBe(0);
    expect(state.lineIndex.rebuildPending).toBe(false);
  });

  it('rebuildLineIndex from scratch on 100k-line document', () => {
    let result: ReturnType<typeof rebuildLineIndex>;
    const ms = bench(() => { result = rebuildLineIndex(content_lg); });
    assertPerf(`rebuildLineIndex (${LINES_LG.toLocaleString()} lines)`, ms, 10_000);
    expect(result!.lineCount).toBe(LINES_LG);
  });

  it('setViewport reconciles 500-line window on 100k-line document', () => {
    const ITERS = 20;
    const WINDOW = 500;
    const store = createDocumentStore({ content: content_lg });
    // Touch document to create dirty state
    store.dispatch(DocumentActions.insert(byteOffset(0), 'x'));

    const lineCount = store.getSnapshot().lineIndex.lineCount;
    const rng = makeDeterministicRng(500);
    const ms = bench(() => {
      const start = Math.floor(rng() * (lineCount - WINDOW));
      store.setViewport(start, start + WINDOW);
    }, ITERS);
    assertPerf(`setViewport (${WINDOW} lines) × ${ITERS}`, ms, 5_000, ITERS);
  });
});

// ---------------------------------------------------------------------------
// 6. Undo / redo
// ---------------------------------------------------------------------------

describe('Undo / redo', () => {
  it('200 undos then 200 redos on 50k-line document', () => {
    const STEPS = 200;
    const store = createDocumentStore({ content: content_md });
    let insertedBytes = 0;

    // Build undo history
    for (let i = 0; i < STEPS; i++) {
      const len = store.getSnapshot().pieceTable.totalLength;
      const text = `${i}\n`;
      insertedBytes += text.length;
      store.dispatch(DocumentActions.insert(byteOffset(len), text));
    }

    const ms = bench(() => {
      for (let i = 0; i < STEPS; i++) {
        store.dispatch(DocumentActions.undo());
      }
      for (let i = 0; i < STEPS; i++) {
        store.dispatch(DocumentActions.redo());
      }
    });
    assertPerf(`${STEPS} undo + ${STEPS} redo`, ms, 5_000);
    expect(store.getSnapshot().pieceTable.totalLength).toBe(content_md.length + insertedBytes);
  });
});

// ---------------------------------------------------------------------------
// 7. Scaling ratio (cost-algebra validation)
//
// These tests confirm that cost annotations are not silently wrong by
// measuring the actual growth rate between the 10k-line and 900k-line
// fixtures. An O(log n) operation's time should grow by roughly
// log(900k)/log(10k) ≈ 1.5×, not 90× (the linear ratio).
// A measured ratio > 5× is treated as a regression.
// ---------------------------------------------------------------------------

describe('Scaling ratio (cost-algebra validation)', () => {
  const ITERS = 5_000;

  it('getLineStartOffset ratio (10k → 900k lines) is sub-linear', () => {
    const state_sm = createInitialState({ content: content_sm });
    const state_lg = createInitialState({ content: content_lg });
    const rng_sm = makeDeterministicRng(1001);
    const rng_lg = makeDeterministicRng(1002);

    const ms_sm = bench(() => {
      getLineStartOffset(state_sm.lineIndex.root, Math.floor(rng_sm() * LINES_SM));
    }, ITERS, STABLE_READ_BENCH);

    const ms_lg = bench(() => {
      getLineStartOffset(state_lg.lineIndex.root, Math.floor(rng_lg() * LINES_LG));
    }, ITERS, STABLE_READ_BENCH);

    const ratio = ms_sm > 0 ? ms_lg / ms_sm : 1;
    // O(log n): expected ≈ log(900k)/log(10k) ≈ 1.5×. Threshold 5× rejects O(n).
    console.log(`[PERF] scaling ratio ${LINES_LG.toLocaleString()}/${LINES_SM.toLocaleString()} lines: ${ratio.toFixed(2)}×`);
    expect(ratio, 'getLineStartOffset must not scale linearly with document size').toBeLessThan(5);
  });

  it('findLineAtPosition ratio (10k → 900k lines) is sub-linear', () => {
    const state_sm = createInitialState({ content: content_sm });
    const state_lg = createInitialState({ content: content_lg });
    const rng_sm = makeDeterministicRng(1003);
    const rng_lg = makeDeterministicRng(1004);

    const ms_sm = bench(() => {
      const pos = byteOffset(Math.floor(rng_sm() * state_sm.pieceTable.totalLength));
      query.findLineAtPosition(state_sm, pos);
    }, ITERS, STABLE_READ_BENCH);

    const ms_lg = bench(() => {
      const pos = byteOffset(Math.floor(rng_lg() * state_lg.pieceTable.totalLength));
      query.findLineAtPosition(state_lg, pos);
    }, ITERS, STABLE_READ_BENCH);

    const ratio = ms_sm > 0 ? ms_lg / ms_sm : 1;
    console.log(`[PERF] findLineAtPosition scaling ratio: ${ratio.toFixed(2)}×`);
    expect(ratio, 'findLineAtPosition must not scale linearly with document size').toBeLessThan(5);
  });
});

// ---------------------------------------------------------------------------
// 8. Stress: mixed edit workload
// ---------------------------------------------------------------------------

describe('Mixed edit workload', () => {
  it('1 000 mixed inserts/deletes/queries on 50k-line document', () => {
    const ITERS = 1_000;
    const store = createDocumentStore({ content: content_md });
    const rng = makeDeterministicRng(600);
    let queries = 0;
    let expectedLength = content_md.length;

    const ms = bench(() => {
      const state = store.getSnapshot();
      const len = state.pieceTable.totalLength;
      const op = rng();

      if (op < 0.5) {
        // Insert
        const pos = byteOffset(Math.floor(rng() * len));
        store.dispatch(DocumentActions.insert(pos, 'ab'));
        expectedLength += 2;
      } else if (op < 0.85 && len > 2) {
        // Delete
        const start = Math.floor(rng() * (len - 1));
        store.dispatch(DocumentActions.delete(byteOffset(start), byteOffset(start + 1)));
        expectedLength -= 1;
      } else {
        // Query
        const lineCount = state.lineIndex.lineCount;
        const line = Math.floor(rng() * lineCount);
        getLineStartOffset(state.lineIndex.root, line);
        queries++;
      }
    }, ITERS);

    assertPerf(`mixed workload × ${ITERS} (${queries} queries)`, ms, 10_000, ITERS);
    expect(queries).toBeGreaterThan(0);
    expect(store.getSnapshot().pieceTable.totalLength).toBe(expectedLength);
  });
});

// ---------------------------------------------------------------------------
// 8. Multibyte content (kanji + emoji)
//
// Kanji:  3 UTF-8 bytes, 1 UTF-16 code unit  → byteOffset ≠ charOffset
// Emoji:  4 UTF-8 bytes, 2 UTF-16 code units → byteOffset ≠ charOffset,
//                                               charOffset ≠ codePointOffset
// These patterns exercise all three offset spaces simultaneously.
// ---------------------------------------------------------------------------

const LINES_MB = 50_000;
let content_mb: string;   // multibyte fixture, built once

// Use a nested beforeAll — vitest runs it before tests in this file scope.
beforeAll(() => {
  content_mb = generateLargeContent({ lineCount: LINES_MB, pattern: 'multibyte', seed: 7 });
});

describe('Multibyte content (kanji + emoji)', () => {
  it(`loads ${LINES_MB.toLocaleString()}-line multibyte document`, () => {
    let state: ReturnType<typeof createInitialState>;
    const ms = bench(() => { state = createInitialState({ content: content_mb }); });
    assertPerf(`createInitialState multibyte (${LINES_MB.toLocaleString()} lines)`, ms, 6_000);
    expect(state!.lineIndex.lineCount).toBe(LINES_MB);

    // Byte size must exceed JS string length due to multi-byte chars
    expect(state!.pieceTable.totalLength).toBeGreaterThan(content_mb.length);
  });

  it(`getLineStartOffset (byte) × 10 000 on multibyte index`, () => {
    const ITERS = 10_000;
    const state = createInitialState({ content: content_mb });
    const root = state.lineIndex.root;
    const lineCount = state.lineIndex.lineCount;
    const totalBytes = state.pieceTable.totalLength;
    const rng = makeDeterministicRng(700);
    const ms = bench(() => {
      const line = Math.floor(rng() * lineCount);
      getLineStartOffset(root, line);
    }, ITERS, STABLE_READ_BENCH);
    assertPerf(`getLineStartOffset byte (multibyte)`, ms, 1_000, ITERS);

    expect(getLineStartOffset(root, 0)).toBe(0);
    const lastStart = getLineStartOffset(root, lineCount - 1);
    expect(lastStart).toBeGreaterThanOrEqual(0);
    expect(lastStart).toBeLessThan(totalBytes);
  });

  it(`getCharStartOffset (UTF-16) × 10 000 on multibyte index`, () => {
    const ITERS = 10_000;
    const state = createInitialState({ content: content_mb });
    const root = state.lineIndex.root;
    const lineCount = state.lineIndex.lineCount;
    const rng = makeDeterministicRng(701);
    const ms = bench(() => {
      const line = Math.floor(rng() * lineCount);
      getCharStartOffset(root, line);
    }, ITERS, STABLE_READ_BENCH);
    assertPerf(`getCharStartOffset UTF-16 (multibyte)`, ms, 1_000, ITERS);

    // Sanity: for multibyte content, char offsets must differ from byte offsets
    const byteOff = getLineStartOffset(root, LINES_MB - 1);
    const charOff = getCharStartOffset(root, LINES_MB - 1);
    expect(charOff).toBeLessThan(byteOff);

    const probeLine = Math.floor(lineCount / 2);
    const probeLoc = query.findLineAtCharPosition(state, getCharStartOffset(root, probeLine));
    expect(probeLoc?.lineNumber).toBe(probeLine);
  });

  it(`findLineAtCharPosition × 10 000 on multibyte index`, () => {
    const ITERS = 10_000;
    const state = createInitialState({ content: content_mb });
    const totalChars = state.lineIndex.root?.subtreeCharLength ?? 0;
    const rng = makeDeterministicRng(702);
    const ms = bench(() => {
      const pos = Math.floor(rng() * totalChars);
      query.findLineAtCharPosition(state, pos);
    }, ITERS, STABLE_READ_BENCH);
    assertPerf(`findLineAtCharPosition (multibyte)`, ms, 1_000, ITERS);

    expect(totalChars).toBeGreaterThan(0);
    expect(query.findLineAtCharPosition(state, 0)?.lineNumber).toBe(0);
    const nearEnd = query.findLineAtCharPosition(state, Math.max(0, totalChars - 1));
    expect(nearEnd).not.toBeNull();
    expect(nearEnd!.lineNumber).toBeLessThan(LINES_MB);
  });

  it('getText on multibyte document', () => {
    const state = createInitialState({ content: content_mb });
    const total = state.pieceTable.totalLength;
    let result: string;
    const ms = bench(() => {
      result = getText(state.pieceTable, byteOffset(0), byteOffset(total));
    });
    assertPerf(`getText full multibyte doc`, ms, 2_000);
    expect(result!).toBe(content_mb);
  });

  it('1 000 appends of kanji + emoji strings', () => {
    const ITERS = 1_000;
    // Tokens to append — mix of kanji (3 bytes) and emoji (4 bytes each)
    const tokens = ['日本語', '😀', '世界', '🚀', '漢字', '🎉'];
    const tokenBytes = tokens.map(utf8ByteLength);
    const store = createDocumentStore({ content: content_mb });
    const initialBytes = store.getSnapshot().pieceTable.totalLength;
    let insertedBytes = 0;
    let t = 0;
    const ms = bench(() => {
      const len = store.getSnapshot().pieceTable.totalLength;
      const tokenIndex = t++ % tokens.length;
      store.dispatch(DocumentActions.insert(byteOffset(len), tokens[tokenIndex]));
      insertedBytes += tokenBytes[tokenIndex];
    }, ITERS);
    assertPerf(`append kanji/emoji × ${ITERS}`, ms, 5_000, ITERS);
    expect(store.getSnapshot().pieceTable.totalLength).toBe(initialBytes + insertedBytes);
  });

  it('1 000 inserts of kanji + emoji at line boundaries', () => {
    const ITERS = 1_000;
    const tokens = ['日本語\n', '😀\n', '世界\n', '🚀\n'];
    const tokenBytes = tokens.map(utf8ByteLength);
    const store = createDocumentStore({ content: content_mb });
    const initial = store.getSnapshot();
    const initialBytes = initial.pieceTable.totalLength;
    const initialLineCount = initial.lineIndex.lineCount;
    // Reconcile once to get valid byte-boundary line offsets
    const reconciled = store.reconcileNow();
    const lineCount = reconciled.lineIndex.lineCount;
    const rng = makeDeterministicRng(710);
    let inserted = 0;
    let insertedBytes = 0;
    const ms = bench(() => {
      // Re-read state each time — previous inserts shift offsets, so use line 0
      // (offset 0) to stay at a guaranteed byte boundary regardless of insertions.
      const targetLine = Math.floor(rng() * Math.min(lineCount, 100));
      // getLineStartOffset on the *current* (lazy) state root still returns the
      // stored offset for unmodified lines near the start of the document.
      const off = getLineStartOffset(store.getSnapshot().lineIndex.root, targetLine);
      const tokenIndex = inserted++ % tokens.length;
      store.dispatch(DocumentActions.insert(byteOffset(off), tokens[tokenIndex]));
      insertedBytes += tokenBytes[tokenIndex];
    }, ITERS);
    assertPerf(`insert kanji/emoji at line boundary × ${ITERS}`, ms, 5_000, ITERS);
    const final = store.getSnapshot();
    expect(final.pieceTable.totalLength).toBe(initialBytes + insertedBytes);
    expect(final.lineIndex.lineCount).toBe(initialLineCount + ITERS);
  });

  it('reconcileNow after 500 multibyte inserts', () => {
    const EDITS = 500;
    const store = createDocumentStore({ content: content_mb });
    const tokens = ['日本語', '😀世界', '漢字🚀', '🎉🌟'];
    const initialLineCount = store.getSnapshot().lineIndex.lineCount;
    for (let i = 0; i < EDITS; i++) {
      const len = store.getSnapshot().pieceTable.totalLength;
      store.dispatch(DocumentActions.insert(byteOffset(len), tokens[i % tokens.length] + '\n'));
    }
    const ms = bench(() => { store.reconcileNow(); });
    assertPerf(`reconcileNow after ${EDITS} multibyte edits`, ms, 10_000);
    const final = store.getSnapshot();
    expect(final.lineIndex.dirtyRanges.length).toBe(0);
    expect(final.lineIndex.rebuildPending).toBe(false);
    expect(final.lineIndex.lineCount).toBe(initialLineCount + EDITS);
  });
});
