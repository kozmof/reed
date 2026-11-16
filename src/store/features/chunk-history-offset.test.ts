/**
 * Regression: history and placement must stay valid when chunks are loaded or
 * evicted around edited text.
 *
 * LOAD_CHUNKS / EVICT_CHUNK shift the resident offset of everything after the
 * chunk. History stores anchored positions (see `HistoryAnchor`) and add pieces
 * carry a placement key, so undo/redo and re-loading land on the right bytes.
 */

import { describe, it, expect } from "vitest";
import {
  createDocumentStore,
  createDocumentStoreFromCheckpoint,
  createDocumentStoreWithEvents,
} from "./store.js";
import { DocumentActions } from "./actions.js";
import { documentReducer } from "./reducer.js";
import { createCheckpoint, restoreCheckpoint } from "./checkpoint.js";
import { createInitialState } from "../core/state.js";
import { byteOffset } from "../../types/branded.js";
import { getBytes, getValue } from "../core/piece-table.js";
import { getUndoCount, getRedoCount } from "./history.js";
import type { DocumentState, HistoryEvictionPolicy } from "../../types/state.js";
import type { DocumentAction } from "../../types/actions.js";

const CHUNK_SIZE = 8;
const enc = (s: string) => new TextEncoder().encode(s);

// Fixed-size chunks: chunk0 = "AAAAAAA\n", chunk1 = "BBBBBBB\n", ...
const CHUNKS = ["AAAAAAA\n", "BBBBBBB\n", "CCCCCCC\n", "DDDDDDD\n"];
const CHUNK0 = CHUNKS[0]!;
const CHUNK1 = CHUNKS[1]!;

function makeStore(
  chunkCount = 2,
  historyEvictionPolicy: HistoryEvictionPolicy = "pin",
  undoGroupTimeout = 0,
) {
  return createDocumentStore({
    chunkSize: CHUNK_SIZE,
    totalFileSize: CHUNK_SIZE * chunkCount,
    reconcileMode: "none",
    historyEvictionPolicy,
    undoGroupTimeout,
  });
}

type Store = ReturnType<typeof makeStore>;
const text = (s: Store) => getValue(s.getSnapshot().pieceTable);
const bytesOf = (s: Store) => {
  const { pieceTable } = s.getSnapshot();
  return [...getBytes(pieceTable, byteOffset(0), byteOffset(pieceTable.totalLength))];
};
const load = (s: Store, i: number) => s.dispatch(DocumentActions.loadChunk(i, enc(CHUNKS[i]!)));
const cursor = (s: Store) => s.getSnapshot().selection.ranges[0];

describe("history offsets across chunk load/evict", () => {
  it("UNDO after loading an earlier chunk removes the edit, not bytes of the new chunk", () => {
    const s = makeStore();
    s.dispatch(DocumentActions.loadChunk(1, enc(CHUNK1)));
    // Resident text: "BBBBBBB\n" — insert "X" at resident offset 2.
    s.dispatch(DocumentActions.insert(byteOffset(2), "X"));
    expect(text(s)).toBe("BBXBBBBB\n");

    // Load chunk 0 in front: every resident offset of chunk 1 shifts by +8.
    s.dispatch(DocumentActions.loadChunk(0, enc(CHUNK0)));
    expect(text(s)).toBe("AAAAAAA\nBBXBBBBB\n");

    s.dispatch(DocumentActions.undo());
    expect(text(s)).toBe("AAAAAAA\nBBBBBBB\n");
  });

  it("REDO after loading an earlier chunk re-applies the edit at the shifted offset", () => {
    const s = makeStore();
    s.dispatch(DocumentActions.loadChunk(1, enc(CHUNK1)));
    s.dispatch(DocumentActions.insert(byteOffset(2), "X"));
    s.dispatch(DocumentActions.undo());
    expect(text(s)).toBe("BBBBBBB\n");

    s.dispatch(DocumentActions.loadChunk(0, enc(CHUNK0)));
    s.dispatch(DocumentActions.redo());
    expect(text(s)).toBe("AAAAAAA\nBBXBBBBB\n");
  });

  it("UNDO after evicting an earlier chunk removes the edit, not bytes at the stale offset", () => {
    const s = makeStore();
    s.dispatch(DocumentActions.loadChunk(0, enc(CHUNK0)));
    s.dispatch(DocumentActions.loadChunk(1, enc(CHUNK1)));
    // Edit inside chunk 1 (resident offset 10 = chunk1[2]).
    s.dispatch(DocumentActions.insert(byteOffset(10), "X"));
    expect(text(s)).toBe("AAAAAAA\nBBXBBBBB\n");

    // Chunk 0 is pristine, so eviction succeeds and chunk 1 shifts by -8.
    s.dispatch(DocumentActions.evictChunk(0));
    expect(text(s)).toBe("BBXBBBBB\n");

    s.dispatch(DocumentActions.undo());
    expect(text(s)).toBe("BBBBBBB\n");
  });

  it("restores the pre-edit selection at the shifted offset after a load", () => {
    const s = makeStore();
    load(s, 1);
    s.dispatch(DocumentActions.setSelection([{ anchor: byteOffset(2), head: byteOffset(2) }]));
    s.dispatch(DocumentActions.insert(byteOffset(2), "X"));
    load(s, 0);
    s.dispatch(DocumentActions.undo());
    expect(cursor(s)).toEqual({ anchor: 10, head: 10 });
    s.dispatch(DocumentActions.redo());
    expect(cursor(s)).toEqual({ anchor: 11, head: 11 });
  });

  it("keeps the live selection on the same text across load and evict", () => {
    const s = makeStore();
    load(s, 1);
    s.dispatch(DocumentActions.setSelection([{ anchor: byteOffset(3), head: byteOffset(5) }]));
    load(s, 0);
    expect(cursor(s)).toEqual({ anchor: 11, head: 13 });
    s.dispatch(DocumentActions.evictChunk(0));
    expect(cursor(s)).toEqual({ anchor: 3, head: 5 });
  });

  it("handles a batch LOAD_CHUNKS in front of an edit", () => {
    const s = makeStore(3);
    load(s, 2);
    s.dispatch(DocumentActions.insert(byteOffset(1), "X"));
    s.dispatch(
      DocumentActions.loadChunks([
        { chunkIndex: 0, data: enc(CHUNKS[0]!) },
        { chunkIndex: 1, data: enc(CHUNKS[1]!) },
      ]),
    );
    expect(text(s)).toBe("AAAAAAA\nBBBBBBB\nCXCCCCCC\n");
    s.dispatch(DocumentActions.undo());
    expect(text(s)).toBe("AAAAAAA\nBBBBBBB\nCCCCCCC\n");
  });

  it("coalesces typing across a chunk load inside the grouping window", () => {
    const s = makeStore(2, "pin", 10_000);
    load(s, 1);
    s.dispatch(DocumentActions.insert(byteOffset(2), "X", undefined, 1000));
    load(s, 0);
    s.dispatch(DocumentActions.insert(byteOffset(11), "Y", undefined, 1001));
    expect(text(s)).toBe("AAAAAAA\nBBXYBBBBB\n");
    expect(getUndoCount(s.getSnapshot())).toBe(1);
    s.dispatch(DocumentActions.undo());
    expect(text(s)).toBe("AAAAAAA\nBBBBBBB\n");
  });
});

