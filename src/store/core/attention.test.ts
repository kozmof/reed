/**
 * Tests for the Attention Layer.
 */

import { describe, it, expect } from "vitest";
import { byteOffset, pieceID, attentionID } from "../../types/branded.js";
import { createPieceTableState, createEmptyPieceTableState } from "./state.js";
import { pieceTableInsert, pieceTableDelete } from "./piece-table.js";
import {
  emptyAttentionLayerState,
  createPoint,
  resolvePoint,
  createAttention,
  deleteAttention,
  getAttention,
  resolveAttention,
  getTextForAttention,
  findAttentionsAt,
  findAttentionsOverlapping,
  migrateSplits,
  insertWithAttention,
  deleteWithAttention,
} from "./attention.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function insert(state: ReturnType<typeof createPieceTableState>, offset: number, text: string) {
  return pieceTableInsert(state, byteOffset(offset), text);
}

function del(state: ReturnType<typeof createPieceTableState>, start: number, end: number) {
  return pieceTableDelete(state, byteOffset(start), byteOffset(end));
}

// ---------------------------------------------------------------------------
// createPoint / resolvePoint
// ---------------------------------------------------------------------------

describe("createPoint", () => {
  it("returns null for empty tree", () => {
    const state = createEmptyPieceTableState();
    expect(createPoint(state.root, byteOffset(0))).toBeNull();
  });

  it("creates a point at offset 0", () => {
    const state = createPieceTableState("Hello");
    const pt = createPoint(state.root, byteOffset(0));
    expect(pt).not.toBeNull();
    expect(pt!.boundary).toBe(0);
  });

  it("creates a point in the middle of a piece", () => {
    const state = createPieceTableState("Hello");
    const pt = createPoint(state.root, byteOffset(2));
    expect(pt).not.toBeNull();
    expect(pt!.boundary).toBe(2);
  });

  it("creates a point at the end of the document", () => {
    const state = createPieceTableState("Hello");
    const pt = createPoint(state.root, byteOffset(5));
    expect(pt).not.toBeNull();
    expect(pt!.boundary).toBe(5);
  });

  it("clamps offset beyond document end to end", () => {
    const state = createPieceTableState("Hello");
    const ptEnd = createPoint(state.root, byteOffset(5));
    const ptOver = createPoint(state.root, byteOffset(100));
    expect(ptOver).not.toBeNull();
    expect(ptOver!.pieceID).toBe(ptEnd!.pieceID);
    expect(ptOver!.boundary).toBe(ptEnd!.boundary);
  });
});

