/**
 * Regression: history and placement must stay valid when chunks are loaded or
 * evicted around edited text.
 *
 * LOAD_CHUNKS / EVICT_CHUNK shift the resident offset of everything after the
 * chunk. History stores anchored positions (see `HistoryAnchor`) and add pieces
 * carry a placement key, so undo/redo and re-loading land on the right bytes.
 */

import { describe, it, expect, vi } from "vitest";
import {
  createDocumentStore,
  createDocumentStoreFromCheckpoint,
  createDocumentStoreWithEvents,
} from "./store.js";
import { DocumentActions, deserializeAction, serializeAction } from "./actions.js";
import { documentReducer, reduceDocument } from "./reducer.js";
import { withEvents } from "./event-store.js";
import { createCheckpoint, restoreCheckpoint } from "./checkpoint.js";
import { createInitialState } from "../core/state.js";
import { byteLength, byteOffset } from "../../types/branded.js";
import {
  collectPieces,
  getBytes,
  getText,
  getValue,
  getValueStream,
  isUtf8Boundary,
  pieceTableDelete,
  pieceTableInsert,
  residentStartIsFileStart,
} from "../core/piece-table.js";
import { byteKey, keyFitsAfterRemoving, keyFitsAt, pieceKey } from "../core/chunk-anchor.js";
import { isSafeSplice, isSafeSplit } from "../core/utf8-seam.js";
import { getTextForAttention } from "../core/attention.js";
import { query } from "../../api/query.js";
import { lineByteToChar, lineCharToByte } from "../core/line-offsets.js";
import { rebuildLineIndexFromPieceTableState } from "./edit.js";
import { CheckpointError } from "../../types/checkpoint.js";
import { collectLines, rebuildLineIndex } from "../core/line-index.js";
import * as lineIndexModule from "../core/line-index.js";
import { getUndoCount, getRedoCount } from "./history.js";
import type {
  DocumentState,
  HistoryChange,
  HistoryEntry,
  HistoryEvictionPolicy,
  HistorySelectionState,
  HistoryState,
} from "../../types/state.js";
import { pstackPeek, pstackPush, pstackToArray } from "../../types/state.js";
import { anchorSelection, historyForEviction } from "./history-anchor.js";
import { applyUntrackedEdit, historyPush, makeDeleteChange, makeInsertChange } from "./edit.js";
import type { DocumentAction } from "../../types/actions.js";
import { validateAction } from "../../types/actions.js";
import { makeDeterministicRng } from "../../../test-utils/large-content.js";

