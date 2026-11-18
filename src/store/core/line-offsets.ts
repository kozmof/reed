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
interface CheckpointCache {
  lines: Map<number, LineCheckpoints>;
  points: number;
  source?: { cache: CheckpointCache; start: number; end: number; insertedLength: number };
  depth?: number;
}
const indexes = new WeakMap<PieceTableState, CheckpointCache>();
// Budget retained checkpoint nodes rather than lines. A viewport containing
// many modest lines should not evict useful scans merely for crossing 64 lines.
const MAX_CACHED_POINTS = 16384;
function remember(cache: CheckpointCache, start: number, entry: LineCheckpoints): void {
  const previous = cache.lines.get(start);
  if (entry.points.size > MAX_CACHED_POINTS) {
    if (previous) {
      cache.points -= previous.points.size;
      cache.lines.delete(start);
    }
    return;
  }
  cache.points += entry.points.size - (previous?.points.size ?? 0);
  cache.lines.delete(start);
  cache.lines.set(start, entry);
  while (cache.points > MAX_CACHED_POINTS && cache.lines.size > 1) {
    const oldest = cache.lines.keys().next().value!;
    cache.points -= cache.lines.get(oldest)!.points.size;
    cache.lines.delete(oldest);
  }
}

function transformEntry(
  lineStart: number,
  entry: LineCheckpoints,
  start: number,
  end: number,
  insertedLength: number,
): [number, LineCheckpoints] | null {
  const delta = insertedLength - (end - start);
  if (entry.end <= start) return [lineStart, entry];
  if (lineStart > end) return [lineStart + delta, { ...entry, end: entry.end + delta }];
  if (lineStart > start) return null;
  let lo = 0,
    hi = entry.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (entry.points.get(String(mid))!.byte <= start - lineStart) lo = mid;
    else hi = mid - 1;
  }
  return [lineStart, { ...entry, length: lo + 1, end: Math.max(start, entry.end + delta) }];
}

function inheritedEntry(cache: CheckpointCache, start: number): LineCheckpoints | undefined {
  const local = cache.lines.get(start);
  if (local) return local;
  const source = cache.source;
  if (!source) return undefined;
  const delta = source.insertedLength - (source.end - source.start);
  const oldStart = start <= source.start ? start : start - delta;
  // Starts inside inserted text cannot identify an unchanged old line.
  if (start > source.start && oldStart <= source.end) return undefined;
  const old = inheritedEntry(source.cache, oldStart);
  if (!old) return undefined;
  const transformed = transformEntry(
    oldStart,
    old,
    source.start,
    source.end,
    source.insertedLength,
  );
  if (!transformed || transformed[0] !== start) return undefined;
  remember(cache, start, transformed[1]);
  return transformed[1];
}

function materialize(cache: CheckpointCache): void {
  type Migration = NonNullable<CheckpointCache["source"]>;
  function collect(origin: CheckpointCache, migrations: Migration[]): void {
    for (const [start, entry] of origin.lines) {
      let transformed: [number, LineCheckpoints] | null = [start, entry];
      for (const migration of migrations) {
        transformed = transformEntry(
          transformed[0],
          transformed[1],
          migration.start,
          migration.end,
          migration.insertedLength,
        );
        if (!transformed) break;
      }
      if (transformed && !cache.lines.has(transformed[0])) remember(cache, ...transformed);
    }
    // Prefer the nearest snapshot's scanned checkpoints. Populate only the
    // destination, avoiding full copies through every intermediate snapshot.
    if (origin.source) collect(origin.source.cache, [origin.source, ...migrations]);
  }
  if (cache.source) collect(cache.source.cache, [cache.source]);
  delete cache.source;
  cache.depth = 0;
}

/** Defer cache migration until a line is queried; periodically compact the chain. */
export function carryLineOffsetIndexes(
  previous: PieceTableState,
  next: PieceTableState,
  start: number,
  end: number,
  insertedLength: number,
): void {
  const cache = indexes.get(previous);
  if (!cache) return;
  // Bound lookup depth and retained cache ancestry. Bulk migration is amortized
  // across edits instead of charging every keystroke for all scrolled lines.
  if ((cache.depth ?? 0) >= 16) materialize(cache);
  indexes.set(next, {
    lines: new Map(),
    points: 0,
    source: { cache, start, end, insertedLength },
    depth: (cache.depth ?? 0) + 1,
  });
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
  let cache = indexes.get(state);
  if (!cache) {
    cache = { lines: new Map(), points: 0 };
    indexes.set(state, cache);
  }
  let entry = inheritedEntry(cache, start);
  if (!entry) {
    entry = {
      points: PersistentMap.empty<string, Checkpoint>().with("0", { byte: 0, char: 0 }),
      length: 1,
      end,
    };
  }
  remember(cache, start, entry);
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
      remember(cache, start, entry);
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
  return pieceTableByteAtChar(state, column, start, end);
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