describe("eviction while history points inside the chunk", () => {
  it("refuses eviction under the default 'pin' policy, then redo works", () => {
    const s = makeStore();
    load(s, 0);
    load(s, 1);
    s.dispatch(DocumentActions.insert(byteOffset(2), "X"));
    s.dispatch(DocumentActions.undo());
    // Chunk 0 is pristine again, but the redo entry points inside it.
    const before = s.getSnapshot();
    s.dispatch(DocumentActions.evictChunk(0));
    expect(s.getSnapshot()).toBe(before);

    s.dispatch(DocumentActions.redo());
    expect(text(s)).toBe("AAXAAAAA\nBBBBBBB\n");
  });

  it("refuses eviction when insert-then-delete left the chunk pristine", () => {
    const s = makeStore();
    load(s, 0);
    load(s, 1);
    s.dispatch(DocumentActions.insert(byteOffset(2), "X"));
    s.dispatch(DocumentActions.delete(byteOffset(2), byteOffset(3)));
    const before = s.getSnapshot();
    s.dispatch(DocumentActions.evictChunk(0));
    expect(s.getSnapshot()).toBe(before);
    s.dispatch(DocumentActions.undo());
    s.dispatch(DocumentActions.undo());
    expect(text(s)).toBe("AAAAAAA\nBBBBBBB\n");
  });

  it("allows eviction when history only touches the chunk boundary", () => {
    const s = makeStore();
    load(s, 0);
    load(s, 1);
    // Insert at the start of chunk 1 (offset 8), the boundary after chunk 0.
    s.dispatch(DocumentActions.insert(byteOffset(8), "X"));
    s.dispatch(DocumentActions.undo());
    s.dispatch(DocumentActions.evictChunk(0));
    expect(text(s)).toBe("BBBBBBB\n");
    s.dispatch(DocumentActions.redo());
    expect(text(s)).toBe("XBBBBBBB\n");
    load(s, 0);
    expect(text(s)).toBe("AAAAAAA\nXBBBBBBB\n");
  });

  it("evicts under the 'drop' policy and discards the dependent entries", () => {
    const s = makeStore(2, "drop");
    load(s, 0);
    load(s, 1);
    s.dispatch(DocumentActions.insert(byteOffset(10), "1")); // inside chunk 1
    s.dispatch(DocumentActions.insert(byteOffset(2), "2")); // inside chunk 0
    s.dispatch(DocumentActions.insert(byteOffset(12), "3")); // inside chunk 1
    // Undo "3" then "2": chunk 0 is pristine, and the redo stack is ["3", "2"].
    s.dispatch(DocumentActions.undo());
    s.dispatch(DocumentActions.undo());
    expect(getUndoCount(s.getSnapshot())).toBe(1);
    expect(getRedoCount(s.getSnapshot())).toBe(2);

    s.dispatch(DocumentActions.evictChunk(0));
    expect(text(s)).toBe("BB1BBBBB\n");
    // Redo "2" points inside chunk 0, and "3" can only be redone after it.
    expect(getRedoCount(s.getSnapshot())).toBe(0);
    expect(getUndoCount(s.getSnapshot())).toBe(1);
    s.dispatch(DocumentActions.undo());
    expect(text(s)).toBe("BBBBBBB\n");
  });

  // Each entry records positions in the document it applies to. These edit
  // before the chunk afterwards, so the chunk's current span misjudges them.
  const editInsideThenMoveChunk = (s: Store) => {
    load(s, 0);
    load(s, 1);
    load(s, 2);
    s.dispatch(DocumentActions.insert(byteOffset(14), "X")); // inside chunk 1
    s.dispatch(DocumentActions.delete(byteOffset(14), byteOffset(15))); // chunk 1 pristine again
    s.dispatch(DocumentActions.insert(byteOffset(3), "LLLLLLLLLL")); // chunk 1 moves to [18, 26)
  };

  it("refuses eviction when an edit before the chunk moved it after history pointed inside", () => {
    const s = makeStore(3);
    editInsideThenMoveChunk(s);
    const before = s.getSnapshot();
    s.dispatch(DocumentActions.evictChunk(1));
    expect(s.getSnapshot()).toBe(before);
    for (let i = 0; i < 3; i++) s.dispatch(DocumentActions.undo());
    expect(text(s)).toBe(CHUNKS.slice(0, 3).join(""));
  });

  it("drops the moved entries under 'drop' and keeps the later ones", () => {
    const s = makeStore(3, "drop");
    editInsideThenMoveChunk(s);
    s.dispatch(DocumentActions.evictChunk(1));
    expect(getUndoCount(s.getSnapshot())).toBe(1);
    s.dispatch(DocumentActions.undo());
    expect(text(s)).toBe("AAAAAAA\nCCCCCCC\n");
    load(s, 1);
    expect(text(s)).toBe(CHUNKS.slice(0, 3).join(""));
  });

  it("refuses eviction when a redo before the chunk moves it under a later redo", () => {
    const s = makeStore(3);
    load(s, 0);
    load(s, 1);
    load(s, 2);
    s.dispatch(DocumentActions.insert(byteOffset(3), "LLLLLLLLLL")); // chunk 1 moves to [18, 26)
    s.dispatch(DocumentActions.insert(byteOffset(24), "X")); // inside chunk 1
    s.dispatch(DocumentActions.delete(byteOffset(24), byteOffset(25)));
    for (let i = 0; i < 3; i++) s.dispatch(DocumentActions.undo());
    // Chunk 1 is back at [8, 16). Redoing the first entry moves it to [18, 26)
    // again, where the second one points inside it.
    const before = s.getSnapshot();
    s.dispatch(DocumentActions.evictChunk(1));
    expect(s.getSnapshot()).toBe(before);
    for (let i = 0; i < 3; i++) s.dispatch(DocumentActions.redo());
    expect(text(s)).toBe("AAALLLLLLLLLLAAAA\nBBBBBBB\nCCCCCCC\n");
  });

  it("allows eviction when history pointed into text before the chunk that is now gone", () => {
    for (const policy of ["pin", "drop"] as const) {
      const s = makeStore(3, policy);
      load(s, 0);
      load(s, 1);
      load(s, 2);
      s.dispatch(DocumentActions.insert(byteOffset(8), "abc")); // before chunk 1, same key
      s.dispatch(DocumentActions.insert(byteOffset(9), "Z")); // inside "abc"
      s.dispatch(DocumentActions.delete(byteOffset(8), byteOffset(12)));
      s.dispatch(DocumentActions.evictChunk(1));
      expect(text(s), policy).toBe("AAAAAAA\nCCCCCCC\n");
      expect(getUndoCount(s.getSnapshot()), policy).toBe(3);
      for (let i = 0; i < 3; i++) s.dispatch(DocumentActions.undo());
      expect(text(s), policy).toBe("AAAAAAA\nCCCCCCC\n");
      load(s, 1);
      expect(text(s), policy).toBe(CHUNKS.slice(0, 3).join(""));
    }
  });

  it("rejects an unknown historyEvictionPolicy", () => {
    expect(() =>
      createDocumentStore({ historyEvictionPolicy: "keep" as unknown as HistoryEvictionPolicy }),
    ).toThrow(/historyEvictionPolicy/);
  });
});

