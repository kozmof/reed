/**
 * Red-black contract of the persistent piece tree.
 *
 * `docs/invariants.md` §1.2 states that the standard red-black invariants hold
 * "after every structural operation". The piece table has fix-up paths for
 * insertion (`fixInsertWithPath`) and for right-spine grafts
 * (`fixRedViolations`), but none for deletion: neither `extractMin` nor the
 * `splitAt` / `joinByBlackHeight` pair can represent the black deficit that
 * removing a black node creates.
 *
 * These tests pin that contract directly. They are expected to fail until the
 * deletion path is repaired. Text and aggregates stay correct throughout — that
 * is why the rest of the suite passes over a malformed tree — so every case here
 * asserts the tree shape in addition to the string model.
 *
 * The three delete paths fail independently and are tested separately:
 *
 *   - interior delete      → `mergeTrees` calls `extractMin`
 *   - prefix delete (s=0)  → `left === null`, `mergeTrees` returns early
 *   - suffix delete (e=len)→ `right === null`, `mergeTrees` returns early
 *
 * Prefix and suffix deletes never reach `extractMin`, so a fix confined to it
 * leaves those two cases red.
 */

import { describe, expect, it } from "vitest";
import { getValue, pieceTableDelete, pieceTableInsert } from "./piece-table.js";
import { createEmptyPieceTableState } from "./state.js";
import { byteOffset } from "../../types/branded.js";
import type { PieceTableState } from "../../types/state.js";
import {
  assertPieceTableInvariants,
  measurePieceTree,
  redBlackHeightBound,
} from "../../../test-utils/invariants.js";

type Op =
  | { readonly kind: "insert"; readonly position: number; readonly text: string }
  | { readonly kind: "delete"; readonly start: number; readonly end: number };

const insert = (position: number, text: string): Op => ({ kind: "insert", position, text });
const remove = (start: number, end: number): Op => ({ kind: "delete", start, end });

/** Apply an operation to both the piece table and a plain-string model. */
function step(
  state: PieceTableState,
  model: string,
  op: Op,
): { state: PieceTableState; model: string } {
  if (op.kind === "insert") {
    return {
      state: pieceTableInsert(state, byteOffset(op.position), op.text).state,
      model: model.slice(0, op.position) + op.text + model.slice(op.position),
    };
  }
  return {
    state: pieceTableDelete(state, byteOffset(op.start), byteOffset(op.end)),
    model: model.slice(0, op.start) + model.slice(op.end),
  };
}

function describeOp(op: Op): string {
  return op.kind === "insert"
    ? `insert(${op.position}, ${JSON.stringify(op.text)})`
    : `delete(${op.start}, ${op.end})`;
}

/**
 * Run a sequence, asserting the model and the full red-black contract after
 * every operation. Failures name the operation index and the operation itself,
 * so a red test points at the exact edit that broke the tree.
 */
function runSequence(ops: readonly Op[], context: string): PieceTableState {
  let state = createEmptyPieceTableState();
  let model = "";

  ops.forEach((op, index) => {
    ({ state, model } = step(state, model, op));
    const where = `${context}: after op ${index} ${describeOp(op)}`;
    expect(getValue(state), `${where}: text`).toBe(model);
    assertPieceTableInvariants(state, where, true);
  });

  return state;
}

