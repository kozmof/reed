import type { PieceNode, PieceTableState } from "../../types/state.js";
import { unwrapReadonlyUint8Array } from "./runtime-readonly.js";
import { bufferCharPrefix, bufferByteAtChar, bufferCharLength } from "./utf8-metrics.js";

const subtreeChars = new WeakMap<PieceNode, number>();
const ownChars = new WeakMap<PieceNode, number>();

function pieceChars(state: PieceTableState, node: PieceNode, length: number = node.length): number {
  const cached = length === node.length ? ownChars.get(node) : undefined;
  if (cached !== undefined) return cached;
  // Chunk seams may split UTF-8 sequences or contain malformed input. Chunked
  // documents use the decoder-based path instead of these valid-UTF-8 metrics.
  if (node.bufferType === "chunk") throw new Error("Chunk metrics require streaming decoding");
  const bytes = unwrapReadonlyUint8Array(
    node.bufferType === "original" ? state.originalBuffer : state.addBuffer.bytes,
  );
  const result = bufferCharLength(bytes, node.start, node.start + length);
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

function prefix(state: PieceTableState, node: PieceNode | null, end: number): number {
  if (!node || end <= 0) return 0;
  if (end >= node.subtreeLength) return totalChars(state, node);
  const leftBytes = node.left?.subtreeLength ?? 0;
  if (end <= leftBytes) return prefix(state, node.left, end);
  const leftChars = totalChars(state, node.left);
  if (end <= leftBytes + node.length) return leftChars + pieceChars(state, node, end - leftBytes);
  return (
    leftChars + pieceChars(state, node) + prefix(state, node.right, end - leftBytes - node.length)
  );
}

export function countPieceTableChars(state: PieceTableState, start: number, end: number): number {
  return prefix(state, state.root, end) - prefix(state, state.root, start);
}

/** Locate an absolute UTF-16 offset using shared subtree counts. */
export function pieceTableByteAtChar(state: PieceTableState, target: number): number {
  let node = state.root;
  let offset = 0;
  while (node) {
    const leftChars = totalChars(state, node.left);
    if (target < leftChars) {
      node = node.left;
      continue;
    }
    target -= leftChars;
    offset += node.left?.subtreeLength ?? 0;
    const chars = pieceChars(state, node);
    if (target <= chars) {
      if (node.bufferType === "chunk") throw new Error("Chunk metrics require streaming decoding");
      const bytes = unwrapReadonlyUint8Array(
        node.bufferType === "original" ? state.originalBuffer : state.addBuffer.bytes,
      );
      const base = bufferCharPrefix(bytes, node.start);
      return offset + Math.min(node.length, bufferByteAtChar(bytes, base + target) - node.start);
    }
    target -= chars;
    offset += node.length;
    node = node.right;
  }
  return offset;
}
