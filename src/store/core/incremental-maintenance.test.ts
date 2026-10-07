import { describe, expect, it, vi } from "vitest";
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
  createCompactionWorkspace,
  type ReconciliationCache,
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

it("reuses completed reconciliation subtrees after edits near the end", () => {
  let state = createInitialState({ content: "abc\n".repeat(6000) });
  state = documentReducer(state, DocumentActions.insert(byteOffset(0), "x"));
  const cache: ReconciliationCache = new WeakMap();
  const work = reconcileIncrementally(state.lineIndex, state.revision, cache);
  for (let i = 0; i < 1800; i++) expect(work.next().done).toBe(false);
  state = documentReducer(
    state,
    DocumentActions.insert(byteOffset(state.pieceTable.totalLength), "tail"),
  );
  function steps(job: ReturnType<typeof reconcileIncrementally>): number {
    let count = 0;
    while (!job.next().done) count++;
    return count;
  }
  const cold = steps(reconcileIncrementally(state.lineIndex, state.revision));
  const resumed = steps(reconcileIncrementally(state.lineIndex, state.revision, cache));
  expect(resumed).toBeLessThan(cold - 1500);
  expect(
    collectLines(
      drain(reconcileIncrementally(state.lineIndex, state.revision, cache)).value.root,
    ).map((n) => n.documentOffset),
  ).toEqual(
    collectLines(reconcileFull(state.lineIndex, state.revision).root).map((n) => n.documentOffset),
  );
});

it("reuses partially copied spans when an edit splits a large piece", () => {
  let table = createPieceTableState("");
  table = pieceTableInsert(table, byteOffset(0), "x".repeat(200000)).state;
  table = pieceTableInsert(table, byteOffset(200000), "y").state; // spare capacity after growth
  table = pieceTableDelete(table, byteOffset(0), byteOffset(100000));
  const workspace = createCompactionWorkspace(table);
  const job = compactIncrementally(table, workspace);
  while (workspace.pages[0]?.[0] !== 120) expect(job.next().done).toBe(false);
  const original = table;
  table = pieceTableInsert(table, byteOffset(50000), "hello").state;
  const result = drain(compactIncrementally(table, workspace)).value;
  expect(getValue(result)).toBe(getValue(table));
  expect(getValue(original)).toBe("x".repeat(100000) + "y");
  expect(result.addBuffer.length).toBe(100006);
});

it("grows retained compaction storage in slices and never mutates a published result", () => {
  let table = createPieceTableState("");
  table = pieceTableInsert(table, byteOffset(0), "x".repeat(100_000)).state;
  const workspace = createCompactionWorkspace(table);
  const initialJob = compactIncrementally(table, workspace);
  while (workspace.pages[0]?.[0] !== 120) initialJob.next();
  table = pieceTableInsert(table, byteOffset(100_000), "y".repeat(300_000)).state;
  const first = drain(compactIncrementally(table, workspace)).value;
  const saved = new Uint8Array(first.addBuffer.bytes);
  expect(getValue(first)).toBe("x".repeat(100_000) + "y".repeat(300_000));
  const next = pieceTableInsert(first, byteOffset(0), "z").state;
  const second = drain(compactIncrementally(next, workspace)).value;
  expect(getValue(second)).toBe("z" + getValue(first));
  expect(new Uint8Array(first.addBuffer.bytes)).toEqual(saved);
});

it("bounds every compaction byte allocation, including reservation and publication", () => {
  const table = pieceTableInsert(
    createPieceTableState(""),
    byteOffset(0),
    "漢😀x".repeat(100000),
  ).state;
  const allocations: number[] = [];
  const NativeBytes = Uint8Array;
  vi.stubGlobal(
    "Uint8Array",
    new Proxy(NativeBytes, {
      construct(target, args) {
        if (typeof args[0] === "number") allocations.push(args[0]);
        return Reflect.construct(target, args);
      },
    }),
  );
  try {
    const workspace = createCompactionWorkspace(table);
    expect(allocations).toEqual([]);
    const result = drain(compactIncrementally(table, workspace)).value;
    expect(Math.max(...allocations)).toBeLessThanOrEqual(65536);
    vi.unstubAllGlobals();
    expect(getValue(result)).toBe(getValue(table));
  } finally {
    vi.unstubAllGlobals();
  }
});
