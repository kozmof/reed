import { PersistentMap } from "./persistent-map.js";
import { countPieceTableChars, pieceTableByteAtChar } from "./piece-table-metrics.js";
import type { PieceTableState } from "../../types/state.js";
import { byteOffset } from "../../types/branded.js";
import { getText, isUtf8Boundary } from "./piece-table.js";
import { charToByteOffset } from "./piece-table-offset-convert.js";

import { $beginCost, $proveCtx, type LinearCost } from "../../types/cost-doc.js";

interface Checkpoint {
  byte: number;
  char: number;
}
interface LineCheckpoints {
  points: PersistentMap<string, Checkpoint>;
  length: number;
  end: number;
}
const indexes = new WeakMap<PieceTableState, Map<number, LineCheckpoints>>();
const MAX_CACHED_LINES = 64;

/** Retain safe decoder checkpoints without copying a long line's checkpoint array. */
export function carryLineOffsetIndexes(
  previous: PieceTableState,
  next: PieceTableState,
  start: number,
  end: number,
  insertedLength: number,
): void {
  const lines = indexes.get(previous);
  if (!lines) return;
  const carried = new Map<number, LineCheckpoints>();
  const delta = insertedLength - (end - start);
  for (const [lineStart, entry] of lines) {
    if (entry.end <= start) carried.set(lineStart, entry);
    else if (lineStart > end) carried.set(lineStart + delta, { ...entry, end: entry.end + delta });
    else if (lineStart <= start) {
      let lo = 0,
        hi = entry.length - 1;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (entry.points.get(String(mid))!.byte <= start - lineStart) lo = mid;
        else hi = mid - 1;
      }
      carried.set(lineStart, { ...entry, length: lo + 1, end: Math.max(start, entry.end + delta) });
    }
  }
  indexes.set(next, carried);
}
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
  let entry = lines.get(start);
  if (!entry) {
    if (lines.size >= MAX_CACHED_LINES) lines.delete(lines.keys().next().value!);
    entry = {
      points: PersistentMap.empty<string, Checkpoint>().with("0", { byte: 0, char: 0 }),
      length: 1,
      end,
    };
    lines.set(start, entry);
  }
  let points = entry.points;
  let lo = 0,
    hi = entry.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (points.get(String(mid))![unit] <= target) lo = mid;
    else hi = mid - 1;
  }
  let point = points.get(String(lo))!;
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
    if (point === points.get(String(entry.length - 1))) {
      points = points.with(String(entry.length), next);
      entry = { points, length: entry.length + 1, end };
      lines.set(start, entry);
    }
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
  if (state.chunkMap.size > 0) return start + locate(state, start, end, column, "char").byte;
  if (column <= 0) return start;
  const length = countPieceTableChars(state, start, end);
  if (column >= length) return end;
  return pieceTableByteAtChar(state, countPieceTableChars(state, 0, start) + column);
}

export function lineByteToChar(
  state: PieceTableState,
  start: number,
  end: number,
  offset: number,
): LinearCost<number> {
  return $proveCtx(
    $beginCost("O(n)"),
    state.chunkMap.size > 0
      ? locate(state, start, end, offset - start, "byte").char
      : countPieceTableChars(state, start, Math.min(end, Math.max(start, offset))),
  );
}