describe("placement of text next to chunks that are not loaded", () => {
  it("restores deleted text after the unloaded chunk it followed", () => {
    const s = makeStore();
    load(s, 1);
    s.dispatch(DocumentActions.delete(byteOffset(0), byteOffset(3)));
    s.dispatch(DocumentActions.undo());
    expect(text(s)).toBe("BBBBBBB\n");
    load(s, 0);
    expect(text(s)).toBe("AAAAAAA\nBBBBBBB\n");
  });

  it("attaches text typed before visible content to that content", () => {
    const s = makeStore();
    load(s, 1);
    s.dispatch(DocumentActions.insert(byteOffset(0), "X"));
    load(s, 0);
    expect(text(s)).toBe("AAAAAAA\nXBBBBBBB\n");
  });

  it("keeps text typed at the end of a streamed file before later chunks", () => {
    const s = makeStore(3);
    load(s, 0);
    s.dispatch(DocumentActions.insert(byteOffset(8), "X"));
    load(s, 1);
    expect(text(s)).toBe("AAAAAAA\nXBBBBBBB\n");
    load(s, 2);
    expect(text(s)).toBe("AAAAAAA\nXBBBBBBB\nCCCCCCC\n");
  });

  it("keeps text typed after a chunk next to it when a chunk in a hole loads", () => {
    const s = makeStore(3);
    load(s, 0);
    load(s, 1);
    load(s, 2);
    s.dispatch(DocumentActions.evictChunk(1));
    expect(text(s)).toBe("AAAAAAA\nCCCCCCC\n");
    // Typed right after chunk 0's text, with chunk 1 missing after it.
    s.dispatch(DocumentActions.insert(byteOffset(8), "X"));
    load(s, 1);
    expect(text(s)).toBe("AAAAAAA\nXBBBBBBB\nCCCCCCC\n");
    s.dispatch(DocumentActions.undo());
    expect(text(s)).toBe("AAAAAAA\nBBBBBBB\nCCCCCCC\n");
    s.dispatch(DocumentActions.redo());
    expect(text(s)).toBe("AAAAAAA\nXBBBBBBB\nCCCCCCC\n");
  });

  it("keeps a chunk that loads at a selection's edge outside the selection", () => {
    const s = makeStore(3);
    load(s, 0);
    load(s, 2);
    // All of chunk 0, ending at the hole where chunk 1 belongs.
    s.dispatch(DocumentActions.setSelection([{ anchor: byteOffset(0), head: byteOffset(8) }]));
    load(s, 1);
    expect(cursor(s)).toEqual({ anchor: 0, head: 8 });

    // All of chunk 2, starting at the hole: a backward selection this time.
    s.dispatch(DocumentActions.evictChunk(1));
    s.dispatch(DocumentActions.setSelection([{ anchor: byteOffset(16), head: byteOffset(8) }]));
    load(s, 1);
    expect(cursor(s)).toEqual({ anchor: 24, head: 16 });
  });

  it("restores a selection that ended at a hole without the chunk that loaded there", () => {
    const s = makeStore(3);
    load(s, 0);
    load(s, 2);
    s.dispatch(DocumentActions.setSelection([{ anchor: byteOffset(0), head: byteOffset(8) }]));
    s.dispatch(DocumentActions.delete(byteOffset(0), byteOffset(8)));
    load(s, 1);
    s.dispatch(DocumentActions.undo());
    expect(text(s)).toBe("AAAAAAA\nBBBBBBB\nCCCCCCC\n");
    expect(cursor(s)).toEqual({ anchor: 0, head: 8 });
  });

  it("restores a delete that spanned an unloaded chunk on both sides of it", () => {
    const s = makeStore(3);
    load(s, 0);
    load(s, 2);
    // Resident "AAAAAAA\nCCCCCCC\n": delete "A\nCC" across the hole of chunk 1.
    s.dispatch(DocumentActions.delete(byteOffset(6), byteOffset(10)));
    expect(text(s)).toBe("AAAAAACCCCC\n");
    s.dispatch(DocumentActions.undo());
    load(s, 1);
    expect(text(s)).toBe("AAAAAAA\nBBBBBBB\nCCCCCCC\n");
    s.dispatch(DocumentActions.redo());
    expect(text(s)).toBe("AAAAAABBBBBBB\nCCCCC\n");
  });
});

