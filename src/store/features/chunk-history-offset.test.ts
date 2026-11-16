/**
 * Regression: history and placement must stay valid when chunks are loaded or
 * evicted around edited text.
 *
 * LOAD_CHUNKS / EVICT_CHUNK shift the resident offset of everything after the
 * chunk. History stores anchored positions (see `HistoryAnchor`) and add pieces
 * carry a placement key, so undo/redo and re-loading land on the right bytes.
 */

import { describe, it, expect } from "vitest";
import { createDocumentStore, createDocumentStoreWithEvents } from "./store.js";
import { DocumentActions } from "./actions.js";
import { documentReducer } from "./reducer.js";
import { createCheckpoint, restoreCheckpoint } from "./checkpoint.js";
import { createInitialState } from "../core/state.js";
import { byteOffset } from "../../types/branded.js";
import { getValue } from "../core/piece-table.js";
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

  it("does not emit selection-change when the selection stays put", () => {
    const s = makeEventStore("pin");
    let fired = 0;
    s.addEventListener("selection-change", () => fired++);
    // The cursor sits at 0, before chunk 0, so loading does not move it.
    s.dispatch(DocumentActions.loadChunk(0, enc(CHUNK0)));
    expect(fired).toBe(0);
  });

  it("emits history-change with direction 'drop' when eviction discards entries", () => {
    const s = makeEventStore("drop");
    s.dispatch(DocumentActions.loadChunk(0, enc(CHUNK0)));
    s.dispatch(DocumentActions.loadChunk(1, enc(CHUNK1)));
    s.dispatch(DocumentActions.insert(byteOffset(2), "X"));
    s.dispatch(DocumentActions.undo());
    const directions: string[] = [];
    s.addEventListener("history-change", ({ direction, nextState }) => {
      directions.push(direction);
      expect(getRedoCount(nextState)).toBe(0);
    });

    s.dispatch(DocumentActions.evictChunk(0));
    expect(directions).toEqual(["drop"]);
  });

  it("does not emit history-change when eviction keeps every entry", () => {
    const s = makeEventStore("drop");
    s.dispatch(DocumentActions.loadChunk(0, enc(CHUNK0)));
    s.dispatch(DocumentActions.loadChunk(1, enc(CHUNK1)));
    s.dispatch(DocumentActions.insert(byteOffset(10), "X"));
    let fired = 0;
    s.addEventListener("history-change", () => fired++);
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
});
