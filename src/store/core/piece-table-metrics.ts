import type { PieceNode, PieceTableState } from "../../types/state.js";
import { pieceBufferRanges } from "./piece-buffer-ranges.js";
import { bufferByteAtCharInRange, bufferCharLength } from "./utf8-metrics.js";

const subtreeChars = new WeakMap<PieceNode, number>();
const ownChars = new WeakMap<PieceNode, number>();

function pieceChars(state: PieceTableState, node: PieceNode, length: number = node.length): number {
  const cached = length === node.length ? ownChars.get(node) : undefined;
  if (cached !== undefined) return cached;
  // Chunk seams may split UTF-8 sequences or contain malformed input. Chunked
  // documents use the decoder-based path instead of these valid-UTF-8 metrics.
  if (node.bufferType === "chunk") throw new Error("Chunk metrics require streaming decoding");
  let result = 0;
  for (const range of pieceBufferRanges(state, node, node.start, node.start + length))
    result += bufferCharLength(range.bytes, range.start, range.end);
  if (length === node.length) ownChars.set(node, result);
  return result;
}

function totalChars(state: PieceTableState, node: PieceNode | null): number {
  if (!node) return 0;
  const cached = subtreeChars.get(node);
  if (cached !== undefined) return cached;
  const result =
    totalChars(state, node.left) + pieceChars(state, node) + totalChars(state, node.right);
  subtreeChars.set(node, result);
  return result;
}

/** Count only intersecting subtrees; an unrelated document prefix is never visited. */
export function countPieceTableChars(state: PieceTableState, start: number, end: number): number {
  function visit(node: PieceNode | null, offset: number): number {
    if (!node || offset >= end || offset + node.subtreeLength <= start) return 0;
    if (start <= offset && offset + node.subtreeLength <= end) return totalChars(state, node);
    const pieceStart = offset + (node.left?.subtreeLength ?? 0);
    const pieceEnd = pieceStart + node.length;
    let chars = visit(node.left, offset) + visit(node.right, pieceEnd);
    const from = Math.max(start, pieceStart),
      to = Math.min(end, pieceEnd);
    if (from < to) {
      if (node.bufferType === "chunk") throw new Error("Chunk metrics require streaming decoding");
      for (const range of pieceBufferRanges(
        state,
        node,
        node.start + from - pieceStart,
        node.start + to - pieceStart,
      ))
        chars += bufferCharLength(range.bytes, range.start, range.end);
    }
    return chars;
  }
  return visit(state.root, 0);
}

/** Seek from a range start, descending cold subtrees instead of counting their entire tails. */
export function pieceTableByteAtChar(
  state: PieceTableState,
  target: number,
  start = 0,
  end = state.totalLength,
): number {
  let remaining = target;
  let result = start;
  function visit(node: PieceNode | null, offset: number): void {
    if (!node || remaining <= 0 || offset >= end || offset + node.subtreeLength <= start) return;
    if (
      start <= offset &&
      offset + node.subtreeLength <= end &&
      (subtreeChars.has(node) || node.subtreeLength <= remaining * 4)
    ) {
      const chars = totalChars(state, node);
      if (chars <= remaining) {
        remaining -= chars;
        result = offset + node.subtreeLength;
        return;
      }
    }
    const pieceStart = offset + (node.left?.subtreeLength ?? 0);
    const pieceEnd = pieceStart + node.length;
    visit(node.left, offset);
    const from = Math.max(start, pieceStart),
      to = Math.min(end, pieceEnd);
    if (remaining > 0 && from < to) {
      if (node.bufferType === "chunk") throw new Error("Chunk metrics require streaming decoding");
      const bufferStart = node.start + from - pieceStart;
      const bufferEnd = node.start + to - pieceStart;
      for (const range of pieceBufferRanges(state, node, bufferStart, bufferEnd)) {
        const found = bufferByteAtCharInRange(range.bytes, range.start, range.end, remaining);
        result = from + range.offset - bufferStart + found - range.start;
        remaining =
          found < range.end
            ? 0
            : Math.max(0, remaining - bufferCharLength(range.bytes, range.start, range.end));
        if (remaining <= 0) break;
      }
    }
    visit(node.right, pieceEnd);
  }
  visit(state.root, 0);
  return result;
}
