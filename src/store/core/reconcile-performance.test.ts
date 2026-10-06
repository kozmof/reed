import { expect, it } from "vitest";
import type { LineIndexNode } from "../../types/state.js";
import { createLineIndexState, withLineIndexState } from "./state.js";
import { collectLines, reconcileFull } from "./line-index.js";

it("repairs many dirty ranges without repeatedly reading their bookkeeping", () => {
  const state = createLineIndexState("abc\n".repeat(4096));
  let reads = 0;
  const ranges = Array.from({ length: 512 }, (_, i) => ({
    get startLine() {
      reads++;
      return i * 8;
    },
    get endLine() {
      reads++;
      return i * 8;
    },
    offsetDelta: 0,
  }));
  const invalidate = (node: LineIndexNode | null, first: number): LineIndexNode | null => {
    if (!node) return null;
    const line = first + (node.left?.subtreeLineCount ?? 0);
    return {
      ...node,
      documentOffset: line < 4096 && line % 8 === 0 ? null : node.documentOffset,
      left: invalidate(node.left, first),
      right: invalidate(node.right, line + 1),
    };
  };
  const dirty = withLineIndexState(state, {
    root: invalidate(state.root, 0),
    dirtyRanges: ranges,
    maxDirtyRanges: 1024,
    rebuildPending: true,
  });
  reads = 0;
  const repaired = reconcileFull(dirty, 7);
  expect(reads).toBeLessThanOrEqual(ranges.length * 6);
  expect(collectLines(repaired.root).map((line) => line.documentOffset)).toEqual(
    collectLines(state.root).map((line) => line.documentOffset),
  );
  expect(repaired.dirtyRanges).toEqual([]);
  expect(repaired.rebuildPending).toBe(false);
  expect(repaired.lastReconciledRevision).toBe(7);
  expect(collectLines(dirty.root)[0]!.documentOffset).toBeNull();
});
