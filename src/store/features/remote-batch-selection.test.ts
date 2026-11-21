/**
 * APPLY_REMOTE carries the local selection across a batch with
 * `RemoteBatchSelection`. It must move the selection, and choose insertion
 * keys, exactly as moving the selection past each change in turn does.
 */

import { describe, expect, it, vi } from "vitest";
import { createDocumentStore } from "./store.js";
import { DocumentActions } from "./actions.js";
import { documentReducer } from "./reducer.js";
import { applyUntrackedEdit } from "./edit.js";
import { insertionKey, moveSelectionPastEdit } from "./history-anchor.js";
import { withState } from "../core/state.js";
import { getText, getValue } from "../core/piece-table.js";
import { byteLength, byteOffset } from "../../types/branded.js";
import type { RemoteChange } from "../../types/actions.js";
import type { DocumentState, SelectionRange } from "../../types/state.js";
import { makeDeterministicRng, randomInt } from "../../../test-utils/large-content.js";

const CHUNK_SIZE = 8;
const CHUNKS = ["AAAAAAA\n", "BBBBBBB\n", "CCCCCCC\n", "DDDDDDD\n", "EEEEEEE\n"];
const enc = (s: string) => new TextEncoder().encode(s);

/** The selection APPLY_REMOTE gave before `RemoteBatchSelection`: one move per change. */
function referenceRemote(state: DocumentState, changes: readonly RemoteChange[]): DocumentState {
  let next = state;
  const revision = state.revision + 1;
  const moveSelection = (start: number, end: number, inserted: number) => {
    const selection = moveSelectionPastEdit(
      next.pieceTable,
      next.selection,
      start,
      end,
      inserted,
      true,
    );
    if (selection !== next.selection) next = withState(next, { selection });
  };
  for (const change of changes) {
    if (change.type === "insert") {
      const position = change.start;
      const key = insertionKey(next.pieceTable, next.selection, position);
      const before = next.pieceTable.totalLength;
      next = applyUntrackedEdit(
        next,
        {
          kind: "insert",
          position,
          insertText: change.text,
          placement: { kind: "fitted", key },
        },
        revision,
      );
      moveSelection(position, position, next.pieceTable.totalLength - before);
    } else {
      const start = change.start;
      const end = byteOffset(start + change.length);
      const deletedText = getText(next.pieceTable, start, end);
      next = applyUntrackedEdit(
        next,
        { kind: "delete", position: start, deleteEnd: end, deletedText },
        revision,
      );
      moveSelection(start, end, 0);
    }
  }
  return next;
}

/** A chunked document with some chunks not loaded, so stored keys matter. */
function chunkedState(rng: () => number): DocumentState {
  const store = createDocumentStore({
    chunkSize: CHUNK_SIZE,
    totalFileSize: CHUNK_SIZE * CHUNKS.length,
    reconcileMode: "none",
  });
  for (let i = 0; i < CHUNKS.length; i++) {
    if (rng() < 0.6) store.dispatch(DocumentActions.loadChunk(i, enc(CHUNKS[i]!)));
  }
  return store.getSnapshot();
}

function randomSelection(
  rng: () => number,
  state: DocumentState,
  count: number,
): [SelectionRange, ...SelectionRange[]] {
  const total = state.pieceTable.totalLength;
  const offset = () => byteOffset(randomInt(rng, 0, total));
  const key = () => (rng() < 0.6 ? randomInt(rng, 0, CHUNKS.length) : undefined);
  const ranges: SelectionRange[] = [];
  for (let i = 0; i < count; i++) {
    const anchor = offset();
    const head = rng() < 0.5 ? anchor : offset();
    const anchorKey = key();
    ranges.push({
      anchor,
      head,
      ...(anchorKey !== undefined && { anchorAfterChunk: anchorKey }),
      ...(head === anchor
        ? anchorKey !== undefined && { headAfterChunk: anchorKey }
        : rng() < 0.6 && { headAfterChunk: randomInt(rng, 0, CHUNKS.length) }),
    });
  }
  return ranges as [SelectionRange, ...SelectionRange[]];
}

function randomChanges(
  rng: () => number,
  state: DocumentState,
  carets: readonly number[],
): RemoteChange[] {
  let total = state.pieceTable.totalLength;
  const changes: RemoteChange[] = [];
  const count = randomInt(rng, 1, 12);
  for (let i = 0; i < count; i++) {
    if (total > 0 && rng() < 0.35) {
      const start = randomInt(rng, 0, total - 1);
      const length = randomInt(rng, 1, Math.min(6, total - start));
      changes.push({ type: "delete", start: byteOffset(start), length: byteLength(length) });
      total -= length;
    } else {
      // Often at a caret, where its stored key decides the placement.
      const at =
        carets.length > 0 && rng() < 0.5
          ? Math.min(carets[randomInt(rng, 0, carets.length - 1)]!, total)
          : randomInt(rng, 0, total);
      const text = "xyz".slice(0, randomInt(rng, 1, 3));
      changes.push({ type: "insert", start: byteOffset(at), text });
      total += text.length;
    }
  }
  return changes;
}