describe("checkpoints carry placement keys and anchors", () => {
  it("round-trips a chunked document with history, then undoes after a load", () => {
    const s = makeStore();
    load(s, 1);
    s.dispatch(DocumentActions.insert(byteOffset(0), "X"));
    s.dispatch(DocumentActions.insert(byteOffset(4), "Y"));
    s.dispatch(DocumentActions.undo());
    const checkpoint = createCheckpoint(s.reconcileNow());
    expect(checkpoint.version).toBe(2);

    let state: DocumentState = restoreCheckpoint(JSON.parse(JSON.stringify(checkpoint)));
    state = documentReducer(state, DocumentActions.loadChunk(0, enc(CHUNK0)));
    expect(getValue(state.pieceTable)).toBe("AAAAAAA\nXBBBBBBB\n");
    state = documentReducer(state, DocumentActions.redo());
    expect(getValue(state.pieceTable)).toBe("AAAAAAA\nXBBBYBBBB\n");
    state = documentReducer(state, DocumentActions.undo());
    state = documentReducer(state, DocumentActions.undo());
    expect(getValue(state.pieceTable)).toBe("AAAAAAA\nBBBBBBB\n");
  });

  it("rejects add-piece placement keys that decrease or exceed the loaded range", () => {
    const s = makeStore();
    load(s, 1);
    s.dispatch(DocumentActions.insert(byteOffset(8), "X"));
    const good = JSON.parse(JSON.stringify(createCheckpoint(s.reconcileNow())));
    // Pieces: chunk 1 (key 0), then "X" after it (key 1).
    expect(good.pieceTable.pieces.map((p: unknown[]) => p[1])).toEqual(["c", "a"]);
    const withKey = (key: number) => ({
      ...good,
      pieceTable: {
        ...good.pieceTable,
        pieces: [good.pieceTable.pieces[0], [...good.pieceTable.pieces[1].slice(0, 4), key]],
      },
    });
    expect(() => restoreCheckpoint(withKey(1))).not.toThrow();
    expect(() => restoreCheckpoint(withKey(-1))).toThrow(/keys must not decrease/);
    expect(() => restoreCheckpoint(withKey(5))).toThrow(/only chunks below 2/);
  });

  it("migrates a version 1 checkpoint and keeps undo correct after a load", () => {
    const s = makeStore();
    load(s, 1);
    s.dispatch(DocumentActions.insert(byteOffset(2), "X"));
    const v2 = JSON.parse(JSON.stringify(createCheckpoint(s.reconcileNow())));
    // Version 1 had no placement keys; strip them to get the v1 payload. With
    // chunk 0 never loaded, anchors equal resident offsets in this layout.
    const v1 = {
      ...v2,
      version: 1,
      pieceTable: {
        ...v2.pieceTable,
        pieces: v2.pieceTable.pieces.map((p: unknown[]) => (p[1] === "a" ? p.slice(0, 4) : p)),
      },
      history: {
        limit: v2.history.limit,
        coalesceTimeout: v2.history.coalesceTimeout,
        undo: v2.history.undo.map((e: { changes: unknown[][] }) => ({
          ...e,
          changes: e.changes.map((c) => c.slice(0, c[0] === "r" ? 4 : 3)),
          selectionBefore: { ranges: [[2, 2]], primaryIndex: 0 },
          selectionAfter: { ranges: [[3, 3]], primaryIndex: 0 },
        })),
        redo: [],
      },
    };

    let state: DocumentState = restoreCheckpoint(v1);
    expect(state.history.evictionPolicy).toBe("pin");
    state = documentReducer(state, DocumentActions.loadChunk(0, enc(CHUNK0)));
    expect(getValue(state.pieceTable)).toBe("AAAAAAA\nBBXBBBBB\n");
    state = documentReducer(state, DocumentActions.undo());
    expect(getValue(state.pieceTable)).toBe("AAAAAAA\nBBBBBBB\n");
    expect(state.selection.ranges[0]).toEqual({ anchor: 10, head: 10 });
  });
});

// =============================================================================
// Randomized consistency check
// =============================================================================

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The full document text: what the state shows once every chunk is loaded.
 * Loading is pure, so this does not disturb the state under test.
 */
function fullText(state: DocumentState): string {
  const missing = CHUNKS.flatMap((data, chunkIndex) =>
    state.pieceTable.chunkMap.has(chunkIndex) ? [] : [{ chunkIndex, data: enc(data) }],
  );
  const loaded =
    missing.length === 0 ? state : documentReducer(state, DocumentActions.loadChunks(missing));
  return getValue(loaded.pieceTable);
}

