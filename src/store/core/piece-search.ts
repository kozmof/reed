/**
 * Offset lookups in the piece tree.
 *
 * Shared by the piece table and the chunk placement keys, which cannot import
 * each other: the piece table imports `chunk-anchor.ts` for insertion keys.
 */

import type { PieceNode } from "../../types/state.js";

/**
 * Entry in the path from root to a node.
 * Used for immutable tree modifications with path copying.
 */
export interface PathEntry {
  readonly node: PieceNode;
  readonly direction: "left" | "right";
}

/** A piece and the document offset where it starts. */
export interface PieceHit {
  readonly node: PieceNode;
  readonly pieceStart: number;
}

/**
 * The piece holding byte `offset`, or null when `offset` is outside
 * [0, total length). When `path` is given, the nodes visited above the piece
 * are pushed onto it, root first. O(log n).
 */
export function pieceAt(
  root: PieceNode | null,
  offset: number,
  path?: PathEntry[],
): PieceHit | null {
  if (offset < 0) return null;
  let node = root;
  let base = 0;
  while (node !== null) {
    const pieceStart = base + (node.left?.subtreeLength ?? 0);
    if (offset < pieceStart) {
      path?.push({ node, direction: "left" });
      node = node.left;
    } else if (offset >= pieceStart + node.length) {
      path?.push({ node, direction: "right" });
      base = pieceStart + node.length;
      node = node.right;
    } else {
      return { node, pieceStart };
    }
  }
  return null;
}

/**
 * The last piece in document order, or null for an empty tree. When `path` is
 * given, the nodes visited above the piece are pushed onto it. O(log n).
 */
export function lastPiece(root: PieceNode | null, path?: PathEntry[]): PieceHit | null {
  if (root === null) return null;
  let node = root;
  let base = 0;
  while (node.right !== null) {
    path?.push({ node, direction: "right" });
    base += (node.left?.subtreeLength ?? 0) + node.length;
    node = node.right;
  }
  return { node, pieceStart: base + (node.left?.subtreeLength ?? 0) };
}