describe("RemoteBatchSelection", () => {
  it("moves the selection and places text as moving it past each change does", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const rng = makeDeterministicRng(seed);
      let state = chunkedState(rng);
      const ranges = randomSelection(rng, state, randomInt(rng, 1, 6));
      state = documentReducer(state, DocumentActions.setSelection(ranges));
      const carets = state.selection.ranges.flatMap((r) => [r.anchor, r.head]);
      const changes = randomChanges(rng, state, carets);

      const actual = documentReducer(state, DocumentActions.applyRemote(changes));
      const expected = referenceRemote(state, changes);
      const where = `seed ${seed}`;
      expect(actual.selection.ranges, where).toEqual(expected.selection.ranges);
      expect(actual.selection.primaryIndex, where).toBe(expected.selection.primaryIndex);
      expect(getValue(actual.pieceTable), where).toBe(getValue(expected.pieceTable));
      // Placement shows once the evicted chunks load around the inserted text.
      let loadedActual = actual;
      let loadedExpected = expected;
      for (let i = 0; i < CHUNKS.length; i++) {
        const load = DocumentActions.loadChunk(i, enc(CHUNKS[i]!));
        loadedActual = documentReducer(loadedActual, load);
        loadedExpected = documentReducer(loadedExpected, load);
      }
      expect(getValue(loadedActual.pieceTable), where).toBe(getValue(loadedExpected.pieceTable));
    }
  });

  it("keeps the selection object when the batch leaves every range in place", () => {
    const store = createDocumentStore({ content: "0123456789", reconcileMode: "none" });
    store.dispatch(
      DocumentActions.setSelection([
        { anchor: byteOffset(1), head: byteOffset(2) },
        { anchor: byteOffset(3), head: byteOffset(3) },
      ]),
    );
    const before = store.getSnapshot().selection;
    store.dispatch(
      DocumentActions.applyRemote([
        { type: "insert", start: byteOffset(8), text: "ab" },
        { type: "delete", start: byteOffset(5), length: byteLength(2) },
      ]),
    );
    expect(store.getSnapshot().selection).toBe(before);
  });

  it("builds each moved range once per batch, not once per change", () => {
    // Every change lands before every caret, so each one shifts them all.
    const changeCount = 2_000;
    const changes: RemoteChange[] = Array.from({ length: changeCount }, (_, i) => ({
      type: "insert" as const,
      start: byteOffset(i * 3),
      text: "a",
    }));
    // Objects frozen while reducing the batch with `rangeCount` carets. Each
    // range a move builds is frozen, beside the document's own objects.
    const frozenWith = (rangeCount: number) => {
      const store = createDocumentStore({ content: "x".repeat(20_000), reconcileMode: "none" });
      const ranges = Array.from({ length: rangeCount }, (_, i) => ({
        anchor: byteOffset(19_000 - i),
        head: byteOffset(19_000 - i),
      }));
      store.dispatch(DocumentActions.setSelection(ranges as [SelectionRange, ...SelectionRange[]]));
      const state = store.getSnapshot();
      const freeze = vi.spyOn(Object, "freeze");
      try {
        const next = documentReducer(state, DocumentActions.applyRemote(changes));
        expect(next.selection.ranges[0]!.anchor).toBe(19_000 + changeCount);
        return freeze.mock.calls.length;
      } finally {
        freeze.mockRestore();
      }
    };
    const rangeCount = 500;
    // One move per change would freeze every range on every change. The
    // baseline has two ranges: a single range moves past each change in turn
    // (see `remoteSelectionTracker`), so it freezes once per change.
    expect(frozenWith(rangeCount) - frozenWith(2)).toBeLessThan(4 * rangeCount);
  });

  it("moves a single range past each change in turn", () => {
    // 2,000 changes before one caret: each moves it, and none is batched.
    const changes: RemoteChange[] = Array.from({ length: 2_000 }, (_, i) => ({
      type: "insert" as const,
      start: byteOffset(i * 3),
      text: "a",
    }));
    const store = createDocumentStore({ content: "x".repeat(20_000), reconcileMode: "none" });
    store.dispatch(
      DocumentActions.setSelection([{ anchor: byteOffset(19_000), head: byteOffset(19_000) }]),
    );
    const state = store.getSnapshot();
    const actual = documentReducer(state, DocumentActions.applyRemote(changes));
    const expected = referenceRemote(state, changes);
    expect(actual.selection).toEqual(expected.selection);
    expect(actual.selection.ranges[0]!.anchor).toBe(21_000);
  });
});