describe("randomized edits, loads, evictions, undo and redo", () => {
  /**
   * Loads and evictions must never change the full text, and undo/redo must
   * return to exactly the full text recorded at that point in history, however
   * chunks moved in between.
   */
  for (const policy of ["pin", "drop"] as const) {
    it(`keeps the full text consistent (policy: ${policy})`, () => {
      for (let seed = 1; seed <= 150; seed++) {
        const random = rng(seed * 7919 + (policy === "drop" ? 1 : 0));
        const pick = (n: number) => Math.floor(random() * n);
        let state = createInitialState({
          chunkSize: CHUNK_SIZE,
          totalFileSize: CHUNK_SIZE * CHUNKS.length,
          historyEvictionPolicy: policy,
        });
        state = documentReducer(state, DocumentActions.loadChunk(1, enc(CHUNKS[1]!)));
        const undoTexts: string[] = [];
        const redoTexts: string[] = [];
        const log: string[] = [];

        for (let step = 0; step < 60; step++) {
          const before = fullText(state);
          const length = state.pieceTable.totalLength;
          const roll = random();
          let action: DocumentAction | null = null;
          let kind: "edit" | "chunk" | "undo" | "redo";

          if (roll < 0.4) {
            kind = "edit";
            const start = pick(length + 1);
            const editKind = pick(3);
            if (editKind === 0 || length === 0) {
              action = DocumentActions.insert(byteOffset(start), "xyz".slice(0, 1 + pick(3)));
            } else {
              const end = Math.min(length, start + 1 + pick(6));
              if (end <= start) continue;
              action =
                editKind === 1
                  ? DocumentActions.delete(byteOffset(start), byteOffset(end))
                  : DocumentActions.replace(byteOffset(start), byteOffset(end), "#");
            }
          } else if (roll < 0.7) {
            kind = "chunk";
            const chunkIndex = pick(CHUNKS.length);
            action = state.pieceTable.chunkMap.has(chunkIndex)
              ? DocumentActions.evictChunk(chunkIndex)
              : DocumentActions.loadChunk(chunkIndex, enc(CHUNKS[chunkIndex]!));
          } else if (roll < 0.85) {
            kind = "undo";
            action = DocumentActions.undo();
          } else {
            kind = "redo";
            action = DocumentActions.redo();
          }

          log.push(`${action.type}${JSON.stringify(action).slice(0, 80)}`);
          const undoBefore = getUndoCount(state);
          const redoBefore = getRedoCount(state);
          const next = documentReducer(state, action);
          const after = fullText(next);
          const context = () => `seed ${seed}, step ${step}:\n${log.join("\n")}`;

          if (kind === "edit") {
            if (next !== state) {
              undoTexts.push(before);
              redoTexts.length = 0;
            }
          } else if (kind === "chunk") {
            expect(after, context()).toBe(before);
            // Under "drop", eviction may discard the oldest entries of either stack.
            undoTexts.splice(0, undoTexts.length - getUndoCount(next));
            redoTexts.splice(0, redoTexts.length - getRedoCount(next));
            if (policy === "pin") {
              expect(getUndoCount(next)).toBe(undoBefore);
              expect(getRedoCount(next)).toBe(redoBefore);
            }
          } else if (kind === "undo" && undoBefore > 0) {
            expect(after, context()).toBe(undoTexts.pop());
            redoTexts.push(before);
          } else if (kind === "redo" && redoBefore > 0) {
            expect(after, context()).toBe(redoTexts.pop());
            undoTexts.push(before);
          }
          expect(getUndoCount(next), context()).toBe(undoTexts.length);
          expect(getRedoCount(next), context()).toBe(redoTexts.length);
          state = next;
        }
      }
    });
  }
});

describe("history selections that pointed into an evicted chunk", () => {
  it("lands where the evicted chunk was, not inside the chunk after it", () => {
    const s = makeStore(3);
    load(s, 0);
    load(s, 1);
    load(s, 2);
    // Cursor inside chunk 1 (offset 12), then an edit inside chunk 2.
    const inside = byteOffset(12);
    s.dispatch(DocumentActions.insert(byteOffset(20), "X", [{ anchor: inside, head: inside }]));
    // History changes only touch chunk 2, so chunk 1 can be evicted.
    s.dispatch(DocumentActions.evictChunk(1));
    expect(text(s)).toBe("AAAAAAA\nCCCCXCCC\n");

    s.dispatch(DocumentActions.undo());
    expect(text(s)).toBe("AAAAAAA\nCCCCCCC\n");
    // Offset 12 would now be inside chunk 2. The cursor collapses to offset 8,
    // where chunk 1 was, as the live selection does on eviction.
    expect(cursor(s)).toEqual({ anchor: 8, head: 8 });
  });
});

