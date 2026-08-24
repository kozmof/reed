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

/** Assert persistent piece-tree ordering, aggregates, identity, and RB properties. */
export function assertPieceTableInvariants(
  state: PieceTableState,
  context = "piece table",
  strictRedBlack = false,
): void {
  const ids = new Set<string>();

  function visit(node: PieceNode | null): {
    blackHeight: number;
    length: number;
    addLength: number;
  } {
    if (node === null) return { blackHeight: 1, length: 0, addLength: 0 };
    expect(Object.isFrozen(node), `${context}: node ${node.id} is frozen`).toBe(true);
    expect(ids.has(node.id), `${context}: duplicate piece ID ${node.id}`).toBe(false);
    ids.add(node.id);
    if (strictRedBlack && node.color === "red") {
      expect(node.left?.color, `${context}: red-left violation`).not.toBe("red");
      expect(node.right?.color, `${context}: red-right violation`).not.toBe("red");
    }
    const left = visit(node.left);
    const right = visit(node.right);
    if (strictRedBlack) {
      expect(left.blackHeight, context + ": black-height").toBe(right.blackHeight);
    }
    const length = node.length + left.length + right.length;
    const addLength =
      (node.bufferType === "add" ? node.length : 0) + left.addLength + right.addLength;
    expect(node.subtreeLength, `${context}: subtreeLength`).toBe(length);
    expect(node.subtreeAddLength, `${context}: subtreeAddLength`).toBe(addLength);
    if (node.bufferType === "chunk") {
      expect(state.chunkMap.has(node.chunkIndex), `${context}: missing chunk buffer`).toBe(true);
    }
    return {
      blackHeight: left.blackHeight + (node.color === "black" ? 1 : 0),
      length,
      addLength,
    };
  }

  if (strictRedBlack && state.root !== null) {
    expect(state.root.color, `: root color`).toBe("black");
  }
  const totals = visit(state.root);
  expect(totals.length, `${context}: totalLength`).toBe(state.totalLength);
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

/** Compare an eager document snapshot with a plain-string reference model. */
export function assertDocumentMatchesModel(
  state: DocumentState<"eager">,
  expected: string,
  context = "document",
): void {
  expect(
    getText(state.pieceTable, byteOffset(0), byteOffset(state.pieceTable.totalLength)),
    `${context}: text`,
  ).toBe(expected);
  assertPieceTableInvariants(state.pieceTable, context);
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