describe("resolvePoint", () => {
  it("returns null for empty tree", () => {
    const state = createEmptyPieceTableState();
    expect(resolvePoint(state.root, { pieceID: pieceID("p0"), boundary: 0 })).toBeNull();
  });

  it("returns null for unknown pieceID (dangling)", () => {
    const state = createPieceTableState("Hello");
    expect(resolvePoint(state.root, { pieceID: pieceID("unknown-piece"), boundary: 0 })).toBeNull();
  });

  it("round-trips offset through createPoint → resolvePoint", () => {
    const state = createPieceTableState("Hello, World!");
    for (let i = 0; i <= 13; i++) {
      const pt = createPoint(state.root, byteOffset(i));
      expect(pt).not.toBeNull();
      const resolved = resolvePoint(state.root, pt!);
      expect(resolved).toBe(i);
    }
  });

  it("resolves correctly after an insert that does not touch the piece", () => {
    // Create state with two pieces: insert "World" into "Hello "
    const s0 = createPieceTableState("Hello ");
    const { state: s1 } = insert(s0, 6, "World");
    // Point anchored to the original "Hello " piece at boundary 3 ("lo ")
    const ptHello = createPoint(s0.root, byteOffset(3));
    expect(ptHello).not.toBeNull();
    // After insert, the piece still starts at 0; boundary 3 → offset 3
    const resolved = resolvePoint(s1.root, ptHello!);
    expect(resolved).toBe(3);
  });

  it("gap at split boundary stays at the split point after an insert there", () => {
    // Insert at the exact gap where ptB is anchored: the gap goes to the LEFT half,
    // so it resolves to offset 1 (before the inserted text), not offset 3 (before B).
    const s0 = createPieceTableState("AB");
    const ptB = createPoint(s0.root, byteOffset(1));
    expect(ptB).not.toBeNull();
    const { state: s1 } = insert(s0, 1, "XY"); // "AXYB"
    // ptB = (p0, boundary=1). After splitting at 1, boundary=1 ≤ splitOffset=1 → left piece "A".
    // "A" piece starts at docOffset=0, boundary=1 → resolved = 1 (before "XY", after "A").
    const resolved = resolvePoint(s1.root, ptB!);
    expect(resolved).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// createAttention / getAttention / deleteAttention
// ---------------------------------------------------------------------------

describe("createAttention / getAttention / deleteAttention", () => {
  it("creates an attention and retrieves it", () => {
    const state = createPieceTableState("Hello");
    const pt0 = createPoint(state.root, byteOffset(0))!;
    const pt5 = createPoint(state.root, byteOffset(5))!;

    const [layer, id] = createAttention(emptyAttentionLayerState, pt0, pt5);
    const attention = getAttention(layer, id);
    expect(attention).not.toBeNull();
    expect(attention!.id).toBe(id);
    expect(attention!.start).toEqual(pt0);
    expect(attention!.end).toEqual(pt5);
  });

  it("getAttention returns null for unknown ID", () => {
    expect(getAttention(emptyAttentionLayerState, attentionID("nonexistent"))).toBeNull();
  });

  it("deleteAttention removes an attention", () => {
    const state = createPieceTableState("Hello");
    const pt0 = createPoint(state.root, byteOffset(0))!;
    const pt5 = createPoint(state.root, byteOffset(5))!;

    const [layer, id] = createAttention(emptyAttentionLayerState, pt0, pt5);
    const layer2 = deleteAttention(layer, id);
    expect(getAttention(layer2, id)).toBeNull();
  });

  it("deleteAttention is a no-op for unknown ID", () => {
    const result = deleteAttention(emptyAttentionLayerState, attentionID("unknown"));
    expect(result).toBe(emptyAttentionLayerState);
  });
});

// ---------------------------------------------------------------------------
// resolveAttention
// ---------------------------------------------------------------------------

describe("resolveAttention", () => {
  it("returns null for unknown attention ID", () => {
    const state = createPieceTableState("Hello");
    expect(resolveAttention(state.root, emptyAttentionLayerState, attentionID("no"))).toBeNull();
  });

  it("resolves to correct offsets", () => {
    const state = createPieceTableState("Hello, World!");
    const pt2 = createPoint(state.root, byteOffset(2))!;
    const pt7 = createPoint(state.root, byteOffset(7))!;
    const [layer, id] = createAttention(emptyAttentionLayerState, pt2, pt7);

    const resolved = resolveAttention(state.root, layer, id);
    expect(resolved).not.toBeNull();
    expect(resolved!.startOffset).toBe(2);
    expect(resolved!.endOffset).toBe(7);
  });

  it("resolves to same offsets after insert elsewhere", () => {
    const s0 = createPieceTableState("ABCDE");
    const pt1 = createPoint(s0.root, byteOffset(1))!;
    const pt3 = createPoint(s0.root, byteOffset(3))!;
    const [layer0, id] = createAttention(emptyAttentionLayerState, pt1, pt3);

    // Insert at end — does not affect pieces B..D
    const { state: s1 } = insert(s0, 5, "XY");

    const resolved = resolveAttention(s1.root, layer0, id);
    expect(resolved!.startOffset).toBe(1);
    expect(resolved!.endOffset).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// getTextForAttention
// ---------------------------------------------------------------------------

describe("getTextForAttention", () => {
  it("returns null for unknown ID", () => {
    const state = createPieceTableState("Hello");
    expect(getTextForAttention(state, emptyAttentionLayerState, attentionID("no"))).toBeNull();
  });

  it("extracts text for the covered range", () => {
    const state = createPieceTableState("Hello, World!");
    const pt2 = createPoint(state.root, byteOffset(2))!;
    const pt7 = createPoint(state.root, byteOffset(7))!;
    const [layer, id] = createAttention(emptyAttentionLayerState, pt2, pt7);

    expect(getTextForAttention(state, layer, id)).toBe("llo, ");
  });

  it("returns empty string when start === end", () => {
    const state = createPieceTableState("Hello");
    const pt = createPoint(state.root, byteOffset(2))!;
    const [layer, id] = createAttention(emptyAttentionLayerState, pt, pt);
    expect(getTextForAttention(state, layer, id)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// findAttentionsAt / findAttentionsOverlapping
// ---------------------------------------------------------------------------

describe("findAttentionsAt", () => {
  it("returns empty for no attentions", () => {
    const state = createPieceTableState("Hello");
    expect(findAttentionsAt(emptyAttentionLayerState, state.root, 2)).toEqual([]);
  });

  it("finds attentions containing the offset", () => {
    const state = createPieceTableState("Hello, World!");
    const pt0 = createPoint(state.root, byteOffset(0))!;
    const pt5 = createPoint(state.root, byteOffset(5))!;
    const [l0, id] = createAttention(emptyAttentionLayerState, pt0, pt5);

    expect(findAttentionsAt(l0, state.root, 2)).toContain(id);
    expect(findAttentionsAt(l0, state.root, 0)).toContain(id);
    // End boundary is exclusive
    expect(findAttentionsAt(l0, state.root, 5)).not.toContain(id);
  });

  it("ignores attentions outside the offset", () => {
    const state = createPieceTableState("Hello, World!");
    const pt7 = createPoint(state.root, byteOffset(7))!;
    const pt12 = createPoint(state.root, byteOffset(12))!;
    const [l0, id] = createAttention(emptyAttentionLayerState, pt7, pt12);
    expect(findAttentionsAt(l0, state.root, 2)).not.toContain(id);
  });
});

describe("findAttentionsOverlapping", () => {
  it("returns attentions that overlap a range", () => {
    const state = createPieceTableState("Hello, World!");
    const pt2 = createPoint(state.root, byteOffset(2))!;
    const pt8 = createPoint(state.root, byteOffset(8))!;
    const [l0, id] = createAttention(emptyAttentionLayerState, pt2, pt8);

    // Query range [5, 10) overlaps [2, 8)
    expect(findAttentionsOverlapping(l0, state.root, 5, 10)).toContain(id);
    // Query range [0, 3) overlaps [2, 8)
    expect(findAttentionsOverlapping(l0, state.root, 0, 3)).toContain(id);
    // Query range [8, 13) does NOT overlap [2, 8) (end exclusive)
    expect(findAttentionsOverlapping(l0, state.root, 8, 13)).not.toContain(id);
    // Query range [0, 2) does NOT overlap [2, 8)
    expect(findAttentionsOverlapping(l0, state.root, 0, 2)).not.toContain(id);
  });
});

// ---------------------------------------------------------------------------
// migrateSplits — split survival
// ---------------------------------------------------------------------------

describe("migrateSplits", () => {
  it("is a no-op when splits is empty", () => {
    const state = createPieceTableState("Hello");
    const pt = createPoint(state.root, byteOffset(2))!;
    const [layer] = createAttention(emptyAttentionLayerState, pt, pt);
    expect(migrateSplits(layer, [])).toBe(layer);
  });

  it("AttentionPoint on left half of split resolves correctly without migration", () => {
    // Insert in the middle of the only piece, triggering a split.
    const s0 = createPieceTableState("ABCDE");
    const ptB = createPoint(s0.root, byteOffset(1))!; // boundary=1, points to "B"
    const ptC = createPoint(s0.root, byteOffset(3))!; // boundary=3, points after "C"
    const [l0, id] = createAttention(emptyAttentionLayerState, ptB, ptC);

    // Insert "XY" at offset 4 — splits the piece at boundary 4 inside it
    const { state: s1, splits } = insert(s0, 4, "XY");
    const l1 = migrateSplits(l0, splits);

    // ptB and ptC both fell in the left half (boundary 1 and 3 ≤ 4)
    const resolved = resolveAttention(s1.root, l1, id);
    expect(resolved).not.toBeNull();
    expect(resolved!.startOffset).toBe(1); // "B" still at 1
    expect(resolved!.endOffset).toBe(3); // after "C" still at 3
  });

  it("AttentionPoint on right half is migrated to new piece", () => {
    const s0 = createPieceTableState("ABCDE");
    // byteOffset(3) → gap before "D" (boundary=3), in right half when split at 2
    const ptD = createPoint(s0.root, byteOffset(3))!;
    // byteOffset(4) → gap before "E" (boundary=4), in right half when split at 2
    const ptE = createPoint(s0.root, byteOffset(4))!;
    const [l0, id] = createAttention(emptyAttentionLayerState, ptD, ptE);

    // Insert "XY" at offset 2 — splits the piece at boundary 2 → "AB"(p0), "CDE"(p1)
    const { state: s1, splits } = insert(s0, 2, "XY");
    // s1 = "ABXYCDE" — "CDE" starts at docOffset 4
    const l1 = migrateSplits(l0, splits);

    const resolved = resolveAttention(s1.root, l1, id);
    expect(resolved).not.toBeNull();
    // ptD: (p0,3) → (p1,3-2=1) → "CDE" at 4, boundary=1 → offset 5 (before D)
    expect(resolved!.startOffset).toBe(5);
    // ptE: (p0,4) → (p1,4-2=2) → "CDE" at 4, boundary=2 → offset 6 (before E)
    expect(resolved!.endOffset).toBe(6);
  });

  it("AttentionPoint straddling split boundary: start left, end right", () => {
    const s0 = createPieceTableState("ABCDE");
    const ptA = createPoint(s0.root, byteOffset(1))!; // boundary=1, left half (≤ splitOffset=3)
    const ptD = createPoint(s0.root, byteOffset(4))!; // boundary=4, right half (> splitOffset=3)
    const [l0, id] = createAttention(emptyAttentionLayerState, ptA, ptD);

    // Insert "XY" at offset 3 → split: "ABC"(p0), "DE"(p1). s1 = "ABCXYDE".
    const { state: s1, splits } = insert(s0, 3, "XY");
    const l1 = migrateSplits(l0, splits);

    const resolved = resolveAttention(s1.root, l1, id);
    expect(resolved).not.toBeNull();
    // ptA: (p0,1) → stays left → "ABC" at 0, boundary=1 → offset 1
    expect(resolved!.startOffset).toBe(1);
    // ptD: (p0,4) → (p1,4-3=1) → "DE" at 5, boundary=1 → offset 6 (before E)
    expect(resolved!.endOffset).toBe(6);
  });

  it("references survive a delete that does not touch the piece", () => {
    const s0 = createPieceTableState("Hello, World!");
    const pt2 = createPoint(s0.root, byteOffset(2))!;
    const pt5 = createPoint(s0.root, byteOffset(5))!;
    const [l0, id] = createAttention(emptyAttentionLayerState, pt2, pt5);

    // Delete chars after the attention range
    const s1 = del(s0, 7, 13); // remove "World!"

    const resolved = resolveAttention(s1.root, l0, id);
    expect(resolved).not.toBeNull();
    expect(resolved!.startOffset).toBe(2);
    expect(resolved!.endOffset).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Multi-piece coverage (spec example)
// ---------------------------------------------------------------------------

describe("multi-piece coverage", () => {
  it("an Attention spanning multiple pieces resolves to correct byte offsets", () => {
    const s0 = createPieceTableState("ABCDE");
    // Force multiple pieces: insert "12" at offset 1 → pieces: [A][12][BCDE]
    const { state: s1 } = insert(s0, 1, "12");
    // s1 document: "A12BCDE" (7 bytes)

    // Attention from offset 1 ("1") to offset 6 ("D" exclusive)
    const ptStart = createPoint(s1.root, byteOffset(1))!;
    const ptEnd = createPoint(s1.root, byteOffset(6))!;
    const [layer, id] = createAttention(emptyAttentionLayerState, ptStart, ptEnd);

    const text = getTextForAttention(s1, layer, id);
    expect(text).toBe("12BCD");

    const resolved = resolveAttention(s1.root, layer, id);
    expect(resolved!.startOffset).toBe(1);
    expect(resolved!.endOffset).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// insertWithAttention — atomic insert + migrate
// ---------------------------------------------------------------------------

describe("insertWithAttention", () => {
  it("migrates a right-half AttentionPoint without a manual migrateSplits call", () => {
    const s0 = createPieceTableState("ABCDE");
    const ptD = createPoint(s0.root, byteOffset(3))!; // right half when split at 2
    const ptE = createPoint(s0.root, byteOffset(4))!;
    const [l0, id] = createAttention(emptyAttentionLayerState, ptD, ptE);

    // Atomic helper performs the split-causing insert AND the migration.
    const { pieceTableState, attentionState, insertedByteLength } = insertWithAttention(
      s0,
      l0,
      byteOffset(2),
      "XY",
    );

    expect(insertedByteLength).toBe(2);
    // s1 = "ABXYCDE" — "CDE" starts at docOffset 4; D at 5, E at 6.
    const resolved = resolveAttention(pieceTableState.root, attentionState, id);
    expect(resolved).not.toBeNull();
    expect(resolved!.startOffset).toBe(5);
    expect(resolved!.endOffset).toBe(6);
  });

  it("matches the manual pieceTableInsert + migrateSplits sequence", () => {
    const s0 = createPieceTableState("ABCDE");
    const ptD = createPoint(s0.root, byteOffset(3))!;
    const ptE = createPoint(s0.root, byteOffset(4))!;
    const [l0, id] = createAttention(emptyAttentionLayerState, ptD, ptE);

    const { state: manualState, splits } = insert(s0, 2, "XY");
    const manualLayer = migrateSplits(l0, splits);
    const manual = resolveAttention(manualState.root, manualLayer, id);

    const atomic = insertWithAttention(s0, l0, byteOffset(2), "XY");
    const auto = resolveAttention(atomic.pieceTableState.root, atomic.attentionState, id);

    expect(auto).toEqual(manual);
  });

  it("leaves the attention layer untouched when the insert causes no split", () => {
    const s0 = createPieceTableState("Hello");
    const pt0 = createPoint(s0.root, byteOffset(0))!;
    const pt5 = createPoint(s0.root, byteOffset(5))!;
    const [l0] = createAttention(emptyAttentionLayerState, pt0, pt5);

    // Append at the document end — no piece is split.
    const { attentionState } = insertWithAttention(s0, l0, byteOffset(5), "!");
    expect(attentionState).toBe(l0);
  });
});

// ---------------------------------------------------------------------------
// Fail-closed resolution
// ---------------------------------------------------------------------------

describe("fail-closed resolution", () => {
  it("resolvePoint returns null when boundary exceeds the piece length", () => {
    const state = createPieceTableState("Hello");
    const pt = createPoint(state.root, byteOffset(2))!;
    // Forge a boundary past the piece end — must fail closed, not return a bogus offset.
    const overflow = { pieceID: pt.pieceID, boundary: 999 };
    expect(resolvePoint(state.root, overflow)).toBeNull();
  });

  it("a raw delete that cuts the anchored piece dangles (null), never a corrupt offset", () => {
    // "ABCDE" as a single piece; anchor inside it, then delete a span that cuts it.
    const s0 = createPieceTableState("ABCDE");
    const ptD = createPoint(s0.root, byteOffset(3))!; // boundary 3 within p0
    const ptE = createPoint(s0.root, byteOffset(4))!;
    const [l0, id] = createAttention(emptyAttentionLayerState, ptD, ptE);

    // Raw delete (no migration) — surviving fragments get fresh IDs.
    const s1 = del(s0, 1, 3); // remove "BC" → "ADE"
    const resolved = resolveAttention(s1.root, l0, id);
    // Without migration the points cannot survive a cut, but they must fail closed.
    expect(resolved).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deleteWithAttention — atomic delete + migrate
// ---------------------------------------------------------------------------

describe("deleteWithAttention", () => {
  it("shifts a trailing attention left by the deleted length", () => {
    const s0 = createPieceTableState("Hello, World!");
    const pt7 = createPoint(s0.root, byteOffset(7))!; // "W"
    const pt12 = createPoint(s0.root, byteOffset(12))!; // "!" exclusive
    const [l0, id] = createAttention(emptyAttentionLayerState, pt7, pt12);

    // Delete "llo, " (offsets 2..7), entirely before the attention.
    const { pieceTableState, attentionState, deletedByteLength } = deleteWithAttention(
      s0,
      l0,
      byteOffset(2),
      byteOffset(7),
    );
    expect(deletedByteLength).toBe(5);
    // "HeWorld!" — "World" now starts at 2, "!" at 7.
    const resolved = resolveAttention(pieceTableState.root, attentionState, id);
    expect(resolved).not.toBeNull();
    expect(resolved!.startOffset).toBe(2);
    expect(resolved!.endOffset).toBe(7);
    expect(getTextForAttention(pieceTableState, attentionState, id)).toBe("World");
  });

  it("survives a delete that cuts the anchored piece (right-side survivor)", () => {
    const s0 = createPieceTableState("ABCDE");
    const ptD = createPoint(s0.root, byteOffset(3))!; // before "D"
    const ptE = createPoint(s0.root, byteOffset(4))!; // before "E"
    const [l0, id] = createAttention(emptyAttentionLayerState, ptD, ptE);

    // Delete "BC" (1..3) — cuts the single piece; "DE" survives with a fresh ID.
    const { pieceTableState, attentionState } = deleteWithAttention(
      s0,
      l0,
      byteOffset(1),
      byteOffset(3),
    );
    // "ADE": D at 1, E at 2.
    const resolved = resolveAttention(pieceTableState.root, attentionState, id);
    expect(resolved).not.toBeNull();
    expect(resolved!.startOffset).toBe(1);
    expect(resolved!.endOffset).toBe(2);
    expect(getTextForAttention(pieceTableState, attentionState, id)).toBe("D");
  });

  it("collapses a point inside the deleted span to the deletion start", () => {
    const s0 = createPieceTableState("ABCDE");
    const ptB = createPoint(s0.root, byteOffset(1))!; // before "B", inside [1,4)
    const ptE = createPoint(s0.root, byteOffset(4))!; // before "E", at end of span
    const [l0, id] = createAttention(emptyAttentionLayerState, ptB, ptE);

    // Delete "BCD" (1..4) → "AE". Start (inside) collapses to 1; end (== span end) → 1.
    const { pieceTableState, attentionState } = deleteWithAttention(
      s0,
      l0,
      byteOffset(1),
      byteOffset(4),
    );
    const resolved = resolveAttention(pieceTableState.root, attentionState, id);
    expect(resolved).not.toBeNull();
    expect(resolved!.startOffset).toBe(1);
    expect(resolved!.endOffset).toBe(1);
    expect(getTextForAttention(pieceTableState, attentionState, id)).toBe("");
  });

  it("leaves the attention layer untouched when the delete is after every attention", () => {
    const s0 = createPieceTableState("Hello, World!");
    const pt2 = createPoint(s0.root, byteOffset(2))!;
    const pt5 = createPoint(s0.root, byteOffset(5))!;
    const [l0, id] = createAttention(emptyAttentionLayerState, pt2, pt5);

    const { pieceTableState, attentionState } = deleteWithAttention(
      s0,
      l0,
      byteOffset(7),
      byteOffset(13),
    );
    expect(attentionState).toBe(l0);
    const resolved = resolveAttention(pieceTableState.root, attentionState, id);
    expect(resolved!.startOffset).toBe(2);
    expect(resolved!.endOffset).toBe(5);
  });

  it("matches a plain delete for offsets when the delete misses every piece boundary", () => {
    const s0 = createPieceTableState("ABCDEFGH");
    const ptC = createPoint(s0.root, byteOffset(2))!;
    const ptF = createPoint(s0.root, byteOffset(5))!;
    const [l0, id] = createAttention(emptyAttentionLayerState, ptC, ptF);

    // Delete after the attention; attention offsets unchanged.
    const { pieceTableState, attentionState } = deleteWithAttention(
      s0,
      l0,
      byteOffset(6),
      byteOffset(8),
    );
    const resolved = resolveAttention(pieceTableState.root, attentionState, id);
    expect(resolved!.startOffset).toBe(2);
    expect(resolved!.endOffset).toBe(5);
  });
});