/** A history selection holding one cursor at anchored `position` with key `key`. */
function anchoredCursor(key: number, position: number): HistorySelectionState {
  const cursor = Object.freeze({
    anchor: position,
    head: position,
    anchorAfterChunk: key,
    headAfterChunk: key,
  });
  return Object.freeze({
    ranges: Object.freeze([cursor]),
    primaryIndex: 0,
  }) as HistorySelectionState;
}

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
/** Offsets of the primary range. Placement keys are checked where they matter. */
const cursor = (s: Store) => {
  const { anchor, head } = s.getSnapshot().selection.ranges[0]!;
  return { anchor, head };
};

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

  it("under 'pin-bounded', refuses a plain eviction and drops history when over the limit", () => {
    const s = makeStore(2, "pin-bounded");
    load(s, 0);
    load(s, 1);
    s.dispatch(DocumentActions.insert(byteOffset(10), "1")); // inside chunk 1
    s.dispatch(DocumentActions.insert(byteOffset(2), "2")); // inside chunk 0
    s.dispatch(DocumentActions.undo());
    // Chunk 0 is pristine, but the redo entry "2" points inside it.
    const before = s.getSnapshot();
    s.dispatch(DocumentActions.evictChunk(0));
    expect(s.getSnapshot()).toBe(before);

    s.dispatch(DocumentActions.evictChunk(0, true));
    expect(text(s)).toBe("BB1BBBBB\n");
    expect(getRedoCount(s.getSnapshot())).toBe(0);
    expect(getUndoCount(s.getSnapshot())).toBe(1);
    s.dispatch(DocumentActions.undo());
    expect(text(s)).toBe("BBBBBBB\n");
  });

  it("ignores overLimit under 'pin'", () => {
    const s = makeStore();
    load(s, 0);
    load(s, 1);
    s.dispatch(DocumentActions.insert(byteOffset(2), "X"));
    s.dispatch(DocumentActions.undo());
    const before = s.getSnapshot();
    s.dispatch(DocumentActions.evictChunk(0, true));
    expect(s.getSnapshot()).toBe(before);
  });

  it("round-trips the 'pin-bounded' policy through a checkpoint", () => {
    const s = makeStore(2, "pin-bounded");
    load(s, 0);
    const restored = restoreCheckpoint(
      JSON.parse(JSON.stringify(createCheckpoint(s.getSnapshot()))),
    );
    expect(restored.history.evictionPolicy).toBe("pin-bounded");
  });

  it("validates overLimit as an optional boolean", () => {
    expect(validateAction({ type: "EVICT_CHUNK", chunkIndex: 0, overLimit: true }).valid).toBe(
      true,
    );
    expect(validateAction({ type: "EVICT_CHUNK", chunkIndex: 0, overLimit: "yes" }).valid).toBe(
      false,
    );
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
    expect(state.history.evictionPolicy).toBe("pin-bounded");
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

    // nextExpectedChunk is 2, so key 1 is fine and key 2 is not. Key 1 fits
    // only after chunk 1 (resident 8), where redo puts "X" back.
    const atKey = (key: number, position = 2) =>
      editUndo(checkpoint, (entry) => (entry.changes[0] = ["i", position, "X", key]));
    expect(() => restoreCheckpoint(atKey(1, 0))).not.toThrow();
    expect(() => restoreCheckpoint(atKey(2))).toThrow(/placement key 2/);
    // A change is replayed in the restored layout, so its position subtracts
    // at most the loaded chunks at or below its key: none for key 0, whose
    // chunk 0 is not loaded, and chunk 1 (8 bytes) for key 1.
    expect(() => restoreCheckpoint(atKey(0, -1))).toThrow(/at least 0/);
    // -8 passes the bound, but redo would insert under key 1 before chunk 1.
    expect(() => restoreCheckpoint(atKey(1, -8))).toThrow(/placement keys out of document order/);
    expect(() => restoreCheckpoint(atKey(1, -9))).toThrow(/at least -8/);
    // A selection is clamped on restore, so it keeps the bound that holds in
    // any layout: one chunk length per chunk at or below its key.
    const selectionAt = (position: number) =>
      editUndo(checkpoint, (entry) => (entry.selectionBefore.ranges[0] = [position, 2, 0, 0]));
    expect(() => restoreCheckpoint(selectionAt(-8))).not.toThrow();
    expect(() => restoreCheckpoint(selectionAt(-9))).toThrow(/at least -8/);
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

  it("places the redo cursor where the edit left it after a chunk loads beside it", () => {
    const s = makeStore(3);
    load(s, 0);
    load(s, 2);
    // A backspace over [6, 10) leaves the caret at 6.
    s.dispatch(
      DocumentActions.delete(byteOffset(6), byteOffset(10), [
        { anchor: byteOffset(10), head: byteOffset(10) },
      ]),
    );
    expect(cursor(s)).toEqual({ anchor: 6, head: 6 });
    load(s, 1);
    const afterLoad = cursor(s);
    s.dispatch(DocumentActions.undo());
    s.dispatch(DocumentActions.redo());
    expect(text(s)).toBe("AAAAAABBBBBBB\nCCCCC\n");
    expect(cursor(s)).toEqual(afterLoad);
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
    expect(pinned.getSnapshot().history.evictionPolicy).toBe("pin-bounded");
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

describe("fifth review regressions", () => {
  const key = (s: Store) => {
    const { anchorAfterChunk, headAfterChunk } = s.getSnapshot().selection.ranges[0]!;
    return { anchorAfterChunk, headAfterChunk };
  };

  it("keeps the cursor's key through undo, so text typed after it stays in place", () => {
    const s = makeStore();
    load(s, 0);
    load(s, 1);
    // Inside chunk 1, so the cursor sits after chunk 0.
    s.dispatch(DocumentActions.setSelection([{ anchor: byteOffset(12), head: byteOffset(12) }]));
    s.dispatch(DocumentActions.evictChunk(0));
    s.dispatch(DocumentActions.evictChunk(1));
    expect(s.getSnapshot().pieceTable.root).toBeNull();
    expect(key(s)).toEqual({ anchorAfterChunk: 0, headAfterChunk: 0 });

    s.dispatch(DocumentActions.insert(byteOffset(0), "X"));
    s.dispatch(DocumentActions.undo());
    expect(key(s)).toEqual({ anchorAfterChunk: 0, headAfterChunk: 0 });
    s.dispatch(DocumentActions.insert(byteOffset(0), "Y"));
    load(s, 0);
    expect(text(s)).toBe("AAAAAAA\nY");

    // Redo restores the key too.
    s.dispatch(DocumentActions.undo());
    s.dispatch(DocumentActions.evictChunk(0));
    s.dispatch(DocumentActions.redo());
    s.dispatch(DocumentActions.undo());
    s.dispatch(DocumentActions.insert(byteOffset(0), "Z"));
    load(s, 1);
    expect(text(s)).toBe("ZBBBBBBB\n");
    load(s, 0);
    expect(text(s)).toBe("AAAAAAA\nZBBBBBBB\n");
  });

  describe("a character split across a chunk edge", () => {
    // "€" is E2 82 AC: chunk 1 ends with its first two bytes.
    const chunks = [
      enc("AAAAAAA\n"),
      new Uint8Array([...enc("BBBBBB"), 0xe2, 0x82]),
      new Uint8Array([0xac, ...enc("CCCCCC\n")]),
    ];
    const splitStore = () => {
      const s = makeStore(3);
      chunks.forEach((data, i) => s.dispatch(DocumentActions.loadChunk(i, data)));
      return s;
    };
    const atBoundary = (s: Store) => {
      const { anchor, head } = cursor(s);
      // Both actions reject a position on a continuation byte.
      s.dispatch(DocumentActions.setSelection([{ anchor, head }]));
      s.dispatch(DocumentActions.insert(head, "!"));
      s.dispatch(DocumentActions.undo());
    };

    it("moves a cursor past its leftover bytes when the chunk is evicted", () => {
      const s = splitStore();
      s.dispatch(DocumentActions.setSelection([{ anchor: byteOffset(10), head: byteOffset(10) }]));
      s.dispatch(DocumentActions.evictChunk(1));
      // Offset 8 would be the orphaned 0xAC.
      expect(cursor(s)).toEqual({ anchor: 9, head: 9 });
      expect(() => atBoundary(s)).not.toThrow();
      s.dispatch(DocumentActions.loadChunk(1, chunks[1]!));
      expect(text(s)).toBe("AAAAAAA\nBBBBBB€CCCCCC\n");
      expect(cursor(s)).toEqual({ anchor: 17, head: 17 });
    });

    it("moves a selection that undo restores past them too", () => {
      const s = splitStore();
      s.dispatch(DocumentActions.setSelection([{ anchor: byteOffset(10), head: byteOffset(10) }]));
      s.dispatch(DocumentActions.insert(byteOffset(0), "X"));
      s.dispatch(DocumentActions.evictChunk(1));
      s.dispatch(DocumentActions.undo());
      expect(text(s)).toBe("AAAAAAA\n�CCCCCC\n");
      expect(cursor(s)).toEqual({ anchor: 9, head: 9 });
      expect(() => atBoundary(s)).not.toThrow();
    });
  });

  it("places remote text typed with every chunk evicted where the cursor was", () => {
    const s = makeStore(4);
    for (let i = 0; i < 4; i++) load(s, i);
    // The end of chunk 1.
    s.dispatch(DocumentActions.setSelection([{ anchor: byteOffset(16), head: byteOffset(16) }]));
    for (let i = 0; i < 4; i++) s.dispatch(DocumentActions.evictChunk(i));
    s.dispatch(DocumentActions.applyRemote([{ type: "insert", start: byteOffset(0), text: "R" }]));
    load(s, 3);
    load(s, 0);
    expect(text(s)).toBe("AAAAAAA\nRDDDDDDD\n");
  });

  describe("text typed at a cursor clamped next to an evicted chunk", () => {
    // Inside chunk 2, then chunks 1 and 2 go: the cursor ends at the end of
    // chunk 0 but stays after chunk 1.
    const clamped = () => {
      const s = makeStore(3);
      for (let i = 0; i < 3; i++) load(s, i);
      s.dispatch(DocumentActions.setSelection([{ anchor: byteOffset(20), head: byteOffset(20) }]));
      s.dispatch(DocumentActions.evictChunk(1));
      s.dispatch(DocumentActions.evictChunk(2));
      expect(cursor(s)).toEqual({ anchor: 8, head: 8 });
      expect(key(s)).toEqual({ anchorAfterChunk: 1, headAfterChunk: 1 });
      return s;
    };

    it("goes after the chunk the cursor was after", () => {
      const s = clamped();
      s.dispatch(DocumentActions.insert(byteOffset(8), "X"));
      load(s, 1);
      expect(text(s)).toBe("AAAAAAA\nBBBBBBB\nX");
    });

    it("does so when the edit carries the same selection inline", () => {
      const s = clamped();
      s.dispatch(
        DocumentActions.insert(byteOffset(8), "X", [
          { anchor: byteOffset(8), head: byteOffset(8) },
        ]),
      );
      load(s, 1);
      expect(text(s)).toBe("AAAAAAA\nBBBBBBB\nX");
    });

    it("keeps the gap's key for a cursor that was set there", () => {
      const s = clamped();
      s.dispatch(DocumentActions.setSelection([{ anchor: byteOffset(4), head: byteOffset(4) }]));
      s.dispatch(DocumentActions.setSelection([{ anchor: byteOffset(8), head: byteOffset(8) }]));
      expect(key(s)).toEqual({ anchorAfterChunk: undefined, headAfterChunk: undefined });
      s.dispatch(DocumentActions.insert(byteOffset(8), "X"));
      load(s, 1);
      expect(text(s)).toBe("AAAAAAA\nXBBBBBBB\n");
    });
  });

  it("ignores a placement key that does not fit the offset", () => {
    const s = makeStore(3);
    for (let i = 0; i < 3; i++) load(s, i);
    // Key 2 names chunk 2, which lies after offset 0 in every layout.
    s.dispatch(
      DocumentActions.setSelection([
        { anchor: byteOffset(0), head: byteOffset(0), anchorAfterChunk: 2, headAfterChunk: 2 },
      ]),
    );
    expect(key(s)).toEqual({ anchorAfterChunk: undefined, headAfterChunk: undefined });
  });

  it("refuses to insert text with a placement key that does not fit the offset", () => {
    const s = makeStore(3);
    for (let i = 0; i < 3; i++) load(s, i);
    const { pieceTable } = s.getSnapshot();
    // Key 2 names chunk 2, which lies after offset 0, so text keyed 2 at
    // offset 0 would put the keys out of order.
    expect(() => pieceTableInsert(pieceTable, byteOffset(0), "X", 2)).toThrow(RangeError);
    // A key that fits is used as given.
    const fitted = pieceTableInsert(pieceTable, byteOffset(0), "X", -1).state;
    expect(getValue(fitted).startsWith("X")).toBe(true);
  });
});

describe("fifth review regressions: checkpoints", () => {
  type Wire = Record<string, any>;
  /** A version 1 payload for the store's document, with `history` as given. */
  const v1Of = (s: Store, history: { undo: unknown[]; redo: unknown[] }): Wire => {
    const v2: Wire = JSON.parse(JSON.stringify(createCheckpoint(s.reconcileNow())));
    return {
      ...v2,
      version: 1,
      pieceTable: {
        ...v2.pieceTable,
        pieces: v2.pieceTable.pieces.map((p: unknown[]) => (p[1] === "a" ? p.slice(0, 4) : p)),
      },
      history: { limit: v2.history.limit, coalesceTimeout: v2.history.coalesceTimeout, ...history },
    };
  };
  const v1Entry = (change: unknown[], before: number, after: number) => ({
    changes: [change],
    selectionBefore: { ranges: [[before, before]], primaryIndex: 0 },
    selectionAfter: { ranges: [[after, after]], primaryIndex: 0 },
    timestamp: 0,
  });

  it("migrates an older undo offset in the document it applied to", () => {
    const s = makeStore(3);
    for (let i = 0; i < 3; i++) load(s, i);
    s.dispatch(DocumentActions.insert(byteOffset(18), "Q")); // chunk 2
    s.dispatch(DocumentActions.insert(byteOffset(3), "ZZZZ")); // chunk 0
    expect(text(s)).toBe("AAAZZZZAAAA\nBBBBBBB\nCCQCCCCC\n");
    // In the captured document, offset 18 falls inside chunk 1.
    const v1 = v1Of(s, {
      undo: [v1Entry(["i", 18, "Q"], 18, 19), v1Entry(["i", 3, "ZZZZ"], 3, 7)],
      redo: [],
    });

    let state: DocumentState = restoreCheckpoint(v1);
    // Nothing points inside chunk 1, so it evicts.
    state = documentReducer(state, DocumentActions.evictChunk(1));
    expect(state.pieceTable.chunkMap.has(1)).toBe(false);
    state = documentReducer(state, DocumentActions.undo());
    state = documentReducer(state, DocumentActions.undo());
    expect(getValue(state.pieceTable)).toBe("AAAAAAA\nCCCCCCC\n");
    state = documentReducer(state, DocumentActions.loadChunk(1, enc(CHUNK1)));
    expect(getValue(state.pieceTable)).toBe("AAAAAAA\nBBBBBBB\nCCCCCCC\n");
  });

  it("migrates a later redo offset in the document the earlier redo leaves", () => {
    const s = makeStore();
    load(s, 0);
    load(s, 1);
    s.dispatch(DocumentActions.delete(byteOffset(0), byteOffset(4)));
    s.dispatch(DocumentActions.insert(byteOffset(6), "Q")); // chunk 1
    s.dispatch(DocumentActions.undo());
    s.dispatch(DocumentActions.undo());
    expect(text(s)).toBe("AAAAAAA\nBBBBBBB\n");
    // Redo is stored oldest first: the delete is redone first. In the
    // captured document, offset 6 falls inside chunk 0.
    const v1 = v1Of(s, {
      undo: [],
      redo: [v1Entry(["i", 6, "Q"], 6, 7), v1Entry(["d", 0, "AAAA"], 0, 0)],
    });

    let state: DocumentState = restoreCheckpoint(v1);
    // The insert points inside chunk 1, so the default policy keeps it.
    state = documentReducer(state, DocumentActions.evictChunk(1));
    expect(state.pieceTable.chunkMap.has(1)).toBe(true);
    state = documentReducer(state, DocumentActions.redo());
    state = documentReducer(state, DocumentActions.redo());
    expect(getValue(state.pieceTable)).toBe("AAA\nBBQBBBBB\n");
  });

  it("round-trips the placement keys of the live selection", () => {
    const s = makeStore(3);
    for (let i = 0; i < 3; i++) load(s, i);
    s.dispatch(DocumentActions.setSelection([{ anchor: byteOffset(20), head: byteOffset(20) }]));
    s.dispatch(DocumentActions.evictChunk(1));
    s.dispatch(DocumentActions.evictChunk(2));
    const checkpoint: Wire = JSON.parse(JSON.stringify(createCheckpoint(s.reconcileNow())));
    expect(checkpoint.selection.ranges).toEqual([[8, 8, 1, 1]]);

    const restored = createDocumentStoreFromCheckpoint(checkpoint, { reconcileMode: "none" });
    restored.dispatch(DocumentActions.insert(byteOffset(8), "X"));
    restored.dispatch(DocumentActions.loadChunk(1, enc(CHUNK1)));
    expect(getValue(restored.getSnapshot().pieceTable)).toBe("AAAAAAA\nBBBBBBB\nX");

    // One stored key; null stands for the other.
    checkpoint.selection.ranges = [[0, 8, null, 1]];
    expect(restoreCheckpoint(checkpoint).selection.ranges[0]).toEqual({
      anchor: 0,
      head: 8,
      headAfterChunk: 1,
    });
    // A key that does not fit its offset is ignored, as on the live selection.
    checkpoint.selection.ranges = [[4, 4, 1, 1]];
    expect(restoreCheckpoint(checkpoint).selection.ranges[0]).toEqual({ anchor: 4, head: 4 });
    checkpoint.selection.ranges = [[8, 8, 1]];
    expect(() => restoreCheckpoint(checkpoint)).toThrow(/3 elements/);
  });

  it("refuses to replay a history change that resolves outside the document", () => {
    const s = makeStore();
    load(s, 1);
    s.dispatch(DocumentActions.insert(byteOffset(2), "X"));
    const checkpoint: Wire = JSON.parse(JSON.stringify(createCheckpoint(s.reconcileNow())));
    expect(checkpoint.history.undo[0].changes[0]).toEqual(["i", 2, "X", 0]);
    // With chunk 0 not loaded, key 0 subtracts nothing.
    checkpoint.history.undo[0].changes[0] = ["i", -500, "X", 0];
    expect(() => restoreCheckpoint(checkpoint)).toThrow(/at least 0/);

    // Past the end: restore replays the stack's lengths and refuses it, so
    // UNDO never meets it.
    checkpoint.history.undo[0].changes[0] = ["i", 100, "X", 0];
    expect(() => restoreCheckpoint(checkpoint)).toThrow(/past the end of the 9-byte document/);
  });
});

describe("sixth review regressions", () => {
  /** Placement keys of the pieces, in document order. */
  const keys = (s: Store) => collectPieces(s.getSnapshot().pieceTable.root).map(pieceKey);
  /** Capture and restore the store's document, which validates it in full. */
  const roundTrip = (s: Store) =>
    restoreCheckpoint(JSON.parse(JSON.stringify(createCheckpoint(s.reconcileNow()))));

  it("gives every deleted byte back its own placement key on undo", () => {
    const s = makeStore();
    load(s, 0);
    load(s, 1);
    s.dispatch(DocumentActions.delete(byteOffset(9), byteOffset(10)));
    // Chunk 0 bytes have key -1 and chunk 1 bytes key 0: two runs, one entry.
    s.dispatch(DocumentActions.delete(byteOffset(6), byteOffset(12)));
    expect(getUndoCount(s.getSnapshot().history)).toBe(2);
    s.dispatch(DocumentActions.undo());
    s.dispatch(DocumentActions.undo());
    expect(text(s)).toBe(CHUNK0 + CHUNK1);
    const k = keys(s);
    expect(k).toEqual([...k].sort((a, b) => a - b));
    expect(() => roundTrip(s)).not.toThrow();
  });

  it("recounts a character that undo joins with bytes of a chunk loaded since the edit", () => {
    // An emoji split across the edge of chunks 0 and 1.
    const bytes = new Uint8Array([
      0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0xf0, 0x9f, 0x98, 0x80, 0x0a, 0x58, 0x59, 0x5a,
      0x0a,
    ]);
    const s = makeStore();
    s.dispatch(DocumentActions.loadChunk(0, bytes.slice(0, 8)));
    s.dispatch(DocumentActions.replace(byteOffset(1), byteOffset(8), "#"));
    s.dispatch(DocumentActions.loadChunk(1, bytes.slice(8)));
    s.dispatch(DocumentActions.undo());
    expect(text(s)).toBe("ABCDEFG\u{1F600}\nXYZ\n");
    const lines = (root: Parameters<typeof collectLines>[0]) =>
      collectLines(root).map((line) => line.charLength);
    expect(lines(s.getSnapshot().lineIndex.root)).toEqual(lines(rebuildLineIndex(text(s)).root));
    expect(() => roundTrip(s)).not.toThrow();
  });

  it("moves a live selection key with the text through remote edits", () => {
    const s = makeStore(3);
    for (let i = 0; i < 3; i++) load(s, i);
    s.dispatch(DocumentActions.setSelection([{ anchor: byteOffset(16), head: byteOffset(16) }]));
    s.dispatch(DocumentActions.evictChunk(1));
    expect(s.getSnapshot().selection.ranges[0]).toEqual({
      anchor: 8,
      head: 8,
      anchorAfterChunk: 1,
      headAfterChunk: 1,
    });
    // A local edit moves the selection with the text, so the key still fits.
    s.dispatch(DocumentActions.insert(byteOffset(0), "xyz"));
    expect(createCheckpoint(s.reconcileNow()).selection.ranges).toEqual([[11, 11, 1, 1]]);
    // So does a remote edit.
    s.dispatch(
      DocumentActions.applyRemote([{ type: "insert", start: byteOffset(0), text: "abc" }]),
    );
    expect(createCheckpoint(s.reconcileNow()).selection.ranges).toEqual([[14, 14, 1, 1]]);
    expect(roundTrip(s).selection.ranges[0]).toEqual(s.getSnapshot().selection.ranges[0]);
  });

  it("keeps inserts with different placement keys in separate changes", () => {
    const s = makeStore(2, "pin", 60_000);
    load(s, 0);
    load(s, 1);
    s.dispatch(DocumentActions.evictChunk(1));
    // At the end of the document, after chunk 0, both keys 0 and 1 fit.
    s.dispatch(DocumentActions.insert(byteOffset(8), "X"));
    s.dispatch(
      DocumentActions.insert(byteOffset(9), "Y", [
        { anchor: byteOffset(9), head: byteOffset(9), anchorAfterChunk: 1, headAfterChunk: 1 },
      ]),
    );
    expect(keys(s)).toEqual([-1, 0, 1]);
    expect(getUndoCount(s.getSnapshot().history)).toBe(2);
    s.dispatch(DocumentActions.undo());
    s.dispatch(DocumentActions.undo());
    s.dispatch(DocumentActions.redo());
    s.dispatch(DocumentActions.redo());
    expect(keys(s)).toEqual([-1, 0, 1]);
    load(s, 1);
    expect(text(s)).toBe(CHUNK0 + "X" + CHUNK1 + "Y");
  });

  it("rejects history change tuples with extra elements or a lone null bytes", () => {
    const s = makeStore();
    load(s, 1);
    s.dispatch(DocumentActions.insert(byteOffset(2), "X"));
    const checkpoint = JSON.parse(JSON.stringify(createCheckpoint(s.reconcileNow())));
    const malformed = expect.objectContaining({ code: "MALFORMED" });
    checkpoint.history.undo[0].changes[0] = ["i", 2, "X", 0, "WA==", "junk"];
    expect(() => restoreCheckpoint(checkpoint)).toThrow(malformed);
    checkpoint.history.undo[0].changes[0] = ["r", 2, "X", "", 0, null];
    expect(() => restoreCheckpoint(checkpoint)).toThrow(malformed);
    checkpoint.history.undo[0].changes[0] = ["r", 2, "X", "", 0, null, "", "junk"];
    expect(() => restoreCheckpoint(checkpoint)).toThrow(malformed);
    checkpoint.history.undo[0].changes[0] = ["i", 2, "X", 0];
    expect(() => restoreCheckpoint(checkpoint)).not.toThrow();
  });

  describe("randomized edits, history and chunk churn stay restorable", () => {
    // Characters of every UTF-8 length, so chunk edges cut characters in two.
    const FILE = enc("a\u00e9\u{1F600}b\n\u4e16c\u{1F600}\u00e9\nde\u{1F600}\u4e16\n".repeat(3));
    const SIZE = 8;
    const COUNT = Math.ceil(FILE.length / SIZE);
    const INSERTS = ["q", "\u00e9", "\u{1F600}", "\n", "xy"];

    for (const policy of ["pin", "drop"] as const) {
      for (const seed of [1, 2, 3, 4, 5, 6]) {
        it(`policy ${policy}, seed ${seed}`, () => {
          const s = createDocumentStore({
            chunkSize: SIZE,
            totalFileSize: FILE.length,
            reconcileMode: "none",
            historyEvictionPolicy: policy,
            historyLimit: 6,
            undoGroupTimeout: 60_000,
          });
          const rng = makeDeterministicRng(seed);
          const rand = (n: number) => Math.floor(rng() * n);
          const boundary = (offset: number) => {
            const { pieceTable } = s.getSnapshot();
            let p = offset;
            while (!isUtf8Boundary(pieceTable, byteOffset(p))) p++;
            return byteOffset(p);
          };
          for (let step = 0; step < 250; step++) {
            const { pieceTable } = s.getSnapshot();
            const total = pieceTable.totalLength;
            const a = boundary(rand(total + 1));
            const b = boundary(Math.min(total, a + rand(12)));
            const chunk = rand(COUNT);
            switch (rand(8)) {
              case 0:
                if (!pieceTable.chunkMap.has(chunk)) {
                  s.dispatch(
                    DocumentActions.loadChunk(chunk, FILE.slice(chunk * SIZE, (chunk + 1) * SIZE)),
                  );
                }
                break;
              case 1:
                if (pieceTable.chunkMap.has(chunk)) s.dispatch(DocumentActions.evictChunk(chunk));
                break;
              case 2: {
                // Half the time type at the caret, as an editor does.
                const at = rand(2) === 0 ? a : s.getSnapshot().selection.ranges[0]!.head;
                s.dispatch(DocumentActions.insert(at, INSERTS[rand(INSERTS.length)]!));
                break;
              }
              case 3:
                if (b > a) s.dispatch(DocumentActions.delete(a, b));
                break;
              case 4:
                s.dispatch(DocumentActions.replace(a, b, INSERTS[rand(INSERTS.length)]!));
                break;
              case 5:
                s.dispatch(DocumentActions.undo());
                break;
              case 6:
                s.dispatch(DocumentActions.redo());
                break;
              case 7:
                s.dispatch(DocumentActions.setSelection([{ anchor: a, head: b }]));
                break;
            }
            const where = `seed ${seed} step ${step}`;
            // Edits move the live selection past them, so it stays on a
            // boundary of the document without the editor setting it again.
            const after = s.getSnapshot();
            const range = after.selection.ranges[0]!;
            expect(Math.max(range.anchor, range.head), where).toBeLessThanOrEqual(
              after.pieceTable.totalLength,
            );
            expect(isUtf8Boundary(after.pieceTable, range.anchor), where).toBe(true);
            expect(isUtf8Boundary(after.pieceTable, range.head), where).toBe(true);
            const k = keys(s);
            expect(k, where).toEqual([...k].sort((x, y) => x - y));
            const chars = (root: Parameters<typeof collectLines>[0]) =>
              collectLines(root).map((line) => line.charLength);
            expect(chars(s.reconcileNow().lineIndex.root), where).toEqual(
              chars(rebuildLineIndex(text(s)).root),
            );
            const restored = roundTrip(s);
            expect(getValue(restored.pieceTable), where).toBe(text(s));
          }
        });
      }
    }
  });
});

describe("seventh review regressions", () => {
  /** Capture and restore a store's document, which validates it in full. */
  const roundTrip = (s: Store) =>
    restoreCheckpoint(JSON.parse(JSON.stringify(createCheckpoint(s.reconcileNow()))));
  const charLengths = (state: DocumentState) =>
    collectLines(state.lineIndex.root).map((line) => line.charLength);

  describe("a delete that starts with U+FEFF", () => {
    it("keeps the line index in step with the text", () => {
      const s = createDocumentStore({ content: "a﻿b\ncd", reconcileMode: "none" });
      s.dispatch(DocumentActions.delete(byteOffset(1), byteOffset(4)));
      expect(text(s)).toBe("ab\ncd");
      expect(charLengths(s.reconcileNow())).toEqual([3, 2]);
      expect(() => roundTrip(s)).not.toThrow();
      s.dispatch(DocumentActions.undo());
      expect(text(s)).toBe("a﻿b\ncd");
      expect(charLengths(s.reconcileNow())).toEqual([4, 2]);
      expect(() => roundTrip(s)).not.toThrow();
    });

    it("does so when a replace starts with one", () => {
      const s = createDocumentStore({ content: "a﻿b\ncd", reconcileMode: "none" });
      s.dispatch(DocumentActions.replace(byteOffset(1), byteOffset(4), "xy"));
      expect(text(s)).toBe("axyb\ncd");
      expect(() => roundTrip(s)).not.toThrow();
    });

    it("does so at the start of a chunk", () => {
      const s = makeStore();
      s.dispatch(DocumentActions.loadChunk(0, enc("﻿AAAA\n")));
      s.dispatch(DocumentActions.delete(byteOffset(0), byteOffset(3)));
      expect(() => roundTrip(s)).not.toThrow();
      s.dispatch(DocumentActions.undo());
      expect(bytesOf(s)).toEqual([...enc("﻿AAAA\n")]);
      expect(() => roundTrip(s)).not.toThrow();
    });
  });

  it("moves the selection past an edit and reports it only when it moves", () => {
    const s = createDocumentStoreWithEvents({ content: "hello", reconcileMode: "none" });
    s.dispatch(DocumentActions.setSelection([{ anchor: byteOffset(5), head: byteOffset(5) }]));
    const heads: number[] = [];
    s.addEventListener("selection-change", ({ nextState }) =>
      heads.push(nextState.selection.ranges[0].head),
    );
    const at = (offset: number) =>
      [{ anchor: byteOffset(offset), head: byteOffset(offset) }] as const;
    // A caret at the insertion point moves past the inserted text.
    s.dispatch(DocumentActions.insert(byteOffset(5), "!", at(5)));
    // An inline selection before the edit stays where it is.
    s.dispatch(DocumentActions.insert(byteOffset(6), "?", at(2)));
    // Without one, the current selection moves: here it shifts after an insert before it.
    s.dispatch(DocumentActions.insert(byteOffset(0), "ab"));
    expect(heads).toEqual([6, 2, 4]);
    // An edit after the selection leaves the same object, so nothing fires.
    const before = s.getSnapshot().selection;
    s.dispatch(DocumentActions.insert(byteOffset(9), "z"));
    expect(s.getSnapshot().selection).toBe(before);
    expect(heads).toEqual([6, 2, 4]);
    // Typing over a selection leaves a caret after the new text.
    s.dispatch(
      DocumentActions.replace(byteOffset(2), byteOffset(7), "Q", [
        { anchor: byteOffset(2), head: byteOffset(7) },
      ]),
    );
    expect(s.getSnapshot().selection.ranges).toEqual([{ anchor: 3, head: 3 }]);
    // Undo restores the selection the edit came from.
    s.dispatch(DocumentActions.undo());
    expect(s.getSnapshot().selection.ranges).toEqual([{ anchor: 2, head: 7 }]);
  });

  describe("a range never grows to take in text inserted at its edge", () => {
    const store = () => createDocumentStore({ content: "hello world", reconcileMode: "none" });
    const select = (s: Store, anchor: number, head: number) =>
      s.dispatch(
        DocumentActions.setSelection([{ anchor: byteOffset(anchor), head: byteOffset(head) }]),
      );
    const ranges = (s: Store) => s.getSnapshot().selection.ranges;

    it("keeps text inserted at a range's end outside it, through undo and redo", () => {
      const s = store();
      select(s, 0, 5);
      s.dispatch(DocumentActions.insert(byteOffset(5), "XYZ"));
      expect(text(s)).toBe("helloXYZ world");
      expect(ranges(s)).toEqual([{ anchor: 0, head: 5 }]);
      s.dispatch(DocumentActions.undo());
      expect(ranges(s)).toEqual([{ anchor: 0, head: 5 }]);
      s.dispatch(DocumentActions.redo());
      expect(ranges(s)).toEqual([{ anchor: 0, head: 5 }]);
    });

    it("does so for a backward range", () => {
      const s = store();
      select(s, 5, 0);
      s.dispatch(DocumentActions.insert(byteOffset(5), "XYZ"));
      expect(ranges(s)).toEqual([{ anchor: 5, head: 0 }]);
    });

    it("moves a range's start past text inserted there", () => {
      const s = store();
      select(s, 5, 8);
      s.dispatch(DocumentActions.insert(byteOffset(5), "XYZ"));
      expect(ranges(s)).toEqual([{ anchor: 8, head: 11 }]);
    });

    it("moves an end inside the replaced text to before the new text", () => {
      const s = store();
      select(s, 0, 7);
      s.dispatch(DocumentActions.replace(byteOffset(5), byteOffset(9), "_"));
      expect(text(s)).toBe("hello_ld");
      expect(ranges(s)).toEqual([{ anchor: 0, head: 5 }]);
    });

    it("collapses a range inside the replaced text to a caret after the new text", () => {
      const s = store();
      select(s, 7, 3);
      s.dispatch(DocumentActions.replace(byteOffset(2), byteOffset(9), "QQ"));
      expect(text(s)).toBe("heQQld");
      expect(ranges(s)).toEqual([{ anchor: 4, head: 4 }]);
    });
  });

  describe("remote inserts at the local cursor", () => {
    // The cursor sat at the start of chunk 2. Evicting chunk 1 leaves it at
    // offset 8, after where chunk 1 was.
    const cursorAfterEvictedChunk = () => {
      const s = makeStore(3);
      for (let i = 0; i < 3; i++) load(s, i);
      s.dispatch(DocumentActions.setSelection([{ anchor: byteOffset(16), head: byteOffset(16) }]));
      s.dispatch(DocumentActions.evictChunk(1));
      expect(s.getSnapshot().selection.ranges[0]).toMatchObject({ head: 8, headAfterChunk: 1 });
      return s;
    };

    it("find the cursor after earlier changes of the batch move it", () => {
      const s = cursorAfterEvictedChunk();
      s.dispatch(
        DocumentActions.applyRemote([
          { type: "insert", start: byteOffset(0), text: "Z" },
          { type: "insert", start: byteOffset(9), text: "Y" },
        ]),
      );
      load(s, 1);
      expect(text(s)).toBe("ZAAAAAAA\nBBBBBBB\nYCCCCCCC\n");
    });

    it("find the cursor after a delete earlier in the batch moves it back", () => {
      const s = cursorAfterEvictedChunk();
      s.dispatch(
        DocumentActions.applyRemote([
          { type: "delete", start: byteOffset(0), length: byteLength(1) },
          { type: "insert", start: byteOffset(7), text: "Y" },
        ]),
      );
      load(s, 1);
      expect(text(s)).toBe("AAAAAA\nBBBBBBB\nYCCCCCCC\n");
    });

    it("keep text typed at the cursor together", () => {
      const s = cursorAfterEvictedChunk();
      s.dispatch(
        DocumentActions.applyRemote([
          { type: "insert", start: byteOffset(8), text: "X" },
          { type: "insert", start: byteOffset(8), text: "Y" },
        ]),
      );
      load(s, 1);
      expect(text(s)).toBe("AAAAAAA\nBBBBBBB\nYXCCCCCCC\n");
    });
  });

  describe("eviction guard for a change at the chunk's start", () => {
    const withStack = (
      state: DocumentState,
      stack: "undoStack" | "redoStack",
      change: HistoryChange,
    ): HistoryState => {
      const selection = anchoredCursor(0, 0);
      const entry: HistoryEntry = Object.freeze({
        changes: Object.freeze([change]),
        selectionBefore: selection,
        selectionAfter: selection,
        timestamp: 0,
      });
      return Object.freeze({ ...state.history, [stack]: pstackPush(null, entry) });
    };
    // Chunk 1 starts at resident offset 8, anchored position 0 with key 0.
    const loaded = () => {
      const s = makeStore();
      load(s, 0);
      load(s, 1);
      return s.getSnapshot();
    };

    it("refuses a redo that deletes the chunk's first bytes", () => {
      const state = loaded();
      const history = withStack(state, "redoStack", makeDeleteChange(0, "BB", 0));
      expect(historyForEviction(state.pieceTable, history, 1, 8)).toBeNull();
    });

    it("refuses an undo that removes the chunk's first bytes", () => {
      const state = loaded();
      const history = withStack(state, "undoStack", makeInsertChange(0, "BB", 0));
      expect(historyForEviction(state.pieceTable, history, 1, 8)).toBeNull();
    });

    it("refuses a delete keyed to the chunk that reaches into it", () => {
      const state = loaded();
      // Starts 2 bytes before the chunk, as text inserted there with key 0 would.
      const history = withStack(state, "redoStack", makeDeleteChange(-2, "xxBB", 0));
      expect(historyForEviction(state.pieceTable, history, 1, 8)).toBeNull();
    });

    it("allows changes at the start that leave the chunk's bytes alone", () => {
      const state = loaded();
      for (const [stack, change] of [
        ["redoStack", makeInsertChange(0, "BB", 0)],
        ["undoStack", makeDeleteChange(0, "BB", 0)],
        ["redoStack", makeDeleteChange(-2, "xx", 0)],
      ] as const) {
        const history = withStack(state, stack, change);
        expect(historyForEviction(state.pieceTable, history, 1, 8)).toBe(history);
      }
    });
  });

  it("keeps a cursor's chunk side when the editor reorders the ranges", () => {
    const s = makeStore(3);
    for (let i = 0; i < 3; i++) load(s, i);
    s.dispatch(
      DocumentActions.setSelection([
        { anchor: byteOffset(16), head: byteOffset(16) },
        { anchor: byteOffset(2), head: byteOffset(4) },
      ]),
    );
    s.dispatch(DocumentActions.evictChunk(1));
    expect(s.getSnapshot().selection.ranges[0]).toMatchObject({ head: 8, headAfterChunk: 1 });
    // The editor echoes the ranges back in the other order, as plain offsets.
    s.dispatch(
      DocumentActions.setSelection([
        { anchor: byteOffset(2), head: byteOffset(4) },
        { anchor: byteOffset(8), head: byteOffset(8) },
      ]),
    );
    expect(s.getSnapshot().selection.ranges[1]).toMatchObject({ head: 8, headAfterChunk: 1 });
    load(s, 1);
    expect(s.getSnapshot().selection.ranges[1]).toMatchObject({ anchor: 16, head: 16 });
  });

  it("keeps an endpoint's chunk side when a range turns around", () => {
    const s = makeStore(3);
    for (let i = 0; i < 3; i++) load(s, i);
    s.dispatch(DocumentActions.setSelection([{ anchor: byteOffset(4), head: byteOffset(16) }]));
    s.dispatch(DocumentActions.evictChunk(1));
    const range = s.getSnapshot().selection.ranges[0]!;
    expect(range).toMatchObject({ anchor: 4, head: 8 });
    // The far side of chunk 1, which the document alone would not give a
    // range end at offset 8.
    const side = range.headAfterChunk;
    expect(side).toBe(1);
    s.dispatch(DocumentActions.setSelection([{ anchor: byteOffset(8), head: byteOffset(4) }]));
    expect(s.getSnapshot().selection.ranges[0]!.anchorAfterChunk).toBe(side);
    load(s, 1);
    expect(cursor(s)).toEqual({ anchor: 16, head: 4 });
  });

  describe("a cursor clamped onto a long run of continuation bytes", () => {
    const SIZE = 400;
    const store = (chunks: Uint8Array[]) => {
      const s = createDocumentStore({
        chunkSize: SIZE,
        totalFileSize: SIZE * chunks.length,
        reconcileMode: "none",
      });
      chunks.forEach((chunk, i) => s.dispatch(DocumentActions.loadChunk(i, chunk)));
      // A cursor inside chunk 1, which then goes.
      s.dispatch(
        DocumentActions.setSelection([{ anchor: byteOffset(500), head: byteOffset(500) }]),
      );
      s.dispatch(DocumentActions.evictChunk(1));
      return s;
    };
    const fill = (length: number, byte: number) => new Uint8Array(length).fill(byte);
    const join = (...parts: Uint8Array[]) => {
      const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const part of parts) {
        out.set(part, at);
        at += part.length;
      }
      return out;
    };
    const filler = fill(SIZE, 0x42);

    it("moves to the nearer end of the run, here the one before it", () => {
      const s = store([
        join(fill(SIZE - 1, 0x41), enc("\n")),
        filler,
        join(fill(300, 0x80), fill(SIZE - 300, 0x43)),
      ]);
      expect(cursor(s)).toEqual({ anchor: SIZE - 1, head: SIZE - 1 });
    });

    it("moves to the nearer end of the run, here the one after it", () => {
      const s = store([
        join(fill(10, 0x41), fill(SIZE - 10, 0x80)),
        filler,
        join(fill(300, 0x80), fill(SIZE - 300, 0x43)),
      ]);
      expect(cursor(s)).toEqual({ anchor: SIZE + 300, head: SIZE + 300 });
    });
  });
});

describe("eighth review regressions", () => {
  type Wire = Record<string, any>;
  const wire = (state: DocumentState<"eager">, mode: "exact" | "normalized" = "exact"): Wire =>
    JSON.parse(JSON.stringify(createCheckpoint(state, { mode })));

  it("keeps a leading U+FEFF in a normalized checkpoint, so undo still applies", () => {
    const s = createDocumentStore({ content: "﻿abc", reconcileMode: "none" });
    s.dispatch(DocumentActions.insert(byteOffset(6), "X"));
    const restored = createDocumentStoreFromCheckpoint(wire(s.reconcileNow(), "normalized"));
    expect(restored.getSnapshot().pieceTable.totalLength).toBe(7);
    restored.dispatch(DocumentActions.undo());
    const { pieceTable } = restored.getSnapshot();
    expect([...getBytes(pieceTable, byteOffset(0), byteOffset(pieceTable.totalLength))]).toEqual([
      ...enc("﻿abc"),
    ]);
    restored.dispatch(DocumentActions.redo());
    expect(restored.getSnapshot().pieceTable.totalLength).toBe(7);
  });

  it("rejects an older undo entry that lands past the document it applies to", () => {
    const s = createDocumentStore({ content: "abc", reconcileMode: "none", undoGroupTimeout: 0 });
    s.dispatch(DocumentActions.insert(byteOffset(3), "X"));
    s.dispatch(DocumentActions.insert(byteOffset(4), "Y"));
    const checkpoint = wire(s.reconcileNow());
    expect(() => restoreCheckpoint(checkpoint)).not.toThrow();
    // [4, 5) fits the 5-byte document, but not the 4 bytes left once "Y" is undone.
    checkpoint.history.undo[0].changes[0] = ["i", 4, "X"];
    expect(() => restoreCheckpoint(checkpoint)).toThrow(/history\.undo\[0\]\.changes\[0\]/);
  });

  it("rejects a redo entry that lands past the document it applies to", () => {
    const s = createDocumentStore({ content: "abc", reconcileMode: "none" });
    s.dispatch(DocumentActions.delete(byteOffset(1), byteOffset(3)));
    s.dispatch(DocumentActions.undo());
    const checkpoint = wire(s.reconcileNow());
    expect(checkpoint.history.redo[0].changes[0]).toEqual(["d", 1, "bc"]);
    expect(() => restoreCheckpoint(checkpoint)).not.toThrow();
    checkpoint.history.redo[0].changes[0] = ["d", 2, "bc"];
    expect(() => restoreCheckpoint(checkpoint)).toThrow(/past the end of the 3-byte document/);
  });

  it("keeps the selection object when undo or redo restores the same selection", () => {
    const s = createDocumentStoreWithEvents({ content: "abc", reconcileMode: "none" });
    let fired = 0;
    s.addEventListener("selection-change", () => fired++);
    s.dispatch(DocumentActions.insert(byteOffset(1), "X"));
    const before = s.getSnapshot().selection;
    s.dispatch(DocumentActions.undo());
    expect(s.getSnapshot().selection).toBe(before);
    expect(fired).toBe(0);
    // The insert left the caret at 0, so redo restores it there too.
    s.dispatch(DocumentActions.redo());
    expect(s.getSnapshot().selection).toBe(before);
    expect(fired).toBe(0);
  });
});

describe("ninth review regressions", () => {
  // "abcdefg世hijklmn" in 8-byte chunks: chunk 0 ends with the lead byte of
  // 世 and chunk 1 starts with its two continuation bytes.
  const SPLIT = enc("abcdefg世hijklmn");
  const splitStore = () =>
    createDocumentStore({ chunkSize: 8, totalFileSize: SPLIT.length, reconcileMode: "none" });
  const loadSplit = (s: Store, i: number) =>
    s.dispatch(DocumentActions.loadChunk(i, SPLIT.slice(i * 8, (i + 1) * 8)));
  const atBoundary = (s: Store) => {
    const { pieceTable, selection } = s.getSnapshot();
    return selection.ranges.every(
      (range) => isUtf8Boundary(pieceTable, range.anchor) && isUtf8Boundary(pieceTable, range.head),
    );
  };

  it("moves a caret typed before leftover continuation bytes past them", () => {
    const s = splitStore();
    loadSplit(s, 1);
    s.dispatch(DocumentActions.insert(byteOffset(0), "X"));
    // The caret steps past the two leftover bytes of 世.
    expect(cursor(s)).toEqual({ anchor: 3, head: 3 });
    expect(atBoundary(s)).toBe(true);
    // Typing at the caret is accepted.
    const at = s.getSnapshot().selection.ranges[0]!.head;
    s.dispatch(DocumentActions.insert(at, "Y"));
    expect(bytesOf(s)).toEqual([...enc("X"), 0xb8, 0x96, ...enc("Yhijklm")]);
  });

  it("moves the caret past leftover continuation bytes on the first chunk load", () => {
    const s = splitStore();
    s.dispatch(DocumentActions.insert(byteOffset(0), "X"));
    expect(cursor(s)).toEqual({ anchor: 1, head: 1 });
    loadSplit(s, 1);
    expect(cursor(s)).toEqual({ anchor: 3, head: 3 });
    expect(atBoundary(s)).toBe(true);
    const at = s.getSnapshot().selection.ranges[0]!.head;
    s.dispatch(DocumentActions.insert(at, "Y"));
    expect(bytesOf(s)).toEqual([...enc("X"), 0xb8, 0x96, ...enc("Yhijklm")]);
  });

  it("keeps the selection object on the first chunk load when no endpoint moves", () => {
    const s = splitStore();
    s.dispatch(DocumentActions.insert(byteOffset(0), "X"));
    const before = s.getSnapshot().selection;
    load(s, 0);
    expect(s.getSnapshot().selection).toBe(before);
  });

  it("restores on redo the selection the edit left", () => {
    const s = createDocumentStore({ content: "0123456789abcdefghijklmnop", reconcileMode: "none" });
    s.dispatch(DocumentActions.setSelection([{ anchor: byteOffset(20), head: byteOffset(20) }]));
    s.dispatch(DocumentActions.insert(byteOffset(10), "XYZ"));
    expect(cursor(s)).toEqual({ anchor: 23, head: 23 });
    s.dispatch(DocumentActions.undo());
    expect(cursor(s)).toEqual({ anchor: 20, head: 20 });
    s.dispatch(DocumentActions.redo());
    expect(cursor(s)).toEqual({ anchor: 23, head: 23 });
  });

  it("restores on redo a range the edit shifted", () => {
    const s = createDocumentStore({ content: "0123456789abcdefghijklmnop", reconcileMode: "none" });
    s.dispatch(DocumentActions.setSelection([{ anchor: byteOffset(15), head: byteOffset(20) }]));
    s.dispatch(DocumentActions.delete(byteOffset(2), byteOffset(4)));
    expect(cursor(s)).toEqual({ anchor: 13, head: 18 });
    s.dispatch(DocumentActions.undo());
    s.dispatch(DocumentActions.redo());
    expect(cursor(s)).toEqual({ anchor: 13, head: 18 });
  });
});

describe("tenth review regressions", () => {
  type Wire = Record<string, any>;
  const wireOf = (s: Store): Wire => JSON.parse(JSON.stringify(createCheckpoint(s.reconcileNow())));
  /** A version 1 payload for the store's document, with `history` as given. */
  const v1Of = (s: Store, history: { undo: unknown[]; redo: unknown[] }): Wire => {
    const v2 = wireOf(s);
    return {
      ...v2,
      version: 1,
      pieceTable: {
        ...v2.pieceTable,
        pieces: v2.pieceTable.pieces.map((p: unknown[]) => (p[1] === "a" ? p.slice(0, 4) : p)),
      },
      history: { limit: v2.history.limit, coalesceTimeout: v2.history.coalesceTimeout, ...history },
    };
  };
  const v1Entry = (change: unknown[], before: number, after: number) => ({
    changes: [change],
    selectionBefore: { ranges: [[before, before]], primaryIndex: 0 },
    selectionAfter: { ranges: [[after, after]], primaryIndex: 0 },
    timestamp: 0,
  });
  /** The CheckpointError `fn` throws. Any other error fails the test. */
  const checkpointError = (fn: () => unknown): CheckpointError => {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(CheckpointError);
      return error as CheckpointError;
    }
    throw new Error("expected a CheckpointError");
  };
  const byteKeyAt = (state: DocumentState, offset: number) =>
    byteKey(state.pieceTable.root, offset);

  it("reports a malformed version 1 chunk piece as a CheckpointError", () => {
    const s = makeStore();
    load(s, 0);
    load(s, 1);
    const v1 = v1Of(s, { undo: [v1Entry(["d", 0, "x"], 0, 0)], redo: [] });
    const chunkPiece = v1.pieceTable.pieces.findIndex((p: unknown[]) => p[1] === "c");
    v1.pieceTable.pieces[chunkPiece][4] = -3;
    expect(checkpointError(() => restoreCheckpoint(v1)).code).toBe("MALFORMED");

    // Chunk pieces out of order.
    const swapped = v1Of(s, { undo: [v1Entry(["d", 0, "x"], 0, 0)], redo: [] });
    const chunks = swapped.pieceTable.pieces.filter((p: unknown[]) => p[1] === "c");
    expect(chunks).toHaveLength(2);
    [chunks[0][4], chunks[1][4]] = [chunks[1][4], chunks[0][4]];
    expect(checkpointError(() => restoreCheckpoint(swapped)).code).toBe("CHUNK_ORDER");
  });

  it("refuses history whose undo would insert text under a key that does not fit", () => {
    const s = makeStore(3);
    for (let i = 0; i < 3; i++) load(s, i);
    s.dispatch(DocumentActions.delete(byteOffset(10), byteOffset(11)));
    const checkpoint = wireOf(s);
    expect(checkpoint.history.undo[0].changes[0]).toEqual(["d", 2, "B", 0]);
    // Undo re-inserts the byte at anchored 12 with key 0: resident 20, inside
    // chunk 2, whose bytes have key 1.
    checkpoint.history.undo[0].changes[0] = ["d", 12, "B", 0];
    const error = checkpointError(() => restoreCheckpoint(checkpoint));
    expect(error.code).toBe("HISTORY_INVALID");
    expect(error.message).toMatch(/placement keys out of document order/);
  });

  it("does not emit selection-change for an edit with an inline selection that stays put", () => {
    const s = createDocumentStoreWithEvents({ content: "0123456789abcdef", reconcileMode: "none" });
    const caret = [{ anchor: byteOffset(10), head: byteOffset(10) }] as const;
    s.dispatch(DocumentActions.setSelection(caret));
    const before = s.getSnapshot().selection;
    let fired = 0;
    s.addEventListener("selection-change", () => fired++);
    // A forward delete at the caret, passing the caret inline.
    s.dispatch(DocumentActions.delete(byteOffset(10), byteOffset(11), caret));
    expect(getValue(s.getSnapshot().pieceTable)).toBe("0123456789bcdef");
    expect(s.getSnapshot().selection).toBe(before);
    expect(fired).toBe(0);
  });

  it("splits a migrated redo delete that spans keys, as a live edit would", () => {
    const s = makeStore();
    load(s, 0);
    load(s, 1);
    // [6, 10) is "A\n" of chunk 0 (key -1) and "BB" of chunk 1 (key 0).
    const v1 = v1Of(s, { undo: [], redo: [v1Entry(["d", 6, "A\nBB"], 6, 6)] });
    let state: DocumentState = restoreCheckpoint(v1);
    state = documentReducer(state, DocumentActions.redo());
    expect(getValue(state.pieceTable)).toBe("AAAAAABBBBB\n");
    state = documentReducer(state, DocumentActions.undo());
    expect(getValue(state.pieceTable)).toBe(CHUNK0 + CHUNK1);
    // Each re-inserted byte has back the key it had.
    expect([6, 7, 8, 9].map((offset) => byteKeyAt(state, offset))).toEqual([-1, -1, 0, 0]);
  });

  it("keeps the exact bytes of a migrated run whose edge cuts a character", () => {
    // Chunk 0 ends with the lead byte of 世, and chunk 1 starts with its two
    // continuation bytes.
    const split = enc("abcdefg世hijklmn");
    const s = createDocumentStore({
      chunkSize: 8,
      totalFileSize: split.length,
      reconcileMode: "none",
    });
    for (let i = 0; i < 3; i++) {
      s.dispatch(DocumentActions.loadChunk(i, split.slice(i * 8, (i + 1) * 8)));
    }
    const v1 = v1Of(s, { undo: [], redo: [v1Entry(["d", 6, "g世"], 6, 6)] });
    let state: DocumentState = restoreCheckpoint(v1);
    state = documentReducer(state, DocumentActions.redo());
    expect(getValue(state.pieceTable)).toBe("abcdefhijklmn");
    state = documentReducer(state, DocumentActions.undo());
    const { pieceTable } = state;
    expect([...getBytes(pieceTable, byteOffset(0), byteOffset(pieceTable.totalLength))]).toEqual([
      ...split,
    ]);
    expect([6, 7, 8, 9].map((offset) => byteKeyAt(state, offset))).toEqual([-1, -1, 0, 0]);
  });

  it("moves a caret typed at 0 past a malformed continuation run, not into the text", () => {
    // Chunk 1 starts with five continuation bytes: more than any character
    // cut by chunk 0 could leave, so the run is malformed text.
    const chunk1 = Uint8Array.from([0x80, 0x80, 0x80, 0x80, 0x80, ...enc("xyz")]);
    const s = makeStore();
    s.dispatch(DocumentActions.loadChunk(1, chunk1));
    s.dispatch(DocumentActions.insert(byteOffset(0), "ab"));
    expect(bytesOf(s)).toEqual([...enc("ab"), ...chunk1]);
    // Past the run, not between "a" and "b".
    expect(cursor(s)).toEqual({ anchor: 7, head: 7 });
  });
});

describe("twelfth review regressions", () => {
  type Wire = Record<string, any>;
  const wireOf = (state: DocumentState): Wire =>
    JSON.parse(JSON.stringify(createCheckpoint(state)));
  /**
   * The version 1 payload a store would have written for `state`: no
   * placement keys, and history positions as resident offsets in the
   * captured chunk layout.
   */
  const toV1 = (state: DocumentState): Wire => {
    const v2 = wireOf(state);
    const lengths = new Map<number, number>(
      v2.pieceTable.chunks.map((c: [number, string]) => [c[0], atob(c[1]).length]),
    );
    const resident = (position: number, key: number | undefined) => {
      let sum = 0;
      for (const [index, length] of lengths) if (index <= (key ?? -1)) sum += length;
      return position + sum;
    };
    const change = (c: any[]) => {
      expect(c.length, "test content has no raw bytes").toBeLessThanOrEqual(c[0] === "r" ? 5 : 4);
      return c[0] === "r"
        ? ["r", resident(c[1], c[4]), c[2], c[3]]
        : [c[0], resident(c[1], c[3]), c[2]];
    };
    const selection = (s: any) => ({
      ...s,
      ranges: s.ranges.map((r: number[]) => [resident(r[0]!, r[2]), resident(r[1]!, r[3])]),
    });
    const entry = (e: any) => ({
      ...e,
      changes: e.changes.map(change),
      selectionBefore: selection(e.selectionBefore),
      selectionAfter: selection(e.selectionAfter),
    });
    return {
      ...v2,
      version: 1,
      pieceTable: {
        ...v2.pieceTable,
        pieces: v2.pieceTable.pieces.map((p: unknown[]) => (p[1] === "a" ? p.slice(0, 4) : p)),
      },
      history: {
        ...v2.history,
        undo: v2.history.undo.map(entry),
        redo: v2.history.redo.map(entry),
      },
    };
  };
  const undoAll = (state: DocumentState) => {
    while (getUndoCount(state) > 0) state = documentReducer(state, DocumentActions.undo());
    return state;
  };
  const redoAll = (state: DocumentState) => {
    while (getRedoCount(state) > 0) state = documentReducer(state, DocumentActions.redo());
    return state;
  };

  it("gives a migrated undo the key of the chunk its deleted bytes came from", () => {
    const chunks = ["abcdef", "\nghijk", "lmnopq"];
    const s = createDocumentStore({ chunkSize: 6, totalFileSize: 18, reconcileMode: "none" });
    s.dispatch(DocumentActions.loadChunk(0, enc(chunks[0]!)));
    s.dispatch(DocumentActions.loadChunk(2, enc(chunks[2]!)));
    // "l", the first byte of chunk 2, which chunk 1 loads before.
    s.dispatch(DocumentActions.delete(byteOffset(6), byteOffset(7)));
    for (const payload of [wireOf(s.reconcileNow()), toV1(s.reconcileNow())]) {
      let state = restoreCheckpoint(payload);
      state = documentReducer(state, DocumentActions.loadChunk(1, enc(chunks[1]!)));
      state = documentReducer(state, DocumentActions.undo());
      expect(getValue(state.pieceTable), `version ${payload.version}`).toBe(chunks.join(""));
    }
  });

  it("tells apart bytes a migrated undo cut from either side of the gap", () => {
    const chunks = ["abcdef", "\nghijk", "lmnopq"];
    const s = createDocumentStore({ chunkSize: 6, totalFileSize: 18, reconcileMode: "none" });
    s.dispatch(DocumentActions.loadChunk(0, enc(chunks[0]!)));
    s.dispatch(DocumentActions.loadChunk(2, enc(chunks[2]!)));
    // "f" ends chunk 0 and "lm" starts chunk 2, deleted one at a time.
    s.dispatch(DocumentActions.delete(byteOffset(6), byteOffset(7)));
    s.dispatch(DocumentActions.delete(byteOffset(5), byteOffset(6)));
    s.dispatch(DocumentActions.delete(byteOffset(5), byteOffset(6)));
    expect(text(s)).toBe("abcdenopq");
    let state = restoreCheckpoint(toV1(s.reconcileNow()));
    state = documentReducer(state, DocumentActions.loadChunk(1, enc(chunks[1]!)));
    state = undoAll(state);
    expect(getValue(state.pieceTable)).toBe(chunks.join(""));
  });

  describe("a migrated undo gives back a loaded chunk with no piece left", () => {
    const capture = (steps: (s: Store) => void) => {
      const s = makeStore(3);
      steps(s);
      return s.reconcileNow();
    };
    const restoreLoadUndo = (payload: Wire, loads: number[]) => {
      let state = restoreCheckpoint(payload);
      for (const i of loads) {
        state = documentReducer(state, DocumentActions.loadChunk(i, enc(CHUNKS[i]!)));
      }
      return getValue(undoAll(state).pieceTable);
    };
    const ABC = CHUNKS.slice(0, 3).join("");

    it("when no chunk piece is resident", () => {
      const captured = capture((s) => {
        load(s, 2);
        s.dispatch(DocumentActions.delete(byteOffset(0), byteOffset(8)));
      });
      expect(getValue(captured.pieceTable)).toBe("");
      for (const payload of [wireOf(captured), toV1(captured)]) {
        expect(restoreLoadUndo(payload, [0, 1]), `version ${payload.version}`).toBe(ABC);
      }
    });

    it("when the whole chunk was deleted next to another", () => {
      const captured = capture((s) => {
        load(s, 0);
        load(s, 2);
        s.dispatch(DocumentActions.delete(byteOffset(8), byteOffset(16)));
      });
      for (const payload of [wireOf(captured), toV1(captured)]) {
        expect(restoreLoadUndo(payload, [1]), `version ${payload.version}`).toBe(ABC);
      }
    });

    it("when the delete also took the end of the chunk before it", () => {
      const captured = capture((s) => {
        load(s, 0);
        load(s, 2);
        s.dispatch(DocumentActions.delete(byteOffset(4), byteOffset(16)));
      });
      for (const payload of [wireOf(captured), toV1(captured)]) {
        expect(restoreLoadUndo(payload, [1]), `version ${payload.version}`).toBe(ABC);
      }
    });

    // Distinct bytes, so where each deleted run came from is not a guess.
    const DISTINCT = ["abcdef", "\nghijk", "lmnopq"];
    const distinct = (steps: (s: ReturnType<typeof createDocumentStore>) => void) => {
      const s = createDocumentStore({ chunkSize: 6, totalFileSize: 18, reconcileMode: "none" });
      s.dispatch(DocumentActions.loadChunk(0, enc(DISTINCT[0]!)));
      s.dispatch(DocumentActions.loadChunk(2, enc(DISTINCT[2]!)));
      steps(s);
      return s.reconcileNow();
    };
    const restoreLoadOneUndo = (payload: Wire) => {
      let state = restoreCheckpoint(payload);
      state = documentReducer(state, DocumentActions.loadChunk(1, enc(DISTINCT[1]!)));
      return getValue(undoAll(state).pieceTable);
    };

    it("when the chunk was deleted in pieces, middle last", () => {
      const captured = distinct((s) => {
        s.dispatch(DocumentActions.delete(byteOffset(10), byteOffset(12)));
        s.dispatch(DocumentActions.delete(byteOffset(6), byteOffset(8)));
        s.dispatch(DocumentActions.delete(byteOffset(6), byteOffset(8)));
      });
      expect(getValue(captured.pieceTable)).toBe(DISTINCT[0]);
      for (const payload of [wireOf(captured), toV1(captured)]) {
        expect(restoreLoadOneUndo(payload), `version ${payload.version}`).toBe(DISTINCT.join(""));
      }
    });

    it("when older deletes left holes in the bytes a later delete took", () => {
      // "nop" first, then "m" and "q" together, then the rest.
      const captured = distinct((s) => {
        s.dispatch(DocumentActions.delete(byteOffset(8), byteOffset(11)));
        s.dispatch(DocumentActions.delete(byteOffset(7), byteOffset(9)));
        s.dispatch(DocumentActions.delete(byteOffset(6), byteOffset(7)));
      });
      expect(getValue(captured.pieceTable)).toBe(DISTINCT[0]);
      for (const payload of [wireOf(captured), toV1(captured)]) {
        expect(restoreLoadOneUndo(payload), `version ${payload.version}`).toBe(DISTINCT.join(""));
      }
    });
  });

  it("checks a placement key outside replay unless the operation says it fits", () => {
    const s = makeStore(2);
    load(s, 0);
    load(s, 1);
    const state = s.getSnapshot();
    // Key 1 lies after chunk 1, so it cannot take offset 0, before chunk 0.
    const op = {
      kind: "insert",
      position: byteOffset(0),
      insertText: "x",
      placement: { kind: "checked", key: 1 },
    } as const;
    expect(() => applyUntrackedEdit(state, op, state.revision + 1)).toThrow(RangeError);
    expect(() => applyUntrackedEdit(state, op, state.revision + 1, true)).toThrow(RangeError);
  });

  describe("randomized version 1 checkpoints", () => {
    // ASCII, so version 1 text keeps every byte, and no byte twice: the
    // migration finds where deleted text came from by looking for it in the
    // chunks, which repeated text leaves to a guess.
    const FILE = Array.from({ length: 90 }, (_, i) => String.fromCharCode(33 + i)).join("");
    const SIZE = 15;
    const COUNT = FILE.length / SIZE;
    const chunkOf = (i: number) => enc(FILE.slice(i * SIZE, (i + 1) * SIZE));
    const INSERTS = ["q", "\n", "xy", "abc"];
    const sorted = (state: DocumentState, where: string) => {
      const k = collectPieces(state.pieceTable.root).map(pieceKey);
      expect(k, where).toEqual([...k].sort((x, y) => x - y));
    };
    const loadAll = (state: DocumentState) => {
      for (let i = 0; i < COUNT; i++) {
        if (!state.pieceTable.chunkMap.has(i)) {
          state = documentReducer(state, DocumentActions.loadChunk(i, chunkOf(i)));
        }
      }
      return state;
    };

    /**
     * The document after 60 random loads, evictions and deletes. `typing`
     * adds undo, redo, inserts and replaces.
     */
    const session = (seed: number, typing: boolean) => {
      const s = createDocumentStore({
        chunkSize: SIZE,
        totalFileSize: FILE.length,
        reconcileMode: "none",
        historyEvictionPolicy: "pin",
        undoGroupTimeout: 0,
      });
      const rng = makeDeterministicRng(seed);
      const rand = (n: number) => Math.floor(rng() * n);
      const insert = () => INSERTS[rand(INSERTS.length)]!;
      for (let step = 0; step < 60; step++) {
        const { pieceTable } = s.getSnapshot();
        const a = rand(pieceTable.totalLength + 1);
        const b = Math.min(pieceTable.totalLength, a + 1 + rand(5));
        const chunk = rand(COUNT);
        const op = rand(typing ? 7 : 3);
        if (op === 0 && !pieceTable.chunkMap.has(chunk)) {
          s.dispatch(DocumentActions.loadChunk(chunk, chunkOf(chunk)));
        } else if (op === 1 && pieceTable.chunkMap.has(chunk)) {
          s.dispatch(DocumentActions.evictChunk(chunk));
        } else if (op === 2 && b > a) {
          s.dispatch(DocumentActions.delete(byteOffset(a), byteOffset(b)));
        } else if (op === 3) {
          s.dispatch(DocumentActions.undo());
        } else if (op === 4) {
          s.dispatch(DocumentActions.redo());
        } else if (op === 5) {
          s.dispatch(DocumentActions.insert(byteOffset(a), insert()));
        } else if (op === 6) {
          s.dispatch(DocumentActions.replace(byteOffset(a), byteOffset(b), insert()));
        }
      }
      return s.reconcileNow();
    };
    for (let seed = 1; seed <= 50; seed++) {
      it(`deleted text comes back where it was, seed ${seed}`, () => {
        const captured = session(seed, false);
        for (const payload of [wireOf(captured), toV1(captured)]) {
          const where = `seed ${seed}, version ${payload.version}`;
          let state = restoreCheckpoint(payload);
          expect(getValue(state.pieceTable), where).toBe(getValue(captured.pieceTable));
          state = undoAll(loadAll(state));
          expect(getValue(state.pieceTable), where).toBe(FILE);
          state = undoAll(redoAll(state));
          expect(getValue(state.pieceTable), where).toBe(FILE);
        }
      });
    }

    // Typed text takes the key of the chunk before it in version 1 (see
    // `migrateV1ToV2`), which need not be where a live edit put it, so only
    // version 2 must undo back to the file. Version 1 history must still
    // replay and keep keys in order.
    for (let seed = 1; seed <= 30; seed++) {
      it(`typed text replays, seed ${seed}`, () => {
        const captured = session(seed, true);
        let live = undoAll(loadAll(restoreCheckpoint(wireOf(captured))));
        expect(getValue(live.pieceTable)).toBe(FILE);
        live = undoAll(redoAll(live));
        expect(getValue(live.pieceTable)).toBe(FILE);

        const where = `seed ${seed}`;
        let state = loadAll(restoreCheckpoint(toV1(captured)));
        // Redo all from here, or undo all first: either way the same text.
        const redone = redoAll(state);
        sorted(redone, where);
        state = undoAll(state);
        sorted(state, where);
        state = redoAll(state);
        expect(getValue(state.pieceTable), where).toBe(getValue(redone.pieceTable));
      });
    }
  });
});

describe("twelfth review regressions: remote edits move the selection", () => {
  const remote = (...changes: Parameters<typeof DocumentActions.applyRemote>[0]) =>
    DocumentActions.applyRemote(changes);
  const range = (anchor: number, head: number) =>
    [{ anchor: byteOffset(anchor), head: byteOffset(head) }] as const;

  it("shifts the selection past remote text before it and fires selection-change", () => {
    const s = createDocumentStoreWithEvents({ content: "0123456789", reconcileMode: "none" });
    s.dispatch(DocumentActions.setSelection(range(2, 6)));
    let fired = 0;
    s.addEventListener("selection-change", () => fired++);
    s.dispatch(remote({ type: "insert", start: byteOffset(0), text: "ab" }));
    expect(cursor(s)).toEqual({ anchor: 4, head: 8 });
    expect(fired).toBe(1);
    // Text after the selection leaves it in place.
    s.dispatch(remote({ type: "delete", start: byteOffset(9), length: byteLength(2) }));
    expect(cursor(s)).toEqual({ anchor: 4, head: 8 });
    expect(fired).toBe(1);
  });

  it("never grows a range to take in remote text at its edges", () => {
    const s = createDocumentStore({ content: "0123456789", reconcileMode: "none" });
    s.dispatch(DocumentActions.setSelection(range(2, 6)));
    s.dispatch(
      remote(
        { type: "insert", start: byteOffset(6), text: "E" },
        { type: "insert", start: byteOffset(2), text: "S" },
      ),
    );
    expect(text(s)).toBe("01S2345E6789");
    expect(cursor(s)).toEqual({ anchor: 3, head: 7 });
  });

  it("keeps a caret before remote text inserted at it, and on a boundary", () => {
    // The document starts with the two continuation bytes of a character
    // that chunk 0, not loaded, cut in two.
    const chunk1 = Uint8Array.from([0xb8, 0x96, ...enc("abcdef")]);
    const s = makeStore();
    s.dispatch(DocumentActions.loadChunk(1, chunk1));
    s.dispatch(DocumentActions.setSelection(range(2, 2)));
    s.dispatch(remote({ type: "insert", start: byteOffset(0), text: "xy" }));
    expect(cursor(s)).toEqual({ anchor: 4, head: 4 });
    expect(isUtf8Boundary(s.getSnapshot().pieceTable, byteOffset(4))).toBe(true);
    // At the caret: the remote text lands after it.
    s.dispatch(remote({ type: "insert", start: byteOffset(4), text: "Q" }));
    expect(cursor(s)).toEqual({ anchor: 4, head: 4 });
    expect(bytesOf(s)).toEqual([...enc("xy"), 0xb8, 0x96, ...enc("Qabcdef")]);
  });

  it("moves a caret inside remotely deleted text to the start of it", () => {
    const s = createDocumentStore({ content: "0123456789", reconcileMode: "none" });
    s.dispatch(DocumentActions.setSelection(range(5, 5)));
    s.dispatch(remote({ type: "delete", start: byteOffset(3), length: byteLength(4) }));
    expect(text(s)).toBe("012789");
    expect(cursor(s)).toEqual({ anchor: 3, head: 3 });
  });
});

describe("deferred anchoring of the selection an edit leaves", () => {
  it("anchors in the edited document even when read after an eviction", () => {
    const s = makeStore(3);
    for (let i = 0; i < 3; i++) load(s, i);
    s.dispatch(DocumentActions.setSelection([{ anchor: byteOffset(18), head: byteOffset(18) }]));
    s.dispatch(DocumentActions.insert(byteOffset(18), "Q")); // chunk 2
    const edited = s.getSnapshot();
    const expected = anchorSelection(edited.pieceTable, edited.selection);
    // Chunk 0 holds no history, so it evicts, which shifts every resident
    // offset after it.
    s.dispatch(DocumentActions.evictChunk(0));
    expect(s.getSnapshot().pieceTable.chunkMap.has(0)).toBe(false);

    const entry = pstackPeek(s.getSnapshot().history.undoStack)!;
    expect(entry.selectionAfter).toEqual(expected);
    s.dispatch(DocumentActions.undo());
    s.dispatch(DocumentActions.redo());
    // The caret after "Q", now that chunk 0's 8 bytes are gone.
    expect(s.getSnapshot().selection.ranges[0]).toMatchObject({ anchor: 11, head: 11 });
  });
});

describe("fifteenth review regressions", () => {
  it("keeps a U+FEFF that starts a range, as line columns count it", () => {
    const s = makeStore(1);
    // Line 1 is bytes 2..8: a 3-byte U+FEFF, then "abc".
    s.dispatch(DocumentActions.loadChunk(0, enc("x\n\uFEFFabc")));
    const pt = s.getSnapshot().pieceTable;
    expect(getText(pt, byteOffset(2), byteOffset(8))).toBe("\uFEFFabc");
    expect(lineByteToChar(pt, 2, 8, 6)).toBe(2);
    expect(lineCharToByte(pt, 2, 8, 2)).toBe(6);
  });

  it("counts a U+FEFF that starts the document when the line index is rebuilt", () => {
    const s = makeStore(1);
    s.dispatch(DocumentActions.loadChunk(0, enc("\uFEFFabcd\n")));
    const state = s.getSnapshot();
    expect(getText(state.pieceTable, byteOffset(0), byteOffset(3))).toBe("\uFEFF");
    // query.getText reads the document as getValue does, stripping the byte order mark.
    expect(getValue(state.pieceTable)).toBe("abcd\n");
    const total = byteOffset(state.pieceTable.totalLength);
    expect(query.getText(state.pieceTable, byteOffset(0), total)).toBe(getValue(state.pieceTable));
    expect(query.getText(state.pieceTable, byteOffset(0), byteOffset(3))).toBe("");
    const rebuilt = rebuildLineIndexFromPieceTableState(state);
    expect(collectLines(rebuilt.lineIndex.root)[0]!.charLength).toBe(6);
  });
});

describe("sixteenth review regressions", () => {
  type Wire = Record<string, any>;
  const wireOf = (s: Store): Wire => JSON.parse(JSON.stringify(createCheckpoint(s.reconcileNow())));
  const restoreError = (checkpoint: Wire): CheckpointError => {
    try {
      restoreCheckpoint(checkpoint);
    } catch (error) {
      expect(error).toBeInstanceOf(CheckpointError);
      return error as CheckpointError;
    }
    throw new Error("expected a CheckpointError");
  };

  it("refuses an undo entry whose text would not fit when redone", () => {
    const s = makeStore();
    load(s, 0);
    load(s, 1);
    s.dispatch(DocumentActions.insert(byteOffset(8), "X"));
    const checkpoint = wireOf(s);
    expect(checkpoint.history.undo[0].changes[0]).toEqual(["i", 0, "X", 0]);
    // The same resident offset 8 under key 1. Undo only deletes, but redo
    // would insert "X" there under key 1, before chunk 1's bytes (key 0).
    checkpoint.history.undo[0].changes[0] = ["i", -8, "X", 1];
    const error = restoreError(checkpoint);
    expect(error.code).toBe("HISTORY_INVALID");
    expect(error.message).toMatch(/placement keys out of document order/);
  });

  it("refuses a redo entry whose text would not fit when undone", () => {
    const s = makeStore();
    load(s, 0);
    load(s, 1);
    s.dispatch(DocumentActions.delete(byteOffset(8), byteOffset(9)));
    s.dispatch(DocumentActions.undo());
    const checkpoint = wireOf(s);
    expect(checkpoint.history.redo[0].changes[0]).toEqual(["d", 0, "B", 0]);
    // Redo only deletes, but undoing it again would put "B" back under key 1.
    checkpoint.history.redo[0].changes[0] = ["d", -8, "B", 1];
    const error = restoreError(checkpoint);
    expect(error.code).toBe("HISTORY_INVALID");
    expect(error.message).toMatch(/placement keys out of document order/);
  });

  it("still restores history whose keys fit both ways, and replays it", () => {
    const s = makeStore();
    load(s, 0);
    load(s, 1);
    s.dispatch(DocumentActions.insert(byteOffset(8), "X"));
    s.dispatch(DocumentActions.delete(byteOffset(12), byteOffset(14)));
    s.dispatch(DocumentActions.undo());
    const restored = createDocumentStoreFromCheckpoint(wireOf(s), { reconcileMode: "none" });
    const before = getValue(restored.getSnapshot().pieceTable);
    restored.dispatch(DocumentActions.undo());
    restored.dispatch(DocumentActions.redo());
    restored.dispatch(DocumentActions.redo());
    restored.dispatch(DocumentActions.undo());
    expect(getValue(restored.getSnapshot().pieceTable)).toBe(before);
  });
});

describe("seventeenth review regressions", () => {
  it("moves a restored history selection inside a character to a boundary without chunks", () => {
    // "é" is bytes 1..3.
    const s = createDocumentStore({ content: "aé", reconcileMode: "none" });
    s.dispatch(DocumentActions.insert(byteOffset(3), "X"));
    const checkpoint = JSON.parse(JSON.stringify(createCheckpoint(s.reconcileNow())));
    s.dispatch(DocumentActions.undo());
    expect(s.getSnapshot().selection.ranges[0]).toMatchObject({ anchor: 0, head: 0 });
    s.dispose();
    // Offset 2 is the continuation byte of "é".
    checkpoint.history.undo[0].selectionBefore.ranges = [[2, 2]];
    const restored = documentReducer(restoreCheckpoint(checkpoint), DocumentActions.undo());
    expect(getValue(restored.pieceTable)).toBe("aé");
    expect(restored.selection.ranges[0]).toMatchObject({ anchor: 3, head: 3 });
  });

  it("derives an entry's selection once a new entry covers it, and only once", () => {
    const state = createInitialState({ content: "abc" });
    let derived = 0;
    const cursor = () => {
      derived++;
      return anchoredCursor(-1, 0);
    };
    const change = makeInsertChange(byteOffset(0), "X");
    let next = historyPush(state, [change], 0, cursor, cursor);
    expect(derived).toBe(1); // selectionBefore only
    // Too late to coalesce: a new entry, which reads the one below.
    next = historyPush(next, [change], 1_000_000, cursor, cursor);
    expect(derived).toBe(3);
    const [below] = [...pstackToArray(next.history.undoStack)];
    expect(below!.selectionAfter).toEqual(anchoredCursor(-1, 0));
    expect(below!.selectionAfter).toBe(below!.selectionAfter);
    expect(derived).toBe(3);
  });
});

describe("chunked replay line updates", () => {
  const replayRepairs = (s: ReturnType<typeof makeStore>, actions: DocumentAction[]) => {
    const repair = vi.spyOn(lineIndexModule, "repairLineIndexWindow");
    try {
      for (const action of actions) s.dispatch(action);
      return repair.mock.calls.length;
    } finally {
      repair.mockRestore();
    }
  };

  it("updates lines without re-reading them when no edge of a replay cuts a character", () => {
    const s = makeStore();
    s.dispatch(DocumentActions.loadChunk(0, enc("ABCDEFGH")));
    s.dispatch(DocumentActions.loadChunk(1, enc("IJKLMN\n\n")));
    s.dispatch(DocumentActions.insert(byteOffset(10), "é"));
    s.dispatch(DocumentActions.delete(byteOffset(3), byteOffset(5)));
    expect(
      replayRepairs(s, [
        DocumentActions.undo(),
        DocumentActions.undo(),
        DocumentActions.redo(),
        DocumentActions.redo(),
      ]),
    ).toBe(0);
    expect(text(s)).toBe("ABCFGHIJéKLMN\n\n");
    const lines = (root: Parameters<typeof collectLines>[0]) =>
      collectLines(root).map((line) => `${line.lineLength}:${line.charLength}`);
    const reconciled = s.reconcileNow();
    expect(lines(reconciled.lineIndex.root)).toEqual(lines(rebuildLineIndex(text(s)).root));
  });

  it("re-reads the lines when a replay joins a character cut at its edge", () => {
    // An emoji split across the edge of chunks 0 and 1.
    const bytes = new Uint8Array([
      0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0xf0, 0x9f, 0x98, 0x80, 0x0a, 0x58, 0x59, 0x5a,
      0x0a,
    ]);
    const s = makeStore();
    s.dispatch(DocumentActions.loadChunk(0, bytes.slice(0, 8)));
    s.dispatch(DocumentActions.replace(byteOffset(1), byteOffset(8), "#"));
    s.dispatch(DocumentActions.loadChunk(1, bytes.slice(8)));
    expect(replayRepairs(s, [DocumentActions.undo()])).toBeGreaterThan(0);
    expect(text(s)).toBe("ABCDEFG\u{1F600}\nXYZ\n");
  });
});

describe("EVICT_CHUNKS", () => {
  /** Three loaded chunks; undo and redo history points inside chunk 0 only. */
  function storeWithHistoryInChunk0(policy: HistoryEvictionPolicy) {
    const s = makeStore(3, policy);
    for (let i = 0; i < 3; i++) load(s, i);
    s.dispatch(DocumentActions.insert(byteOffset(2), "X"));
    s.dispatch(DocumentActions.insert(byteOffset(4), "Y"));
    s.dispatch(DocumentActions.undo());
    s.dispatch(DocumentActions.undo());
    return s;
  }
  const loaded = (s: Store) => [...s.getSnapshot().pieceTable.chunkMap.keys()].sort();

  it.each([
    ["pin", [0], 2],
    ["pin-bounded", [], 0],
    ["drop", [], 0],
  ] as const)(
    "evicts candidates that cost no history first, then as '%s' allows, in one transition",
    (policy, kept, redo) => {
      const s = storeWithHistoryInChunk0(policy);
      const revision = s.getSnapshot().revision;
      let notified = 0;
      s.subscribe(() => notified++);
      s.dispatch(DocumentActions.evictChunks([0, 1, 2], 0));
      expect(loaded(s)).toEqual(kept);
      expect(getRedoCount(s.getSnapshot())).toBe(redo);
      expect(notified).toBe(1);
      expect(s.getSnapshot().revision).toBe(revision + 3 - kept.length);
    },
  );

  it("stops as soon as the limit is met, skipping candidates that cost history", () => {
    const s = storeWithHistoryInChunk0("drop");
    s.dispatch(DocumentActions.evictChunks([0, 2, 1], 2));
    expect(loaded(s)).toEqual([0, 1]);
    expect(getRedoCount(s.getSnapshot())).toBe(2);
  });

  it("leaves the state unchanged when nothing needs evicting or nothing can be", () => {
    const s = storeWithHistoryInChunk0("pin");
    const before = s.getSnapshot();
    s.dispatch(DocumentActions.evictChunks([0, 1, 2], 3));
    s.dispatch(DocumentActions.evictChunks([0], 0));
    s.dispatch(DocumentActions.evictChunks([], 0));
    expect(s.getSnapshot()).toBe(before);
  });

  it("emits history-drop when it discards entries", () => {
    const s = createDocumentStoreWithEvents({
      chunkSize: CHUNK_SIZE,
      totalFileSize: CHUNK_SIZE * 2,
      reconcileMode: "none",
      historyEvictionPolicy: "pin-bounded",
    });
    s.dispatch(DocumentActions.loadChunk(0, enc(CHUNK0)));
    s.dispatch(DocumentActions.loadChunk(1, enc(CHUNK1)));
    s.dispatch(DocumentActions.insert(byteOffset(2), "X"));
    s.dispatch(DocumentActions.undo());
    let drops = 0;
    s.addEventListener("history-drop", () => drops++);
    s.dispatch(DocumentActions.evictChunks([0, 1], 1));
    // Chunk 1 costs no history, so it goes and chunk 0 keeps its redo entry.
    expect(drops).toBe(0);
    expect(getRedoCount(s.getSnapshot())).toBe(1);
    s.dispatch(DocumentActions.evictChunks([0], 0));
    expect(drops).toBe(1);
    expect(getRedoCount(s.getSnapshot())).toBe(0);
  });

  it("validates and round-trips through serialization", () => {
    const action = DocumentActions.evictChunks([2, 0], 1);
    expect(validateAction(action).valid).toBe(true);
    expect(deserializeAction(serializeAction(action))).toEqual(action);
    for (const bad of [
      { type: "EVICT_CHUNKS", chunkIndices: [0], maxLoaded: -1 },
      { type: "EVICT_CHUNKS", chunkIndices: [0.5], maxLoaded: 1 },
      { type: "EVICT_CHUNKS", chunkIndices: 0, maxLoaded: 1 },
      { type: "EVICT_CHUNKS", chunkIndices: [0] },
    ]) {
      expect(validateAction(bad).valid, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("nineteenth review regressions", () => {
  // A U+FEFF that starts chunk 1: file content, not a byte order mark.
  const BOM_CHUNK1 = "﻿BBBB\n";

  it("keeps a U+FEFF that starts the resident text while chunk 0 is not loaded", () => {
    const s = makeStore(2);
    s.dispatch(DocumentActions.loadChunk(1, enc(BOM_CHUNK1)));
    const pt = s.getSnapshot().pieceTable;
    expect(getValue(pt)).toBe(BOM_CHUNK1);
    expect(query.getText(pt, byteOffset(0), byteOffset(pt.totalLength))).toBe(BOM_CHUNK1);
    expect(query.getText(pt, byteOffset(0), byteOffset(3))).toBe("﻿");
    expect(collectLines(s.reconcileNow().lineIndex.root)[0]!.charLength).toBe(6);
  });

  it("keeps it once chunk 0 loads before it, and after chunk 0 is evicted", () => {
    const s = makeStore(2);
    s.dispatch(DocumentActions.loadChunk(1, enc(BOM_CHUNK1)));
    load(s, 0);
    expect(text(s)).toBe(CHUNK0 + BOM_CHUNK1);
    s.dispatch(DocumentActions.evictChunk(0));
    expect(text(s)).toBe(BOM_CHUNK1);
  });

  it("still strips a byte order mark that starts chunk 0", () => {
    const s = makeStore(2);
    s.dispatch(DocumentActions.loadChunk(0, enc("﻿AAAA\n")));
    load(s, 1);
    const pt = s.getSnapshot().pieceTable;
    expect(getValue(pt)).toBe("AAAA\n" + CHUNK1);
    expect(query.getText(pt, byteOffset(0), byteOffset(pt.totalLength))).toBe(getValue(pt));
  });

  it("strips one that starts chunk 1 once loaded chunk 0's bytes are all deleted", () => {
    // Nothing unloaded comes before chunk 1, so it starts the file, as it
    // does in an unchunked document with the same bytes.
    const s = makeStore(2);
    load(s, 0);
    s.dispatch(DocumentActions.loadChunk(1, enc(BOM_CHUNK1)));
    s.dispatch(DocumentActions.delete(byteOffset(0), byteOffset(CHUNK0.length)));
    const pt = s.getSnapshot().pieceTable;
    expect(getValue(pt)).toBe("BBBB\n");
    expect(query.getText(pt, byteOffset(0), byteOffset(pt.totalLength))).toBe("BBBB\n");

    const plain = createDocumentStore({ content: CHUNK0 + BOM_CHUNK1 });
    plain.dispatch(DocumentActions.delete(byteOffset(0), byteOffset(CHUNK0.length)));
    expect(getValue(plain.getSnapshot().pieceTable)).toBe(getValue(pt));
  });

  it("keeps one typed at resident offset 0 while chunk 0 is not loaded", () => {
    // The text goes with chunk 1, so chunk 0 loads before it.
    const s = makeStore(2);
    load(s, 1);
    s.dispatch(DocumentActions.insert(byteOffset(0), "﻿x"));
    expect(text(s)).toBe("﻿x" + CHUNK1);
    load(s, 0);
    expect(text(s)).toBe(CHUNK0 + "﻿x" + CHUNK1);
  });

  it("strips one typed at the start of the file", () => {
    const s = makeStore(2);
    load(s, 0);
    s.dispatch(DocumentActions.insert(byteOffset(0), "﻿x"));
    expect(text(s)).toBe("x" + CHUNK0);
  });

  it("reads attention text as the line index counts it", () => {
    const s = createDocumentStore({ content: "﻿abc\n", reconcileMode: "none" });
    s.dispatch(DocumentActions.createAttention(byteOffset(0), byteOffset(5)));
    const snap = s.getSnapshot();
    const [id] = [...snap.attention.attentions.keys()];
    expect(getTextForAttention(snap.pieceTable, snap.attention, id!)).toBe("﻿ab");
  });

  it("exposes getContentText on the query API, matching line char offsets", () => {
    const s = createDocumentStore({ content: "﻿ab\ncd", reconcileMode: "none" });
    const state = s.reconcileNow();
    const lineEnd = byteOffset(6);
    expect(query.getText(state.pieceTable, byteOffset(0), lineEnd)).toBe("ab\n");
    const content = query.getContentText(state.pieceTable, byteOffset(0), lineEnd);
    expect(content).toBe("﻿ab\n");
    expect(query.getCharStartOffset(state, 1)).toBe(content.length);
    expect(() => query.getContentText(state.pieceTable, byteOffset(1), lineEnd)).toThrow(
      RangeError,
    );
  });

  it("predicts the safe splits a splice leaves, matching the splice once applied", () => {
    const rng = makeDeterministicRng(19);
    const pick = <T>(items: readonly T[]) => items[Math.floor(rng() * items.length)]!;
    const bytePool = [0x41, 0x0a, 0x80, 0xbf, 0xc3, 0xe2, 0xef, 0xf0, 0x9f, 0xbb];
    const textPool = ["", "a", "é", "€", "😀", "﻿", "a😀", "😀a", "\uD83D", "\uDE00", "x\uDE00"];
    for (let round = 0; round < 2000; round++) {
      const bytes = Uint8Array.from({ length: 1 + Math.floor(rng() * 7) }, () => pick(bytePool));
      const s = createDocumentStore({
        chunkSize: bytes.length,
        totalFileSize: bytes.length,
        reconcileMode: "none",
      });
      s.dispatch(DocumentActions.loadChunk(0, bytes));
      const pt = s.getSnapshot().pieceTable;
      const start = Math.floor(rng() * (bytes.length + 1));
      const end = start + Math.floor(rng() * (bytes.length - start + 1));
      const insert = pick(textPool);
      const deleted = pieceTableDelete(pt, byteOffset(start), byteOffset(end));
      const after = pieceTableInsert(deleted, byteOffset(start), insert).state;
      const insertedLength = after.totalLength - deleted.totalLength;
      const expected = isSafeSplit(after, start) && isSafeSplit(after, start + insertedLength);
      expect(
        isSafeSplice(pt, start, end, insert),
        JSON.stringify({ bytes: [...bytes], start, end, insert }),
      ).toBe(expected);
    }
  });

  it("with keepHistory evicts only candidates that cost no history, whatever the policy", () => {
    for (const policy of ["pin-bounded", "drop"] as const) {
      const s = makeStore(3, policy);
      for (const i of [0, 1, 2]) load(s, i);
      s.dispatch(DocumentActions.insert(byteOffset(2), "X"));
      s.dispatch(DocumentActions.undo());
      s.dispatch(DocumentActions.evictChunks([0, 1, 2], 0, true));
      expect([...s.getSnapshot().pieceTable.chunkMap.keys()]).toEqual([0]);
      expect(getRedoCount(s.getSnapshot())).toBe(1);
    }
  });

  it("validates keepHistory and round-trips it", () => {
    const action = DocumentActions.evictChunks([1, 0], 1, true);
    expect(validateAction(action).valid).toBe(true);
    expect(deserializeAction(serializeAction(action))).toEqual(action);
    expect(DocumentActions.evictChunks([0], 1)).not.toHaveProperty("keepHistory");
    const bad = { type: "EVICT_CHUNKS", chunkIndices: [0], maxLoaded: 1, keepHistory: "yes" };
    expect(validateAction(bad).valid).toBe(false);
  });
});

describe("twentieth review regressions", () => {
  /** An entry holding one change, with cursors that resolve anywhere. */
  const entryOf = (change: HistoryChange): HistoryEntry =>
    Object.freeze({
      changes: Object.freeze([change]),
      selectionBefore: anchoredCursor(-1, 0),
      selectionAfter: anchoredCursor(-1, 0),
      timestamp: 0,
    });
  /** A 3-byte document whose top entry on `stack` points past its end. */
  const withStaleTop = (stack: "undoStack" | "redoStack") => {
    const state = createInitialState({ content: "abc" });
    const good = entryOf(makeInsertChange(byteOffset(0), "X"));
    // Undo deletes [10, 11) and redo deletes [10, 12): both past the end.
    const stale = entryOf(
      stack === "undoStack"
        ? makeInsertChange(byteOffset(10), "Y")
        : makeDeleteChange(byteOffset(10), "YY"),
    );
    const other = stack === "undoStack" ? "redoStack" : "undoStack";
    return Object.freeze({
      ...state,
      history: Object.freeze({
        ...state.history,
        [stack]: pstackPush(pstackPush(null, good), stale),
        [other]: pstackPush(null, good),
      }),
    });
  };

  it.each([
    ["UNDO", "undoStack", "redoStack"],
    ["REDO", "redoStack", "undoStack"],
  ] as const)(
    "%s drops an entry that resolves outside the document and every entry behind it",
    (type, stack, other) => {
      const state = withStaleTop(stack);
      const action = type === "UNDO" ? DocumentActions.undo() : DocumentActions.redo();
      const next = documentReducer(state, action);
      expect(next.pieceTable).toBe(state.pieceTable);
      expect(next.selection).toBe(state.selection);
      expect(next.history[stack]).toBeNull();
      expect(next.history[other]).toBe(state.history[other]);
      // The next press is a no-op rather than another failure.
      expect(documentReducer(next, action)).toBe(next);
    },
  );

  it("reports the dropped entries as history-drop, not history-change", () => {
    let state = withStaleTop("undoStack");
    const base = createDocumentStore();
    const store = withEvents(
      Object.assign(Object.create(base), { getSnapshot: () => state }),
      (action: DocumentAction) => {
        const transition = reduceDocument(state, action);
        state = transition.state;
        return transition;
      },
      undefined,
    );
    const seen: string[] = [];
    store.addEventListener("history-change", () => seen.push("change"));
    store.addEventListener("history-drop", () => seen.push("drop"));
    store.dispatch(DocumentActions.undo());
    expect(seen).toEqual(["drop"]);
  });

  it.each([
    ["UNDO", "undoStack"],
    ["REDO", "redoStack"],
  ] as const)(
    "reports a dropped %s as history-drop when the step runs on a copy",
    (type, stack) => {
      // The step runs on a copy of the snapshot, not on the object the event
      // layer compares against, so the outcome must come from the states alone.
      let state = withStaleTop(stack);
      const base = createDocumentStore();
      const store = withEvents(
        Object.assign(Object.create(base), { getSnapshot: () => state }),
        (action: DocumentAction) => {
          const transition = reduceDocument(Object.freeze({ ...state }), action);
          state = transition.state;
          return transition;
        },
        undefined,
      );
      const seen: string[] = [];
      store.addEventListener("history-change", () => seen.push("change"));
      store.addEventListener("history-drop", () => seen.push("drop"));
      store.dispatch(type === "UNDO" ? DocumentActions.undo() : DocumentActions.redo());
      expect(seen).toEqual(["drop"]);
    },
  );

  it.each([
    ["UNDO", "undoStack"],
    ["REDO", "redoStack"],
  ] as const)(
    "reports a dropped %s as history-drop when a listener dispatches during it",
    (type, stack) => {
      let state = withStaleTop(stack);
      const base = createDocumentStore();
      const store = withEvents(
        Object.assign(Object.create(base), { getSnapshot: () => state }),
        // A store listener moves the caret while the store notifies it, so
        // the snapshot is later than the state the step returned.
        (action: DocumentAction) => {
          const committed = reduceDocument(state, action);
          state = documentReducer(
            committed.state,
            DocumentActions.setSelection([{ anchor: byteOffset(1), head: byteOffset(1) }]),
          );
          return committed;
        },
        undefined,
      );
      const seen: string[] = [];
      store.addEventListener("history-change", () => seen.push("change"));
      store.addEventListener("history-drop", () => seen.push("drop"));
      store.dispatch(type === "UNDO" ? DocumentActions.undo() : DocumentActions.redo());
      expect(seen).toEqual(["drop"]);
    },
  );

  it("drops a remote-insert caret's key once text under another key lands after it", () => {
    const s = makeStore(4);
    load(s, 0);
    load(s, 3);
    // Offset 8 sits between chunk 0 (key -1) and chunk 3 (key 2), so keys -1
    // to 2 all fit there. Two carets store keys on different sides of chunk 2.
    s.dispatch(
      DocumentActions.setSelection([
        { anchor: byteOffset(8), head: byteOffset(8), anchorAfterChunk: 1, headAfterChunk: 1 },
        { anchor: byteOffset(8), head: byteOffset(8), anchorAfterChunk: 2, headAfterChunk: 2 },
      ]),
    );
    expect(s.getSnapshot().selection.ranges).toEqual([
      { anchor: 8, head: 8, anchorAfterChunk: 1, headAfterChunk: 1 },
      { anchor: 8, head: 8, anchorAfterChunk: 2, headAfterChunk: 2 },
    ]);
    // The text takes the primary caret's key 1, and both carets stay before
    // it. Key 2 no longer fits in front of text with key 1.
    s.dispatch(DocumentActions.applyRemote([{ type: "insert", start: byteOffset(8), text: "R" }]));
    const { pieceTable, selection } = s.getSnapshot();
    expect(collectPieces(pieceTable.root).map(pieceKey)).toEqual([-1, 1, 2]);
    expect(selection.ranges).toEqual([
      { anchor: 8, head: 8, anchorAfterChunk: 1, headAfterChunk: 1 },
      { anchor: 8, head: 8 },
    ]);
    for (const range of selection.ranges) {
      for (const [offset, key] of [
        [range.anchor, range.anchorAfterChunk],
        [range.head, range.headAfterChunk],
      ] as const) {
        if (key !== undefined) expect(keyFitsAt(pieceTable, offset, key)).toBe(true);
      }
    }
  });
});

describe("twenty-first review regressions", () => {
  /** An entry holding one change, with cursors that resolve anywhere. */
  const entryOf = (change: HistoryChange): HistoryEntry =>
    Object.freeze({
      changes: Object.freeze([change]),
      selectionBefore: anchoredCursor(-1, 0),
      selectionAfter: anchoredCursor(-1, 0),
      timestamp: 0,
    });
  /** Chunks 0 and 1 loaded: chunk 0 bytes have key -1, chunk 1 bytes key 0. */
  const twoChunks = () => {
    const s = makeStore(2, "pin-bounded");
    load(s, 0);
    load(s, 1);
    return s.getSnapshot();
  };

  it("checks a key against the document left once the replaced bytes are removed", () => {
    const { pieceTable } = twoChunks();
    // Key 0 belongs after chunk 0, so it fits at offset 4 only once the rest
    // of chunk 0 after it is removed.
    expect(keyFitsAt(pieceTable, 4, 0)).toBe(false);
    expect(keyFitsAfterRemoving(pieceTable, 4, 8, 0)).toBe(true);
    expect(keyFitsAfterRemoving(pieceTable, 4, 7, 0)).toBe(false);
    // Key -1 belongs before chunk 1, so offset 12 never fits it.
    expect(keyFitsAfterRemoving(pieceTable, 12, 16, -1)).toBe(false);
    expect(keyFitsAfterRemoving(pieceTable, 12, 17, -1)).toBe(false);
    for (let offset = 0; offset <= 16; offset++) {
      for (const key of [-1, 0, 1]) {
        expect(keyFitsAfterRemoving(pieceTable, offset, offset, key)).toBe(
          keyFitsAt(pieceTable, offset, key),
        );
      }
    }
  });

  it.each([
    ["UNDO", "undoStack", "redoStack"],
    ["REDO", "redoStack", "undoStack"],
  ] as const)(
    "%s drops an entry whose placement key no longer fits, moving the revision",
    (type, stack, other) => {
      const state = twoChunks();
      // Offset 12 is inside chunk 1, where key -1 does not fit. Undo of a
      // delete and redo of an insert both insert there.
      const stale = entryOf(
        stack === "undoStack" ? makeDeleteChange(12, "Y", -1) : makeInsertChange(12, "Y", -1),
      );
      const withStale: DocumentState = Object.freeze({
        ...state,
        history: Object.freeze({ ...state.history, [stack]: pstackPush(null, stale) }),
      });
      const action = type === "UNDO" ? DocumentActions.undo() : DocumentActions.redo();
      const next = documentReducer(withStale, action);
      expect(next.pieceTable).toBe(withStale.pieceTable);
      expect(next.history[stack]).toBeNull();
      expect(next.history[other]).toBe(withStale.history[other]);
      expect(next.revision).toBe(withStale.revision + 1);
    },
  );

  it.each([
    ["UNDO", "undoStack", "redoStack"],
    ["REDO", "redoStack", "undoStack"],
  ] as const)(
    "%s drops a delete whose placement key no longer fits instead of removing other bytes",
    (type, stack, other) => {
      const state = twoChunks();
      // [12, 13) is inside chunk 1, whose bytes have key 0, so it is in range
      // but key -1 does not fit there. Undo of an insert and redo of a delete
      // both remove those bytes.
      const stale = entryOf(
        stack === "undoStack" ? makeInsertChange(12, "Y", -1) : makeDeleteChange(12, "Y", -1),
      );
      const withStale: DocumentState = Object.freeze({
        ...state,
        history: Object.freeze({ ...state.history, [stack]: pstackPush(null, stale) }),
      });
      const action = type === "UNDO" ? DocumentActions.undo() : DocumentActions.redo();
      const next = documentReducer(withStale, action);
      expect(next.pieceTable).toBe(withStale.pieceTable);
      expect(next.history[stack]).toBeNull();
      expect(next.history[other]).toBe(withStale.history[other]);
      expect(next.revision).toBe(withStale.revision + 1);
    },
  );

  it("reports undo and redo of an entry that changes no bytes as history-change", () => {
    const s = createDocumentStoreWithEvents({ content: "hello world", reconcileMode: "none" });
    s.dispatch(DocumentActions.replace(byteOffset(5), byteOffset(5), ""));
    expect(getUndoCount(s.getSnapshot())).toBe(1);
    const seen: string[] = [];
    s.addEventListener("history-change", ({ direction }) => seen.push(direction));
    s.addEventListener("history-drop", () => seen.push("drop"));
    const before = s.getSnapshot().revision;
    s.dispatch(DocumentActions.undo());
    s.dispatch(DocumentActions.redo());
    expect(seen).toEqual(["undo", "redo"]);
    expect(s.getSnapshot().revision).toBe(before + 2);
    expect(getUndoCount(s.getSnapshot())).toBe(1);
  });

  it("reports a replayed entry that leaves the piece table untouched as history-change", () => {
    const initial = createInitialState({ content: "abc" });
    // Replaying an entry with no changes keeps the same piece table object.
    const empty: HistoryEntry = Object.freeze({
      ...entryOf(makeInsertChange(0, "X")),
      changes: [],
    });
    let state: DocumentState = Object.freeze({
      ...initial,
      history: Object.freeze({ ...initial.history, undoStack: pstackPush(null, empty) }),
    });
    const base = createDocumentStore();
    const store = withEvents(
      Object.assign(Object.create(base), { getSnapshot: () => state }),
      (action: DocumentAction) => {
        const transition = reduceDocument(state, action);
        state = transition.state;
        return transition;
      },
      undefined,
    );
    const seen: string[] = [];
    store.addEventListener("history-change", ({ direction }) => seen.push(direction));
    store.addEventListener("history-drop", () => seen.push("drop"));
    store.dispatch(DocumentActions.undo());
    store.dispatch(DocumentActions.redo());
    expect(seen).toEqual(["undo", "redo"]);
    expect(state.revision).toBe(initial.revision + 2);
  });

  it("treats history without an eviction policy as 'pin-bounded'", () => {
    const s = makeStore(2, "pin-bounded");
    load(s, 0);
    load(s, 1);
    s.dispatch(DocumentActions.insert(byteOffset(10), "X"));
    s.dispatch(DocumentActions.undo());
    // History built by hand, with no evictionPolicy field.
    const { evictionPolicy: _, ...history } = s.getSnapshot().history;
    const state: DocumentState = Object.freeze({
      ...s.getSnapshot(),
      history: Object.freeze(history) as HistoryState,
    });
    // The redo entry points inside chunk 1, so a plain eviction is refused.
    expect(documentReducer(state, DocumentActions.evictChunk(1))).toBe(state);
    expect(historyForEviction(state.pieceTable, state.history, 1, 8)).toBeNull();
    // Over the limit, it evicts and drops the entry as "pin-bounded" does.
    const over = documentReducer(state, DocumentActions.evictChunk(1, true));
    expect(over.pieceTable.chunkMap.has(1)).toBe(false);
    expect(getRedoCount(over)).toBe(0);
  });

  it("moves a cursor on a 4-byte run at the document's end to the nearer lead byte", () => {
    const SIZE = 400;
    const tail = Uint8Array.of(0x82, 0xac, 0x80, 0x80);
    const s = createDocumentStore({
      chunkSize: SIZE,
      totalFileSize: SIZE * 2 + tail.length,
      reconcileMode: "none",
    });
    const chunk0 = new Uint8Array(SIZE).fill(0x41);
    chunk0[SIZE - 1] = 0xe2;
    s.dispatch(DocumentActions.loadChunk(0, chunk0));
    s.dispatch(DocumentActions.loadChunk(1, new Uint8Array(SIZE).fill(0x42)));
    s.dispatch(DocumentActions.loadChunk(2, tail));
    s.dispatch(DocumentActions.setSelection([{ anchor: byteOffset(500), head: byteOffset(500) }]));
    s.dispatch(DocumentActions.evictChunk(1));
    // Clamped to offset 400, inside the run 82 AC 80 80 that ends the
    // document. The lead byte E2 at 399 is 1 byte back, the end 4 ahead.
    expect(cursor(s)).toEqual({ anchor: SIZE - 1, head: SIZE - 1 });
  });
});

describe("twenty-fourth review regressions", () => {
  /** A 6-byte document with two carets, the second primary. */
  const twoCarets = (): DocumentState => {
    const state = createInitialState({ content: "abcdef" });
    return Object.freeze({
      ...state,
      selection: Object.freeze({
        ranges: Object.freeze([
          Object.freeze({ anchor: byteOffset(1), head: byteOffset(1) }),
          Object.freeze({ anchor: byteOffset(4), head: byteOffset(4) }),
        ]),
        primaryIndex: 1,
      }),
    }) as DocumentState;
  };

  it("SET_SELECTION with the current ranges keeps the primary range and changes nothing", () => {
    const state = twoCarets();
    const next = documentReducer(state, DocumentActions.setSelection(state.selection.ranges));
    expect(next).toBe(state);
    expect(next.selection.primaryIndex).toBe(1);
  });

  it("SET_SELECTION with other ranges makes the first range primary", () => {
    const state = twoCarets();
    const next = documentReducer(
      state,
      DocumentActions.setSelection([
        { anchor: byteOffset(2), head: byteOffset(2) },
        { anchor: byteOffset(4), head: byteOffset(4) },
      ]),
    );
    expect(next.selection.primaryIndex).toBe(0);
    expect(next.selectionRevision).toBe(state.selectionRevision + 1);
  });

  it("an edit selection with the current ranges keeps the primary range", () => {
    const state = twoCarets();
    const next = documentReducer(
      state,
      DocumentActions.insert(byteOffset(0), "X", state.selection.ranges),
    );
    expect(next.selection.primaryIndex).toBe(1);
    expect(pstackPeek(next.history.undoStack)!.selectionBefore.primaryIndex).toBe(1);
  });
});

describe("twenty-sixth review regressions", () => {
  it("describes the eviction in history-drop, not a listener's dispatch during it", () => {
    const s = createDocumentStoreWithEvents({
      chunkSize: CHUNK_SIZE,
      totalFileSize: CHUNK_SIZE * 2,
      reconcileMode: "none",
      historyEvictionPolicy: "drop",
    });
    s.dispatch(DocumentActions.loadChunk(0, enc(CHUNK0)));
    s.dispatch(DocumentActions.loadChunk(1, enc(CHUNK1)));
    s.dispatch(DocumentActions.insert(byteOffset(2), "X"));
    s.dispatch(DocumentActions.undo());
    // A store listener types once chunk 0 is gone, while the eviction
    // notifies it, so dispatch returns the state after that edit.
    let typed = false;
    s.subscribe(() => {
      if (typed || s.getSnapshot().pieceTable.chunkMap.has(0)) return;
      typed = true;
      s.dispatch(DocumentActions.insert(byteOffset(0), "L"));
    });
    const drops: DocumentState[][] = [];
    s.addEventListener("history-drop", ({ prevState, nextState }) =>
      drops.push([prevState, nextState]),
    );

    const returned = s.dispatch(DocumentActions.evictChunk(0));
    expect(typed).toBe(true);
    expect(getUndoCount(returned)).toBe(1);
    expect(drops).toHaveLength(1);
    const [prevState, nextState] = drops[0]!;
    expect(getRedoCount(prevState!)).toBe(1);
    expect(getRedoCount(nextState!)).toBe(0);
    // The event's state is the eviction's, without the listener's edit.
    expect(getUndoCount(nextState!)).toBe(0);
    expect(nextState!.pieceTable.totalLength).toBe(CHUNK1.length);
  });
});

describe("twenty-ninth review regressions", () => {
  const streamed = (s: Store, start = 0, chunkSize = 2) =>
    [...getValueStream(s.getSnapshot().pieceTable, { start, chunkSize })]
      .map((chunk) => chunk.content)
      .join("");

  it("streams a U+FEFF that starts the resident text while chunk 0 is not loaded", () => {
    const s = makeStore(2);
    s.dispatch(DocumentActions.loadChunk(1, enc("﻿BBBB\n")));
    expect(streamed(s)).toBe("﻿BBBB\n");
    expect(streamed(s)).toBe(text(s));
  });

  it("streams a U+FEFF at the start of a range past offset 0, as getText reads it", () => {
    const s = createDocumentStore({ content: "ab﻿cd", reconcileMode: "none" });
    const pt = s.getSnapshot().pieceTable;
    expect(streamed(s, 2)).toBe("﻿cd");
    expect(streamed(s, 2)).toBe(query.getText(pt, byteOffset(2), byteOffset(pt.totalLength)));
  });

  it("still strips a byte order mark that starts the file from a stream at offset 0", () => {
    const s = createDocumentStore({ content: "﻿abc", reconcileMode: "none" });
    expect(streamed(s)).toBe("abc");
    expect(streamed(s)).toBe(text(s));
  });

  it("keeps a U+FEFF after a gap in the loaded chunks that does not shrink the map", () => {
    // Chunks 0 and 2 are loaded and chunk 0's bytes deleted, so chunk 2 is
    // resident offset 0 with key 1. Two chunks are loaded, but chunk 1 is not.
    const s = makeStore(3);
    load(s, 0);
    s.dispatch(DocumentActions.loadChunk(2, enc("﻿CCCC\n")));
    s.dispatch(DocumentActions.delete(byteOffset(0), byteOffset(CHUNK0.length)));
    const pt = s.getSnapshot().pieceTable;
    expect(pt.chunkMap.size).toBe(2);
    expect(residentStartIsFileStart(pt)).toBe(false);
    expect(text(s)).toBe("﻿CCCC\n");
    expect(streamed(s)).toBe(text(s));

    load(s, 1);
    s.dispatch(DocumentActions.delete(byteOffset(0), byteOffset(CHUNK1.length)));
    expect(residentStartIsFileStart(s.getSnapshot().pieceTable)).toBe(true);
    expect(text(s)).toBe("CCCC\n");
  });
});
