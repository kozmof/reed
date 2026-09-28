import type { PieceTableState } from "../../types/state.js";
import { byteOffset } from "../../types/branded.js";
import { getText, isUtf8Boundary } from "./piece-table.js";
import { charToByteOffset } from "./piece-table-offset-convert.js";

import { $beginCost, $proveCtx, type LinearCost } from "../../types/cost-doc.js";

interface Checkpoint {
  byte: number;
  char: number;
}
const indexes = new WeakMap<PieceTableState, Map<number, Checkpoint[]>>();
const BLOCK_BYTES = 4096;

/** Sparse per-snapshot indexes bound decoding allocations and reuse scanned prefixes. */
function locate(
  state: PieceTableState,
  start: number,
  end: number,
  target: number,
  unit: "byte" | "char",
): Checkpoint {
  let lines = indexes.get(state);
  if (!lines) {
    lines = new Map();
    indexes.set(state, lines);
  }
  let points = lines.get(start);
  if (!points) {
    points = [{ byte: 0, char: 0 }];
    lines.set(start, points);
  }
  let lo = 0,
    hi = points.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (points[mid]![unit] <= target) lo = mid;
    else hi = mid - 1;
  }
  let point = points[lo]!;
  while (point[unit] < target && start + point.byte < end) {
    let blockEnd = Math.min(end, start + point.byte + BLOCK_BYTES);
    while (blockEnd > start + point.byte && !isUtf8Boundary(state, byteOffset(blockEnd)))
      blockEnd--;
    const text = getText(state, byteOffset(start + point.byte), byteOffset(blockEnd));
    const next = { byte: blockEnd - start, char: point.char + text.length };
    if (next[unit] > target) {
      if (unit === "char") {
        return { byte: point.byte + charToByteOffset(text, target - point.char), char: target };
      }
      const prefix = getText(state, byteOffset(start + point.byte), byteOffset(start + target));
      return { byte: target, char: point.char + prefix.length };
    }
    if (point === points[points.length - 1]) points.push(next);
    point = next;
  }
  return point;
}

export function lineCharToByte(
  state: PieceTableState,
  start: number,
  end: number,
  column: number,
): number {
  return start + locate(state, start, end, column, "char").byte;
}

export function lineByteToChar(
  state: PieceTableState,
  start: number,
  end: number,
  offset: number,
): LinearCost<number> {
  return $proveCtx($beginCost("O(n)"), locate(state, start, end, offset - start, "byte").char);
}
