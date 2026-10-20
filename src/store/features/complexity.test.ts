/**
 * Deterministic checks for logarithmic tree height.
 *
 * Assert the red-black height bound that supports documented O(log n)
 * operations. Timing ceilings in perf.test.ts can miss structural regressions
 * when they still finish within the allowed time.
 *
 * Run these checks in the functional suite to detect invalid tree shapes
 * without depending on machine speed.
 */

import { describe, expect, it } from "vitest";
import { byteOffset } from "../../types/branded.js";
import { createDocumentStore } from "./store.js";
import { DocumentActions } from "./actions.js";
import { createEmptyPieceTableState } from "../core/state.js";
import { pieceTableDelete, pieceTableInsert } from "../core/piece-table.js";
import { rebuildLineIndex } from "../core/line-index.js";
import type { LineIndexNode, PieceNode } from "../../types/state.js";
import { measurePieceTree, redBlackHeightBound } from "../../../test-utils/invariants.js";

function rngFor(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

function measureLineTree(node: LineIndexNode | null): { count: number; height: number } {
  if (node === null) return { count: 0, height: 0 };
  const left = measureLineTree(node.left);
  const right = measureLineTree(node.right);
  return {
    count: 1 + left.count + right.count,
    height: 1 + Math.max(left.height, right.height),
  };
}

/** Build a fragmented piece tree, then delete single bytes at random. */
function fragment(
  seed: number,
  inserts: number,
  deletes: number,
): { root: PieceNode | null; totalLength: number } {
  const rng = rngFor(seed);
  let state = createEmptyPieceTableState();
  let length = 0;

  for (let i = 0; i < inserts; i++) {
    const position = Math.floor(rng() * (length + 1));
    state = pieceTableInsert(state, byteOffset(position), "xy").state;
    length += 2;
  }
  for (let i = 0; i < deletes && length > 1; i++) {
    const start = Math.floor(rng() * (length - 1));
    state = pieceTableDelete(state, byteOffset(start), byteOffset(start + 1));
    length -= 1;
  }

  return { root: state.root, totalLength: state.totalLength };
}

// The 16k-insert cases take ~1s locally under coverage, but a shared CI runner
// with coverage on and every worker busy can push them past vitest's 5s
// default. These tests assert height, not speed, so wall-clock must not fail them.
describe("piece tree height", { timeout: 30_000 }, () => {
  it.each([
    [1_000, 500],
    [4_000, 2_000],
    [16_000, 8_000],
  ])("stays within the red-black bound after %i inserts and %i deletes", (inserts, deletes) => {
    const { root } = fragment(0xc0f_fee, inserts, deletes);
    const { count, height } = measurePieceTree(root);
    const bound = redBlackHeightBound(count);

    expect(height, `${count} pieces at height ${height}, bound ${bound}`).toBeLessThanOrEqual(
      bound,
    );
  });

  it("grows logarithmically, not linearly, with piece count", () => {
    // A 16x increase in work must not cost more than a handful of extra levels.
    // A linear structure would add thousands of levels. Even a tree that lost its
    // balance guarantee roughly doubles in height.
    const small = measurePieceTree(fragment(0x5eed, 1_000, 500).root);
    const large = measurePieceTree(fragment(0x5eed, 16_000, 8_000).root);

    const growth = large.height - small.height;
    const ideal = redBlackHeightBound(large.count) - redBlackHeightBound(small.count);

    expect(
      growth,
      `height grew by ${growth} (${small.count}→${large.count} pieces); ` +
        `the bound allows ${ideal}`,
    ).toBeLessThanOrEqual(ideal);
  });

  it("keeps edits through the public store within the bound", () => {
    const store = createDocumentStore({ content: "reed\ncomplexity\ngate", reconcileMode: "none" });
    const rng = rngFor(0xa11ce);

    for (let step = 0; step < 4_000; step++) {
      const length = store.getSnapshot().pieceTable.totalLength;
      if (rng() < 0.55 || length < 4) {
        store.dispatch(DocumentActions.insert(byteOffset(Math.floor(rng() * (length + 1))), "ab"));
      } else {
        const start = Math.floor(rng() * (length - 2));
        store.dispatch(DocumentActions.delete(byteOffset(start), byteOffset(start + 2)));
      }
    }

    const { count, height } = measurePieceTree(store.getSnapshot().pieceTable.root);
    expect(height, `${count} pieces at height ${height}`).toBeLessThanOrEqual(
      redBlackHeightBound(count),
    );
    store.dispose();
  });
});

describe("line index height", () => {
  it.each([1_000, 10_000, 100_000])("stays within the bound for a %i-line document", (lines) => {
    const content = Array.from({ length: lines }, (_, i) => `line ${i}`).join("\n");
    const index = rebuildLineIndex(content);
    const { count, height } = measureLineTree(index.root);

    expect(height, `${count} lines at height ${height}`).toBeLessThanOrEqual(
      redBlackHeightBound(count),
    );
  });

  it("stays within the bound after deleting many lines", () => {
    const store = createDocumentStore({
      content: Array.from({ length: 5_000 }, (_, i) => `line ${i}`).join("\n"),
    });
    const rng = rngFor(0xdece7e);

    for (let step = 0; step < 500; step++) {
      const snapshot = store.reconcileNow();
      const length = snapshot.pieceTable.totalLength;
      if (length < 40) break;
      const start = Math.floor(rng() * (length - 20));
      store.dispatch(DocumentActions.delete(byteOffset(start), byteOffset(start + 20)));
    }

    const index = store.reconcileNow().lineIndex;
    const { count, height } = measureLineTree(index.root);
    expect(height, `${count} lines at height ${height}`).toBeLessThanOrEqual(
      redBlackHeightBound(count),
    );
    store.dispose();
  });
});