describe("events for chunk loads and evictions", () => {
  function makeEventStore(policy: HistoryEvictionPolicy) {
    return createDocumentStoreWithEvents({
      chunkSize: CHUNK_SIZE,
      totalFileSize: CHUNK_SIZE * 2,
      reconcileMode: "none",
      historyEvictionPolicy: policy,
    });
  }

  it("emits selection-change when a load or eviction moves the selection", () => {
    const s = makeEventStore("pin");
    s.dispatch(DocumentActions.loadChunk(1, enc(CHUNK1)));
    s.dispatch(DocumentActions.setSelection([{ anchor: byteOffset(2), head: byteOffset(2) }]));
    const heads: number[] = [];
    s.addEventListener("selection-change", ({ nextState }) =>
      heads.push(nextState.selection.ranges[0].head),
    );

    s.dispatch(DocumentActions.loadChunk(0, enc(CHUNK0)));
    s.dispatch(DocumentActions.evictChunk(0));
    expect(heads).toEqual([10, 2]);
  });

  it("emits selection-change when undo or redo restores the selection", () => {
    const s = makeEventStore("pin");
    s.dispatch(DocumentActions.loadChunk(0, enc(CHUNK0)));
    s.dispatch(DocumentActions.setSelection([{ anchor: byteOffset(2), head: byteOffset(2) }]));
    s.dispatch(DocumentActions.insert(byteOffset(2), "XY"));
    const heads: number[] = [];
    s.addEventListener("selection-change", ({ nextState }) =>
      heads.push(nextState.selection.ranges[0].head),
    );
    s.dispatch(DocumentActions.undo());
    s.dispatch(DocumentActions.redo());
    expect(heads).toEqual([2, 4]);
  });

  it("does not emit selection-change when the selection stays put", () => {
    const s = makeEventStore("pin");
    let fired = 0;
    s.addEventListener("selection-change", () => fired++);
    // The cursor sits at 0, before chunk 0, so loading does not move it.
    s.dispatch(DocumentActions.loadChunk(0, enc(CHUNK0)));
    expect(fired).toBe(0);
  });

  it("emits history-drop, not history-change, when eviction discards entries", () => {
    const s = makeEventStore("drop");
    s.dispatch(DocumentActions.loadChunk(0, enc(CHUNK0)));
    s.dispatch(DocumentActions.loadChunk(1, enc(CHUNK1)));
    s.dispatch(DocumentActions.insert(byteOffset(2), "X"));
    s.dispatch(DocumentActions.undo());
    let drops = 0;
    let changes = 0;
    s.addEventListener("history-drop", ({ prevState, nextState }) => {
      drops++;
      expect(getRedoCount(prevState)).toBe(1);
      expect(getRedoCount(nextState)).toBe(0);
    });
    s.addEventListener("history-change", () => changes++);

    s.dispatch(DocumentActions.evictChunk(0));
    expect(drops).toBe(1);
    expect(changes).toBe(0);
  });

  it("does not emit history-drop when eviction keeps every entry", () => {
    const s = makeEventStore("drop");
    s.dispatch(DocumentActions.loadChunk(0, enc(CHUNK0)));
    s.dispatch(DocumentActions.loadChunk(1, enc(CHUNK1)));
    s.dispatch(DocumentActions.insert(byteOffset(10), "X"));
    let fired = 0;
    s.addEventListener("history-drop", () => fired++);
    s.dispatch(DocumentActions.evictChunk(0));
    expect(text(s as unknown as Store)).toBe("BBXBBBBB\n");
    expect(fired).toBe(0);
  });
});

describe("checkpoint restore validates history anchors", () => {
  type Wire = Record<string, any>;
  const editUndo = (checkpoint: Wire, edit: (entry: Wire) => void): Wire => {
    const copy = JSON.parse(JSON.stringify(checkpoint));
    edit(copy.history.undo[0]);
    return copy;
  };

  it("rejects placement keys and negative positions in an unchunked document", () => {
    const s = createDocumentStore({ content: "hello" });
    s.dispatch(DocumentActions.insert(byteOffset(0), "x"));
    const checkpoint = createCheckpoint(s.getEagerSnapshot());
    expect(() => restoreCheckpoint(checkpoint)).not.toThrow();

    const keyed = editUndo(checkpoint, (entry) => (entry.changes[0] = ["i", 0, "x", 5]));
    expect(() => restoreCheckpoint(keyed)).toThrow(/placement key 5/);
    const negative = editUndo(checkpoint, (entry) => (entry.changes[0] = ["i", -10, "x"]));
    expect(() => restoreCheckpoint(negative)).toThrow(/at least 0/);
    const keyedSelection = editUndo(
      checkpoint,
      (entry) => (entry.selectionBefore.ranges[0] = [0, 0, 3, 3]),
    );
    expect(() => restoreCheckpoint(keyedSelection)).toThrow(/placement key 3/);
    const negativeSelection = editUndo(
      checkpoint,
      (entry) => (entry.selectionAfter.ranges[0] = [-1, 0]),
    );
    expect(() => restoreCheckpoint(negativeSelection)).toThrow(/at least 0/);
  });

  it("bounds keys by the loaded chunks and positions by the chunks before them", () => {
    const s = makeStore();
    load(s, 1);
    s.dispatch(DocumentActions.insert(byteOffset(2), "X")); // key 0, inside chunk 1
    const checkpoint = createCheckpoint(s.reconcileNow());
    expect(checkpoint.history.undo[0]!.changes[0]).toEqual(["i", 2, "X", 0]);

    // nextExpectedChunk is 2, so key 1 is fine and key 2 is not.
    const atKey = (key: number, position = 2) =>
      editUndo(checkpoint, (entry) => (entry.changes[0] = ["i", position, "X", key]));
    expect(() => restoreCheckpoint(atKey(1))).not.toThrow();
    expect(() => restoreCheckpoint(atKey(2))).toThrow(/placement key 2/);
    // Key 0 can subtract at most one chunk (8 bytes).
    expect(() => restoreCheckpoint(atKey(0, -8))).not.toThrow();
    expect(() => restoreCheckpoint(atKey(0, -9))).toThrow(/at least -8/);
  });

  it("rejects a history selection range with one placement key", () => {
    const s = makeStore();
    load(s, 1);
    s.dispatch(DocumentActions.insert(byteOffset(2), "X"));
    const checkpoint = createCheckpoint(s.reconcileNow());
    const withRange = (range: unknown[]) =>
      editUndo(checkpoint, (entry) => (entry.selectionBefore.ranges[0] = range));
    expect(() => restoreCheckpoint(withRange([2, 2, 0, 0]))).not.toThrow();
    expect(() => restoreCheckpoint(withRange([2, 2]))).not.toThrow();
    expect(() => restoreCheckpoint(withRange([2, 2, 0]))).toThrow(/has 3 elements/);
    expect(() => restoreCheckpoint(withRange([2, 2, 0, 0, 0]))).toThrow(/has 5 elements/);
  });

  it("rejects original pieces after chunk pieces", () => {
    const s = makeStore();
    load(s, 0);
    load(s, 1);
    const checkpoint = JSON.parse(JSON.stringify(createCheckpoint(s.reconcileNow())));
    const [first, second] = checkpoint.pieceTable.pieces;
    expect(first[1]).toBe("c");
    expect(second[1]).toBe("c");
    checkpoint.pieceTable.originalBuffer = btoa("o");
    // Keys would run -1, -1, 0: chunk 0 bytes have key -1 and chunk 1 bytes key 0.
    checkpoint.pieceTable.pieces = [first, second, ["orig", "o", 0, 1]];
    expect(() => restoreCheckpoint(checkpoint)).toThrow(/placement key -1 after 0/);
  });
});

