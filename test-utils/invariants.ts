import { expect } from "vitest";
import type {
  DocumentState,
  LineIndexNode,
  PieceNode,
  PieceTableState,
} from "../src/types/state.js";
import { byteOffset } from "../src/types/branded.js";
import { getText } from "../src/store/core/piece-table.js";
import {
  getCharStartOffset,
  getLineStartOffset,
  rebuildLineIndex,
} from "../src/store/core/line-index.js";

/**
 * The maximum height a red-black tree of `count` nodes may have.
 *
 * A red-black tree satisfies `h <= 2*log2(n + 1)`; because heights are integers
 * the floor of that expression is the tightest admissible bound. This is the
 * property callers actually depend on — `O(log n)` piece-table operations are
 * a consequence of bounded height, not of the colour rules themselves.
 */
export function redBlackHeightBound(count: number): number {
  return Math.floor(2 * Math.log2(count + 1));
}

/** Node count and height of a piece tree, for bound checks and diagnostics. */
export function measurePieceTree(node: PieceNode | null): { count: number; height: number } {
  if (node === null) return { count: 0, height: 0 };
  const left = measurePieceTree(node.left);
  const right = measurePieceTree(node.right);
  return {
    count: 1 + left.count + right.count,
    height: 1 + Math.max(left.height, right.height),
  };
}

/**
 * Assert persistent piece-tree ordering, aggregates, identity, and RB properties.
 *
 * `strictRedBlack` additionally checks root blackness, the absence of red-red
 * edges, uniform black height, and the height bound above. It defaults to
 * `false` only so that callers asserting a narrower contract stay unchanged;
 * any test driving live inserts and deletes should pass `true`.
 */
export function assertPieceTableInvariants(
  state: PieceTableState,
  context = "piece table",
  strictRedBlack = false,
): void {
  const ids = new Set<string>();
  // Shape is reported alongside every strict failure: a bare "black-height"
  // mismatch does not say how badly the tree has degraded, and the node count
  // and height are what identify the offending workload.
  const shape = strictRedBlack ? measurePieceTree(state.root) : null;
  const where = shape ? `${context} [pieces=${shape.count} height=${shape.height}]` : context;

  function visit(node: PieceNode | null): {
    blackHeight: number;
    length: number;
    addLength: number;
  } {
    if (node === null) return { blackHeight: 1, length: 0, addLength: 0 };
    expect(Object.isFrozen(node), `${where}: node ${node.id} is frozen`).toBe(true);
    expect(ids.has(node.id), `${where}: duplicate piece ID ${node.id}`).toBe(false);
    ids.add(node.id);
    if (strictRedBlack && node.color === "red") {
      expect(node.left?.color, `${where}: red-red edge below ${node.id} (left)`).not.toBe("red");
      expect(node.right?.color, `${where}: red-red edge below ${node.id} (right)`).not.toBe("red");
    }
    const left = visit(node.left);
    const right = visit(node.right);
    if (strictRedBlack) {
      expect(left.blackHeight, `${where}: black-height mismatch at ${node.id}`).toBe(
        right.blackHeight,
      );
    }
    const length = node.length + left.length + right.length;
    const addLength =
      (node.bufferType === "add" ? node.length : 0) + left.addLength + right.addLength;
    expect(node.subtreeLength, `${where}: subtreeLength`).toBe(length);
    expect(node.subtreeAddLength, `${where}: subtreeAddLength`).toBe(addLength);
    if (node.bufferType === "chunk") {
      expect(state.chunkMap.has(node.chunkIndex), `${where}: missing chunk buffer`).toBe(true);
    }
    return {
      blackHeight: left.blackHeight + (node.color === "black" ? 1 : 0),
      length,
      addLength,
    };
  }

  if (strictRedBlack && state.root !== null) {
    expect(state.root.color, `${where}: root colour`).toBe("black");
  }
  const totals = visit(state.root);
  expect(totals.length, `${where}: totalLength`).toBe(state.totalLength);

  if (shape !== null) {
    const bound = redBlackHeightBound(shape.count);
    expect(
      shape.height,
      `${where}: height exceeds the red-black bound 2*log2(n+1)=${bound}`,
    ).toBeLessThanOrEqual(bound);
  }
}

/** Assert line-tree aggregates and, for eager trees, exact document offsets. */
export function assertLineIndexInvariants(
  root: LineIndexNode | null,
  context = "line index",
): { lines: number; bytes: number; chars: number } {
  if (root === null) return { lines: 0, bytes: 0, chars: 0 };
  const left = assertLineIndexInvariants(root.left, context);
  const right = assertLineIndexInvariants(root.right, context);
  const totals = {
    lines: 1 + left.lines + right.lines,
    bytes: root.lineLength + left.bytes + right.bytes,
    chars: root.charLength + left.chars + right.chars,
  };
  expect(root.subtreeLineCount, `${context}: subtreeLineCount`).toBe(totals.lines);
  expect(root.subtreeByteLength, `${context}: subtreeByteLength`).toBe(totals.bytes);
  expect(root.subtreeCharLength, `${context}: subtreeCharLength`).toBe(totals.chars);
  return totals;
}

/** Assert the strict red-black properties of a line-index tree. */
export function assertLineIndexRedBlackProperties(
  root: LineIndexNode | null,
  context = "line index",
): void {
  if (root !== null) {
    expect(root.color, `${context}: root color`).toBe("black");
  }

  function visit(node: LineIndexNode | null): number {
    if (node === null) return 1;
    if (node.color === "red") {
      expect(node.left?.color, `${context}: red-left violation`).not.toBe("red");
      expect(node.right?.color, `${context}: red-right violation`).not.toBe("red");
    }

    const leftBlackHeight = visit(node.left);
    const rightBlackHeight = visit(node.right);
    expect(leftBlackHeight, `${context}: black-height`).toBe(rightBlackHeight);
    return leftBlackHeight + (node.color === "black" ? 1 : 0);
  }

  visit(root);
}

/**
 * Compare an eager document snapshot with a plain-string reference model.
 *
 * `strictRedBlack` propagates to the piece-tree assertion. Text and aggregates
 * can stay correct while the tree's colour and height invariants are broken, so
 * a model comparison alone does not establish that the document is well formed.
 */
export function assertDocumentMatchesModel(
  state: DocumentState<"eager">,
  expected: string,
  context = "document",
  strictRedBlack = false,
): void {
  expect(
    getText(state.pieceTable, byteOffset(0), byteOffset(state.pieceTable.totalLength)),
    `${context}: text`,
  ).toBe(expected);
  assertPieceTableInvariants(state.pieceTable, context, strictRedBlack);
  const totals = assertLineIndexInvariants(state.lineIndex.root, context);
  expect(totals.lines, `${context}: lineCount aggregate`).toBe(state.lineIndex.lineCount);
  const rebuilt = rebuildLineIndex(expected);
  expect(state.lineIndex.lineCount, `${context}: lineCount`).toBe(rebuilt.lineCount);
  for (let line = 0; line < rebuilt.lineCount; line++) {
    expect(getLineStartOffset(state.lineIndex.root, line), `${context}: byte line ${line}`).toBe(
      getLineStartOffset(rebuilt.root, line),
    );
    expect(getCharStartOffset(state.lineIndex.root, line), `${context}: char line ${line}`).toBe(
      getCharStartOffset(rebuilt.root, line),
    );
  }
}