// Deterministic LCG, matching the generator used by the model-based suite.
function rngFor(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

function int(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

describe("piece table red-black contract", () => {
  // Each sequence below is the shortest one found by breadth-first search over
  // insert/delete programs that drives the tree out of the red-black invariant.
  describe("minimal reproducers", () => {
    it("keeps the red property through a prefix delete", () => {
      // Never reaches extractMin: mergeTrees returns `right` directly.
      runSequence([insert(0, "ab"), insert(1, "ab"), insert(2, "ab"), remove(0, 1)], "prefix/red");
    });

    it("keeps black height uniform through a prefix delete", () => {
      runSequence(
        [insert(0, "ab"), insert(1, "ab"), insert(2, "ab"), remove(0, 1), insert(4, "ab")],
        "prefix/black-height",
      );
    });

    it("keeps the red property through a suffix delete", () => {
      // Never reaches extractMin: mergeTrees returns `left` directly.
      runSequence(
        [insert(0, "ab"), insert(0, "ab"), insert(0, "ab"), insert(1, "ab"), remove(5, 8)],
        "suffix/red",
      );
    });

    it("keeps black height uniform through a suffix delete", () => {
      runSequence(
        [
          insert(0, "ab"),
          insert(0, "ab"),
          insert(0, "ab"),
          insert(1, "ab"),
          remove(5, 8),
          insert(0, "ab"),
        ],
        "suffix/black-height",
      );
    });

    it("keeps the red property through an interior delete", () => {
      // Reaches extractMin, because both sides of the split are non-empty.
      runSequence(
        [insert(0, "ab"), insert(0, "ab"), insert(1, "ab"), remove(4, 5)],
        "interior/red",
      );
    });

    it("keeps black height uniform through an interior delete", () => {
      runSequence(
        [insert(0, "ab"), insert(0, "ab"), insert(0, "ab"), insert(0, "ab"), remove(1, 3)],
        "interior/black-height",
      );
    });
  });

  describe("deletion shapes", () => {
    it("survives repeated middle deletes until the document is empty", () => {
      let state = createEmptyPieceTableState();
      let model = "";
      for (let i = 0; i < 24; i++) {
        ({ state, model } = step(state, model, insert(i, "xy")));
      }
      assertPieceTableInvariants(state, "middle-delete: built", true);

      let guard = 0;
      while (model.length > 0) {
        const middle = Math.floor(model.length / 2);
        ({ state, model } = step(state, model, remove(middle, Math.min(middle + 1, model.length))));
        const where = `middle-delete: ${model.length} bytes left`;
        expect(getValue(state), `${where}: text`).toBe(model);
        assertPieceTableInvariants(state, where, true);
        expect(guard++, "middle-delete: made progress").toBeLessThan(200);
      }
      expect(state.root, "middle-delete: empty tree").toBeNull();
    });

    it("survives a range delete that spans several pieces", () => {
      let state = createEmptyPieceTableState();
      let model = "";
      // Build a fragmented tree of single-byte pieces in scattered order.
      for (const position of [0, 0, 1, 3, 2, 5, 4, 7, 6, 9, 8, 2, 4, 6]) {
        ({ state, model } = step(state, model, insert(Math.min(position, model.length), "z")));
      }
      assertPieceTableInvariants(state, "range-delete: built", true);

      // A span crossing many pieces exercises both splits and the merge.
      ({ state, model } = step(state, model, remove(3, 11)));
      expect(getValue(state), "range-delete: text").toBe(model);
      assertPieceTableInvariants(state, "range-delete: after", true);
    });

    it("survives deleting every single byte from the front", () => {
      const rng = rngFor(0xf20f7);
      let state = createEmptyPieceTableState();
      let model = "";
      for (let i = 0; i < 40; i++) {
        ({ state, model } = step(state, model, insert(int(rng, 0, model.length), "q")));
      }
      while (model.length > 0) {
        ({ state, model } = step(state, model, remove(0, 1)));
        const where = `front-delete: ${model.length} bytes left`;
        expect(getValue(state), `${where}: text`).toBe(model);
        assertPieceTableInvariants(state, where, true);
      }
    });
  });

  describe("height bound", () => {
    // The property users actually depend on. Colour rules are the mechanism;
    // bounded height is the O(log n) guarantee the public API documents.
    it("keeps height within 2*log2(n+1) under insert/delete fragmentation", () => {
      const rng = rngFor(0x5eed);
      let state = createEmptyPieceTableState();
      let model = "";

      for (let i = 0; i < 6000; i++) {
        const position = int(rng, 0, model.length);
        ({ state, model } = step(state, model, insert(position, "xy")));
      }
      const built = measurePieceTree(state.root);
      expect(built.height, "built tree is balanced").toBeLessThanOrEqual(
        redBlackHeightBound(built.count),
      );

      for (let i = 0; i < 3000; i++) {
        const start = int(rng, 0, Math.max(0, model.length - 2));
        ({ state, model } = step(state, model, remove(start, start + 1)));
      }

      expect(getValue(state), "fragmentation: text").toBe(model);
      const after = measurePieceTree(state.root);
      expect(
        after.height,
        `fragmentation: ${after.count} pieces at height ${after.height}, ` +
          `bound ${redBlackHeightBound(after.count)}`,
      ).toBeLessThanOrEqual(redBlackHeightBound(after.count));
    });
  });

  describe("randomized mixed edits", () => {
    it.each([1, 7, 19, 41, 83])("holds the contract across seed %i", (seed) => {
      const rng = rngFor(seed);
      let state = createEmptyPieceTableState();
      let model = "";

      for (let index = 0; index < 250; index++) {
        const op: Op =
          rng() < 0.55 || model.length < 2
            ? insert(int(rng, 0, model.length), "abcd".slice(0, int(rng, 1, 4)))
            : (() => {
                const start = int(rng, 0, model.length - 1);
                return remove(start, int(rng, start + 1, Math.min(start + 4, model.length)));
              })();

        ({ state, model } = step(state, model, op));
        const where = `seed=${seed} step=${index} ${describeOp(op)}`;
        expect(getValue(state), `${where}: text`).toBe(model);
        assertPieceTableInvariants(state, where, true);
      }
    });
  });
});