describe("review regressions", () => {
  it("undoes a split delete whose runs decode to a different length", () => {
    // Chunk 0 ends with the lead byte of "é" and chunk 1 starts with its
    // continuation byte. With chunk 1 evicted, 0xC3 is an incomplete character
    // that decodes to U+FFFD (three bytes), and the delete splits at the hole.
    const s = createDocumentStore({ chunkSize: 4, totalFileSize: 12, reconcileMode: "none" });
    const bytes = [
      new Uint8Array([0x61, 0x62, 0x63, 0xc3]),
      new Uint8Array([0xa9, 0x66, 0x67, 0x68]),
      enc("ijkl"),
    ];
    for (const [i, data] of bytes.entries()) s.dispatch(DocumentActions.loadChunk(i, data));
    s.dispatch(DocumentActions.evictChunk(1));
    expect(text(s)).toBe("abc�ijkl");

    s.dispatch(DocumentActions.setSelection([{ anchor: byteOffset(6), head: byteOffset(6) }]));
    s.dispatch(DocumentActions.delete(byteOffset(2), byteOffset(6)));
    expect(text(s)).toBe("abkl");

    s.dispatch(DocumentActions.undo());
    // Undo restores the incomplete byte itself, not U+FFFD.
    const original = [0x61, 0x62, 0x63, 0xc3, ...enc("ijkl")];
    expect(bytesOf(s)).toEqual(original);
    expect(cursor(s)).toEqual({ anchor: 6, head: 6 });

    s.dispatch(DocumentActions.redo());
    expect(text(s)).toBe("abkl");
    s.dispatch(DocumentActions.undo());
    expect(bytesOf(s)).toEqual(original);
    // Reloading chunk 1 completes the character again.
    s.dispatch(DocumentActions.loadChunk(1, bytes[1]!));
    expect(text(s)).toBe("abcéfghijkl");
  });

  it("restores a deleted byte order mark so older entries stay aligned", () => {
    // Decoding drops the BOM, so the deleted text is shorter than the bytes.
    const s = createDocumentStore({
      chunkSize: 8,
      totalFileSize: 16,
      reconcileMode: "none",
    });
    const chunk0 = new Uint8Array([0xef, 0xbb, 0xbf, ...enc("AAAA\n")]);
    s.dispatch(DocumentActions.loadChunk(0, chunk0));
    s.dispatch(DocumentActions.loadChunk(1, enc("BBBBBBB\n")));
    const original = bytesOf(s);

    s.dispatch(DocumentActions.insert(byteOffset(10), "X"));
    s.dispatch(DocumentActions.delete(byteOffset(0), byteOffset(5)));
    s.dispatch(DocumentActions.undo());
    expect(bytesOf(s)).toEqual([...original.slice(0, 10), 0x58, ...original.slice(10)]);
    s.dispatch(DocumentActions.undo());
    expect(bytesOf(s)).toEqual(original);

    // The raw bytes survive a checkpoint round trip.
    s.dispatch(DocumentActions.redo());
    s.dispatch(DocumentActions.redo());
    const checkpoint = JSON.parse(JSON.stringify(createCheckpoint(s.reconcileNow())));
    let state: DocumentState = restoreCheckpoint(checkpoint);
    state = documentReducer(state, DocumentActions.undo());
    state = documentReducer(state, DocumentActions.undo());
    const { pieceTable } = state;
    expect([...getBytes(pieceTable, byteOffset(0), byteOffset(pieceTable.totalLength))]).toEqual(
      original,
    );
  });

  it("keeps a selection at a chunk's start there across evict and reload", () => {
    const s = makeStore(3);
    load(s, 0);
    load(s, 1);
    load(s, 2);
    s.dispatch(DocumentActions.setSelection([{ anchor: byteOffset(8), head: byteOffset(12) }]));
    s.dispatch(DocumentActions.evictChunk(1));
    expect(cursor(s)).toEqual({ anchor: 8, head: 8 });
    load(s, 1);
    expect(cursor(s)).toEqual({ anchor: 8, head: 8 });
    // The same holds over repeated cycles.
    s.dispatch(DocumentActions.evictChunk(1));
    load(s, 1);
    expect(cursor(s)).toEqual({ anchor: 8, head: 8 });
  });

  it("keeps a cursor at a chunk's end there across evict and reload", () => {
    const s = makeStore(3);
    load(s, 0);
    load(s, 1);
    load(s, 2);
    s.dispatch(DocumentActions.setSelection([{ anchor: byteOffset(16), head: byteOffset(16) }]));
    s.dispatch(DocumentActions.evictChunk(1));
    expect(cursor(s)).toEqual({ anchor: 8, head: 8 });
    load(s, 1);
    expect(cursor(s)).toEqual({ anchor: 16, head: 16 });
  });

  it("places the redo cursor at the replayed edit after a chunk loads beside it", () => {
    const s = makeStore(3);
    load(s, 0);
    load(s, 2);
    s.dispatch(DocumentActions.delete(byteOffset(6), byteOffset(10)));
    load(s, 1);
    s.dispatch(DocumentActions.undo());
    s.dispatch(DocumentActions.redo());
    expect(text(s)).toBe("AAAAAABBBBBBB\nCCCCC\n");
    expect(cursor(s)).toEqual({ anchor: 6, head: 6 });
  });
});

