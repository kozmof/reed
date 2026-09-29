import { describe, expect, it } from "vitest";
import { byteOffset } from "../../types/branded.js";
import { createInitialState, createPieceTableState, withLineIndexState } from "./state.js";
import { reconcileFull } from "./reconcile.js";
import { collectLines } from "./line-index.js";
import { getValue, pieceTableInsert, pieceTableDelete, compactAddBuffer } from "./piece-table.js";
import { documentReducer } from "../features/reducer.js";
import { DocumentActions } from "../features/actions.js";
import {
  reconcileIncrementally,
  compactIncrementally,
  advanceMaintenance,
} from "./incremental-maintenance.js";
import { assertLineIndexRedBlackProperties } from "../../../test-utils/invariants.js";

function drain<T>(work: Generator<void, T>): { value: T; slices: number } {
  let slices = 0;
  while (true) {
    const result = advanceMaintenance(work, () => false);
    slices++;
    if (result.done) return { value: result.value, slices };
  }
}
describe("incremental maintenance", () => {
  it("repairs ordinary and collapsed dirty ranges over multiple slices", () => {
    let state = createInitialState({ content: "abc\r\n".repeat(3000) });
    state = documentReducer(state, DocumentActions.insert(byteOffset(1), "漢\n"));
    for (const lineIndex of [
      state.lineIndex,
      withLineIndexState(state.lineIndex, { dirtyRanges: "full-rebuild-needed" }),
    ]) {
      const expected = reconcileFull(lineIndex, state.revision);
      const actual = drain(reconcileIncrementally(lineIndex, state.revision));
      expect(actual.slices).toBeGreaterThan(1);
      const metrics = (index: typeof actual.value) =>
        collectLines(index.root).map((n) => [n.documentOffset, n.lineLength, n.charLength]);
      expect(metrics(actual.value)).toEqual(metrics(expected));
      expect(actual.value.rebuildPending).toBe(false);
      expect(actual.value.lastReconciledRevision).toBe(state.revision);
      expect(lineIndex.rebuildPending).toBe(true);
      assertLineIndexRedBlackProperties(actual.value.root);
    }
    const empty = createInitialState();
    expect(drain(reconcileIncrementally(empty.lineIndex, 0)).value.root).toBe(empty.lineIndex.root);
    const noRoot = withLineIndexState(empty.lineIndex, { root: null });
    expect(drain(reconcileIncrementally(noRoot, 0)).value.root).toBeNull();
  });
  it("copies large pieces in bounded chunks and preserves old buffers", () => {
    let table = createPieceTableState("original");
    table = pieceTableInsert(table, byteOffset(4), "x".repeat(400000)).state;
    table = pieceTableDelete(table, byteOffset(4), byteOffset(100004));
    const oldValue = getValue(table);
    const work = compactIncrementally(table);
    // Even with an immediate yield request, make progress one unit at a time.
    let result = advanceMaintenance(work, () => true);
    let slices = 1;
    while (!result.done) {
      result = advanceMaintenance(work, () => true);
      slices++;
    }
    expect(slices).toBeGreaterThan(5);
    expect(getValue(result.value)).toBe(oldValue);
    expect(getValue(table)).toBe(oldValue);
    expect(result.value.addBuffer.length).toBe(300000);
    expect(getValue(compactAddBuffer(table, 0))).toBe(getValue(result.value));
    const withoutAdds = createPieceTableState("abc");
    expect(getValue(drain(compactIncrementally(withoutAdds)).value)).toBe("abc");
  });
});