describe("fourth review regressions", () => {
  it("keeps deleted bytes whose decoding has the same length but different bytes", () => {
    // Chunk 0 ends with the first three bytes of a four-byte emoji. With chunk
    // 1 not loaded they decode to one U+FFFD, which is also three bytes.
    const s = createDocumentStore({
      chunkSize: 8,
      totalFileSize: 16,
      reconcileMode: "none",
      undoGroupTimeout: 60_000,
    });
    const chunk0 = new Uint8Array([0x41, 0x42, 0x43, 0x44, 0x45, 0xf0, 0x9f, 0x98]);
    const chunk1 = new Uint8Array([0x80, ...enc("FGHIJK\n")]);
    s.dispatch(DocumentActions.loadChunk(0, chunk0));
    s.dispatch(DocumentActions.delete(byteOffset(5), byteOffset(8)));
    const [change] = s.getSnapshot().history.undoStack!.value.changes;
    expect(change!.type).toBe("delete");
    expect([...(change as { bytes?: Iterable<number> }).bytes!]).toEqual([0xf0, 0x9f, 0x98]);

    // A backspace right before it would coalesce, but raw bytes keep it apart.
    s.dispatch(DocumentActions.delete(byteOffset(4), byteOffset(5)));
    expect(getUndoCount(s.getSnapshot())).toBe(2);

    s.dispatch(DocumentActions.undo());
    s.dispatch(DocumentActions.undo());
    expect(bytesOf(s)).toEqual([...chunk0]);
    s.dispatch(DocumentActions.loadChunk(1, chunk1));
    expect(text(s)).toBe("ABCDE😀FGHIJK\n");
  });

  it("stores no bytes for deleted text that does contain U+FFFD but encodes back exactly", () => {
    const s = createDocumentStore({ content: "a�b", reconcileMode: "none" });
    s.dispatch(DocumentActions.delete(byteOffset(1), byteOffset(4)));
    const [change] = s.getSnapshot().history.undoStack!.value.changes;
    expect(change).not.toHaveProperty("bytes");
  });

  it("keeps a cursor's side of an evicted chunk when the selection is set again in place", () => {
    const s = makeStore(4);
    for (let i = 0; i < 4; i++) load(s, i);
    // The start of chunk 3.
    s.dispatch(DocumentActions.setSelection([{ anchor: byteOffset(24), head: byteOffset(24) }]));
    s.dispatch(DocumentActions.evictChunk(2));
    expect(cursor(s)).toEqual({ anchor: 16, head: 16 });
    // An editor view echoing the same selection back.
    s.dispatch(DocumentActions.setSelection([{ anchor: byteOffset(16), head: byteOffset(16) }]));
    load(s, 2);
    expect(cursor(s)).toEqual({ anchor: 24, head: 24 });
  });

  it("places text typed with every chunk evicted where the cursor was", () => {
    const s = makeStore(4);
    for (let i = 0; i < 4; i++) load(s, i);
    // The end of the file.
    s.dispatch(DocumentActions.setSelection([{ anchor: byteOffset(32), head: byteOffset(32) }]));
    for (let i = 0; i < 4; i++) s.dispatch(DocumentActions.evictChunk(i));
    expect(s.getSnapshot().pieceTable.root).toBeNull();
    s.dispatch(DocumentActions.insert(byteOffset(0), "X"));
    for (let i = 0; i < 4; i++) load(s, i);
    expect(text(s)).toBe(CHUNKS.join("") + "X");
    s.dispatch(DocumentActions.undo());
    expect(text(s)).toBe(CHUNKS.join(""));
  });

  it("rejects a null bytes element outside a replace change", () => {
    const s = makeStore();
    load(s, 1);
    s.dispatch(DocumentActions.delete(byteOffset(2), byteOffset(3)));
    const checkpoint = JSON.parse(JSON.stringify(createCheckpoint(s.reconcileNow())));
    expect(checkpoint.history.undo[0].changes[0]).toEqual(["d", 2, "B", 0]);
    checkpoint.history.undo[0].changes[0] = ["d", 2, "B", 0, null];
    expect(() => restoreCheckpoint(checkpoint)).toThrow(
      expect.objectContaining({ code: "MALFORMED" }),
    );
  });

  it("restores a checkpoint with the eviction policy given at restore", () => {
    const s = makeStore();
    load(s, 1);
    // History points inside chunk 1, which is pristine again.
    s.dispatch(DocumentActions.insert(byteOffset(2), "X"));
    s.dispatch(DocumentActions.delete(byteOffset(2), byteOffset(3)));
    const v2 = JSON.parse(JSON.stringify(createCheckpoint(s.reconcileNow())));
    // Version 1 stored no eviction policy.
    const { evictionPolicy: _, ...history } = v2.history;
    const v1 = { ...v2, version: 1, history };

    const pinned = createDocumentStoreFromCheckpoint(v1);
    expect(pinned.getSnapshot().history.evictionPolicy).toBe("pin");
    pinned.dispatch(DocumentActions.evictChunk(1));
    expect(pinned.getSnapshot().pieceTable.chunkMap.has(1)).toBe(true);
    const restored = createDocumentStoreFromCheckpoint(v1, { historyEvictionPolicy: "drop" });
    expect(restored.getSnapshot().history.evictionPolicy).toBe("drop");
    // The policy takes effect: chunk 1 evicts and the entries are dropped.
    restored.dispatch(DocumentActions.evictChunk(1));
    expect(restored.getSnapshot().pieceTable.chunkMap.has(1)).toBe(false);
    expect(getUndoCount(restored.getSnapshot())).toBe(0);

    expect(() =>
      createDocumentStoreFromCheckpoint(v2, {
        historyEvictionPolicy: "keep" as unknown as HistoryEvictionPolicy,
      }),
    ).toThrow(/historyEvictionPolicy/);
  });
});
