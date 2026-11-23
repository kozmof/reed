/**
 * Checkpoint version migration.
 *
 * Add one migration step per new version to keep older checkpoints readable.
 * Version 2 added chunk placement keys and anchored history positions.
 *
 * Design decisions (see `docs/adr/001-checkpoint-compatibility.md`):
 *
 * - Migrations run on raw wire data, before validation. Validators encode
 *   the shape of the current version, so an older payload cannot be validated
 *   before it has been brought forward.
 * - Migrate one version at a time, following `v1 -> v2 -> v3`.
 *   Each step is written once, against the format immediately preceding it.
 * - Unknown fields are preserved. A checkpoint written by a newer patch
 *   release of the same version may carry fields this build does not read.
 *   Keep them so a round trip preserves the data.
 * - Downgrade is not supported. A checkpoint from a future version fails
 *   with `VERSION_UNSUPPORTED` so callers can fall back to re-loading from the
 *   original source rather than restoring a lossy approximation.
 */

import { CHECKPOINT_VERSION, CheckpointError } from "../../types/checkpoint.js";
import { lowerBound } from "../core/binary-search.js";
import { base64DecodedLength, decodeBase64, encodeBase64 } from "../core/base64.js";
import type { GapSide, KeyRun } from "../core/chunk-anchor.js";
import {
  NO_CHUNK,
  buildLoadedChunks,
  byteKey,
  gapKey,
  keyFitsAt,
  loadedSumAtOrBelow,
  pieceKey,
  placementRuns,
} from "../core/chunk-anchor.js";
import { decodeRun, textEncoder, utf8ByteLength } from "../core/encoding.js";
import {
  insertChunkPieceAt,
  pieceTableDelete,
  pieceTableInsertPlaceholder,
} from "../core/piece-table.js";
import { pieceAt } from "../core/piece-search.js";
import type { PieceDescriptor } from "../core/state.js";
import { buildPieceTree, createEmptyPieceTableState } from "../core/state.js";
import type { PieceTableState } from "../../types/state.js";
import { endpointSides } from "./history-anchor.js";
import { byteLength, byteOffset, pieceID } from "../../types/branded.js";

/** Raw, unvalidated checkpoint wire data. */
export type CheckpointWireData = Record<string, unknown>;

/**
 * One single-version upgrade step.
 *
 * `migrate` receives the payload at version `from` and must return it at
 * version `to`. Preserve the input so callers can retain it or retry restore.
 */
export interface CheckpointMigration {
  readonly from: number;
  readonly to: number;
  migrate(data: CheckpointWireData): CheckpointWireData;
}

// =============================================================================
// v1 -> v2: chunk placement keys and anchored history positions
// =============================================================================

type WireTuple = readonly unknown[];

const isTuple = (value: unknown): value is WireTuple => Array.isArray(value);
/**
 * True when `value` is a safe integer. Restore validates checkpoint integers
 * with this too, so migration and restore agree on what is malformed.
 */
export const isInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value);

/**
 * A version 1 change as the bytes it removes and inserts at `offset`, which is
 * all that moves text. A replace removes its old text and inserts its new text.
 */
interface ChangeShape {
  readonly offset: number;
  readonly removed: number;
  readonly inserted: number;
  /** The removed text, which `removed` is the UTF-8 length of. */
  readonly removedText: string;
}

const clampTo = (doc: PieceTableState, offset: number) =>
  byteOffset(Math.max(0, Math.min(offset, doc.totalLength)));

/**
 * `doc` with `length` stand-in bytes inserted at `offset` with key `key`. A
 * key that does not fit there throws a RangeError (see
 * `pieceTableInsertPlaceholder`), and restore reports the payload as malformed.
 */
function insertStandIn(
  doc: PieceTableState,
  offset: number,
  length: number,
  key: number,
): PieceTableState {
  return pieceTableInsertPlaceholder(doc, clampTo(doc, offset), length, key);
}

function removeBytes(doc: PieceTableState, offset: number, length: number): PieceTableState {
  return pieceTableDelete(doc, clampTo(doc, offset), clampTo(doc, offset + length));
}

/**
 * The keys `shape` takes in `before`, the document it applies to, and the
 * document after it, as `applyEdit` records them: the removed bytes split
 * into runs that share a key (see `placementRuns`), and inserted text takes
 * the key of the first run, else the key of the gap it lands in.
 *
 * `runs` is empty when nothing is removed, or when the removed range runs
 * past the end of `before`, which restore then reports.
 */
function applyShape(
  before: PieceTableState,
  shape: ChangeShape,
): { key: number; runs: readonly KeyRun[]; after: PieceTableState } {
  const { offset, removed, inserted } = shape;
  const runs =
    removed > 0 && offset >= 0 && offset + removed <= before.totalLength
      ? placementRuns(before, offset, offset + removed)
      : [];
  const key =
    runs[0]?.key ??
    (removed > 0 && offset >= 0 && offset < before.totalLength
      ? byteKey(before.root, offset)
      : gapKey(before.root, clampTo(before, offset), "before"));
  const after = insertStandIn(removeBytes(before, offset, removed), offset, inserted, key);
  return { key, runs, after };
}

/** `doc` with a piece of chunk `chunk` covering [start, start + length) inserted at piece boundary `offset`. */
function insertChunkStandIn(
  doc: PieceTableState,
  offset: number,
  chunk: number,
  start: number,
  length: number,
): PieceTableState {
  if (length <= 0) return doc;
  const root = insertChunkPieceAt(doc.root, offset, chunk, length, undefined, start);
  return { ...doc, root, totalLength: doc.totalLength + length };
}

/** Number of leading bytes `a` and `b` share, up to `limit`. */
function sharedPrefix(a: Uint8Array, aStart: number, b: Uint8Array, bStart: number, limit: number) {
  let n = 0;
  while (n < limit && a[aStart + n] === b[bStart + n]) n++;
  return n;
}

/** Number of bytes `a` and `b` share ending at `aEnd` and `bEnd`, up to `limit`. */
function sharedSuffix(a: Uint8Array, aEnd: number, b: Uint8Array, bEnd: number, limit: number) {
  let n = 0;
  while (n < limit && a[aEnd - 1 - n] === b[bEnd - 1 - n]) n++;
  return n;
}

/**
 * The Knuth-Morris-Pratt failure table of `needle`: for each prefix, the
 * length of its longest proper prefix that is also its suffix. O(n).
 */
function failureTable(needle: Uint8Array): Int32Array {
  const table = new Int32Array(needle.length);
  for (let i = 1, k = 0; i < needle.length; i++) {
    while (k > 0 && needle[i] !== needle[k]) k = table[k - 1]!;
    if (needle[i] === needle[k]) k++;
    table[i] = k;
  }
  return table;
}

/**
 * Where `needle` lies in `haystack[from, to)`: the first place, or with
 * `last` the last place, or -1 when it is not there. `table` is the
 * needle's `failureTable`. O(to - from), whatever the bytes.
 */
function indexIn(
  haystack: Uint8Array,
  needle: Uint8Array,
  table: Int32Array,
  from: number,
  to: number,
  last: boolean,
) {
  const n = needle.length;
  let found = -1;
  for (let i = from, k = 0; i < to; i++) {
    while (k > 0 && haystack[i] !== needle[k]) k = table[k - 1]!;
    if (haystack[i] === needle[k]) k++;
    if (k === n) {
      found = i + 1 - n;
      if (!last) return found;
      k = table[k - 1]!;
    }
  }
  return found;
}

/**
 * Work the searches for where removed bytes came from may still do, in bytes
 * scanned. The bytes missing at a gap can be most of the loaded chunks, and
 * every change of the history searches them again, so without a bound a
 * version 1 payload could make migration take time quadratic in its size.
 * Once spent, removed bytes are no longer looked for and take the key around
 * them (see `removedSources`), which leaves the migrated history valid.
 */
interface SearchBudget {
  remaining: number;
}

/** Work allowed per byte of chunk data and of text the undo stack removed. */
const SEARCH_WORK_PER_BYTE = 16;
/** Work allowed whatever the payload's size. */
const SEARCH_WORK_FLOOR = 1 << 20;

/** Spend `cost` from `budget`, or nothing and return false when it is not there. */
function spend(budget: SearchBudget, cost: number): boolean {
  if (cost > budget.remaining) return false;
  budget.remaining -= cost;
  return true;
}

/**
 * The text of each of `runs`, which split the UTF-8 bytes of `text` from the
 * first run's start, with the bytes as well where the text does not encode
 * back to them, as a live edit records them (see `decodeRun`).
 */
function runTexts(text: unknown, runs: readonly KeyRun[]) {
  const all = textEncoder.encode(typeof text === "string" ? text : "");
  const base = runs[0]?.start ?? 0;
  return (run: KeyRun): [string] | [string, string] => {
    const bytes = all.subarray(run.start - base, run.end - base);
    const { text: decoded, exact } = decodeRun(bytes);
    return exact ? [decoded] : [decoded, encodeBase64(bytes)];
  };
}

/**
 * The loaded chunks of a version 1 checkpoint: their indices in ascending
 * order, and their bytes, or undefined when the checkpoint does not hold them.
 */
interface LoadedChunkBytes {
  readonly indices: readonly number[];
  bytes(chunk: number): Uint8Array | undefined;
  /** Shared by every search among them, for the whole migration. */
  readonly budget: SearchBudget;
}

/** Bytes [start, start + length) of chunk `chunk`. */
interface ChunkRun {
  readonly chunk: number;
  readonly start: number;
  readonly length: number;
}

/**
 * Bytes [from, to) of a loaded chunk that are not resident at a gap, so bytes
 * removed there may be theirs. `fromEnd` prefers the last place removed bytes
 * are found in them, for the chunk after the gap.
 */
interface LostBytes {
  readonly chunk: number;
  readonly bytes: Uint8Array;
  readonly from: number;
  readonly to: number;
  readonly fromEnd: boolean;
}

/**
 * The bytes of loaded chunks missing at the gap at `offset` in `doc`, in
 * document order.
 *
 * A chunk piece that ends at the gap before the end of its chunk, or starts
 * at it after the start of its chunk, lost bytes there. Two pieces of one
 * chunk lost only the bytes between them. A loaded chunk whose key fits the
 * gap and that neither piece belongs to can have lost every byte, so all of
 * its bytes are candidates too, while `chunks.budget` lasts. `inside` is the
 * key of a neighbor that lost bytes, which removed bytes found nowhere most
 * likely came from.
 */
function lostAt(
  doc: PieceTableState,
  offset: number,
  chunks: LoadedChunkBytes,
): { lost: LostBytes[]; inside: number | undefined } {
  const before = offset > 0 ? pieceAt(doc.root, offset - 1) : null;
  const after = pieceAt(doc.root, offset);
  // Inside a piece, nothing was lost at the gap.
  if (before !== null && after !== null && before.node === after.node) {
    return { lost: [], inside: undefined };
  }
  // `before` holds the byte before the gap and is not `after`, so it ends there.
  const leftNode = before?.node.bufferType === "chunk" ? before.node : null;
  const rightNode = after?.node.bufferType === "chunk" ? after.node : null;
  const leftBytes = leftNode === null ? undefined : chunks.bytes(leftNode.chunkIndex);
  const rightBytes = rightNode === null ? undefined : chunks.bytes(rightNode.chunkIndex);
  const sameChunk = leftNode !== null && leftNode.chunkIndex === rightNode?.chunkIndex;
  const lostLeft: LostBytes | null =
    leftNode !== null && leftBytes !== undefined
      ? {
          chunk: leftNode.chunkIndex,
          bytes: leftBytes,
          from: leftNode.start + leftNode.length,
          to: sameChunk ? rightNode!.start : leftBytes.length,
          fromEnd: false,
        }
      : null;
  // Two pieces of one chunk share the bytes between them, which `lostLeft` holds.
  const lostRight: LostBytes | null =
    rightNode !== null &&
    rightBytes !== undefined &&
    !sameChunk &&
    rightNode.start <= rightBytes.length
      ? {
          chunk: rightNode.chunkIndex,
          bytes: rightBytes,
          from: 0,
          to: rightNode.start,
          fromEnd: true,
        }
      : null;
  const left = lostLeft !== null && lostLeft.from < lostLeft.to ? lostLeft : null;
  const right = lostRight !== null && lostRight.from < lostRight.to ? lostRight : null;
  const lost: LostBytes[] = left === null ? [] : [left];
  // Chunk `c` has key `c - 1`, which fits between the keys on either side.
  const low = before === null ? NO_CHUNK : pieceKey(before.node);
  const high = after === null ? Infinity : pieceKey(after.node);
  const { indices } = chunks;
  for (let i = lowerBound(indices, low + 1); i < indices.length && indices[i]! - 1 <= high; i++) {
    // Each candidate costs a step here and a scan of its bytes later.
    if (!spend(chunks.budget, 1)) break;
    const chunk = indices[i]!;
    if (chunk === leftNode?.chunkIndex || chunk === rightNode?.chunkIndex) continue;
    const bytes = chunks.bytes(chunk);
    if (bytes !== undefined && bytes.length > 0) {
      lost.push({ chunk, bytes, from: 0, to: bytes.length, fromEnd: false });
    }
  }
  if (right !== null) lost.push(right);
  const neighbor = left ?? right;
  return { lost, inside: neighbor === null ? undefined : neighbor.chunk - 1 };
}

/**
 * Removed bytes given back as one run: as bytes of chunk run `run` when
 * given, else under key `key`, else (both undefined) under the key of the
 * bytes around them.
 */
interface RemovedPart {
  readonly length: number;
  readonly run: ChunkRun | null;
  readonly key: number | undefined;
}

/**
 * Where the bytes `removed` came from, for the gap at `offset` in `doc`, the
 * document without them, among the bytes missing there (see `lostAt`), which
 * are in document order. Returns `removed` split into parts in order.
 *
 * Removed bytes that begin with the first missing bytes are theirs, running
 * on into the next chunk's while they match whole chunks. Removed bytes that
 * end with the last missing bytes are theirs, running back the same way.
 * Bytes between those that an older edit, not yet given back, kept apart from
 * the rest are looked for in one piece among the missing bytes between. Else
 * older edits also took bytes from among them, so each byte takes the key of
 * the next missing byte equal to it, in order. A byte found nowhere takes the
 * key around it, which `inside`, the key of a neighbor that lost bytes, most
 * likely is.
 *
 * Both searches take time linear in the removed and missing bytes, and are
 * skipped, leaving the bytes found nowhere, once `chunks.budget` is spent.
 */
function removedSources(
  doc: PieceTableState,
  offset: number,
  removed: Uint8Array,
  chunks: LoadedChunkBytes,
): { parts: readonly RemovedPart[]; inside: number | undefined } {
  const { lost, inside } = lostAt(doc, offset, chunks);
  const tail: RemovedPart[] = [];
  const head: RemovedPart[] = [];
  const part = (chunk: number, start: number, length: number): RemovedPart => ({
    length,
    run: { chunk, start, length },
    key: chunk - 1,
  });
  // Removed bytes [start, end) are not matched yet. Missing bytes from
  // `lost[first]` at `firstAt` to `lost[last]` before `lastAt` are not taken.
  let start = 0;
  let end = removed.length;
  let first = 0;
  let firstAt = lost[0]?.from ?? 0;
  while (first < lost.length && start < end) {
    const { chunk, bytes, to } = lost[first]!;
    const length = sharedPrefix(
      removed,
      start,
      bytes,
      firstAt,
      Math.min(end - start, to - firstAt),
    );
    if (length > 0) tail.push(part(chunk, firstAt, length));
    start += length;
    firstAt += length;
    if (firstAt < to) break;
    first++;
    firstAt = lost[first]?.from ?? 0;
  }
  let last = lost.length - 1;
  let lastAt = lost[last]?.to ?? 0;
  while (last >= first && start < end) {
    const { chunk, bytes, from } = lost[last]!;
    const floor = last === first ? firstAt : from;
    const length = sharedSuffix(removed, end, bytes, lastAt, Math.min(end - start, lastAt - floor));
    if (length > 0) head.unshift(part(chunk, lastAt - length, length));
    end -= length;
    lastAt -= length;
    if (lastAt > from) break;
    last--;
    lastAt = lost[last]?.to ?? 0;
  }
  if (end <= start) return { parts: [...tail, ...head], inside };
  const rest = removed.subarray(start, end);
  const unmatched = (): RemovedPart[] => [
    ...tail,
    { length: rest.length, run: null, key: undefined },
    ...head,
  ];
  // Missing bytes of `lost[k]` not taken by the tail or head.
  const lowAt = (k: number) => (k === first ? firstAt : lost[k]!.from);
  const highAt = (k: number) => Math.max(lowAt(k), k === last ? lastAt : lost[k]!.to);
  let missing = 0;
  for (let k = first; k <= last; k++) missing += highAt(k) - lowAt(k);
  // Each search below scans the missing bytes once, and `rest` once.
  if (!spend(chunks.budget, 2 * (missing + rest.length))) return { parts: unmatched(), inside };
  const table = failureTable(rest);
  for (let k = first; k <= last; k++) {
    const { chunk, bytes, fromEnd } = lost[k]!;
    const at = indexIn(bytes, rest, table, lowAt(k), highAt(k), fromEnd);
    if (at >= 0) return { parts: [...tail, part(chunk, at, rest.length), ...head], inside };
  }
  if (missing === 0) return { parts: unmatched(), inside };
  // The missing bytes as one sequence, in document order. `segments[s]` is
  // where the bytes of `lost[first + s]` start in it. `where` lists the
  // positions of each byte value in ascending order, the positions of value
  // `v` at [`starts[v]`, `starts[v + 1]`).
  const segments = new Float64Array(last - first + 1);
  const starts = new Float64Array(257);
  for (let k = first, total = 0; k <= last; k++) {
    segments[k - first] = total;
    total += highAt(k) - lowAt(k);
    const { bytes } = lost[k]!;
    for (let i = lowAt(k); i < highAt(k); i++) starts[bytes[i]! + 1] = starts[bytes[i]! + 1]! + 1;
  }
  for (let v = 1; v <= 256; v++) starts[v] = starts[v]! + starts[v - 1]!;
  const where = new Float64Array(missing);
  const filled = starts.slice(0, 256);
  for (let k = first; k <= last; k++) {
    const { bytes } = lost[k]!;
    const base = segments[k - first]! - lowAt(k);
    for (let i = lowAt(k); i < highAt(k); i++) {
      const byte = bytes[i]!;
      where[filled[byte]!] = base + i;
      filled[byte] = filled[byte]! + 1;
    }
  }
  /**
   * Index into `lost` of the missing byte at `position` in the sequence: the
   * last segment starting at or before it, as an empty segment before it
   * shares its start.
   */
  const segmentOf = (position: number): number => {
    let low = 0;
    let high = segments.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >>> 1;
      if (segments[mid]! <= position) low = mid;
      else high = mid - 1;
    }
    return first + low;
  };
  // Each byte takes the key of the next missing byte equal to it, at or after
  // `next`. The positions `next` passes are never needed again, so `cursor[v]`
  // skips them for value `v` once, which keeps the whole walk linear.
  const middle: RemovedPart[] = [];
  const cursor = starts.slice(0, 256);
  let next = 0;
  for (const byte of rest) {
    let key: number | undefined;
    const stop = starts[byte + 1]!;
    let at = cursor[byte]!;
    while (at < stop && where[at]! < next) at++;
    cursor[byte] = at;
    if (at < stop) {
      const position = where[at]!;
      key = lost[segmentOf(position)]!.chunk - 1;
      next = position + 1;
    }
    const previous = middle[middle.length - 1];
    if (previous !== undefined && previous.key === key) {
      middle[middle.length - 1] = { ...previous, length: previous.length + 1 };
    } else {
      middle.push({ length: 1, run: null, key });
    }
  }
  return { parts: [...tail, ...middle, ...head], inside };
}

/**
 * The document `shape` applies to, given `after`, the document it produced,
 * and the keys it takes there: the inserted text split into runs that share a
 * key in `after` (`inserts`), and the removed bytes split into runs that share
 * a key (`runs`), as `applyShape` gives them. `key` is the key of the first
 * inserted run, else of the gap. Redo inserts each run under its key, so the
 * text gets back the keys the rest of the walk saw it with.
 *
 * The removed bytes are not in `after`, so the keys they had are not
 * recorded. Bytes found in a loaded chunk missing at the gap (see
 * `removedSources`) take its key, and a run found in one piece comes back as
 * that chunk's bytes, so later steps of the walk see the chunk whole again.
 * Other removed bytes take the key of a neighbor that lost bytes, else the
 * key the inserted text had, else the key of the gap, at most the key of the
 * bytes found after them.
 */
function unapplyShape(
  after: PieceTableState,
  shape: ChangeShape,
  chunks: LoadedChunkBytes,
): {
  key: number;
  inserts: readonly KeyRun[];
  runs: readonly KeyRun[];
  before: PieceTableState;
} {
  const { offset, removed, inserted } = shape;
  const without = removeBytes(after, offset, inserted);
  const at = clampTo(without, offset);
  // Out of range, the change is malformed, which restore reports.
  const inserts =
    inserted > 0 && offset >= 0 && offset + inserted <= after.totalLength
      ? placementRuns(after, offset, offset + inserted)
      : [];
  const insertedKey = inserts[0]?.key;
  // The first of `keys` that fits at `position` and is at most `limit`, else
  // the gap's key. Keys never decrease, and every key up to `limit` that is
  // at least the keys before `position` fits there, so `limit` caps the gap's.
  const fitting = (
    doc: PieceTableState,
    position: number,
    limit: number,
    ...keys: (number | undefined)[]
  ) => {
    const found = keys.find(
      (key) => key !== undefined && key <= limit && keyFitsAt(doc, position, key),
    );
    if (found !== undefined) return found;
    return Math.min(gapKey(doc.root, position, "before"), limit);
  };
  const key = fitting(without, at, Infinity, insertedKey);
  if (removed <= 0) return { key, inserts, runs: [], before: without };

  const { parts, inside } = removedSources(
    without,
    at,
    textEncoder.encode(shape.removedText),
    chunks,
  );
  const runs: KeyRun[] = [];
  let doc = without;
  let position: number = at;
  // Give back `length` bytes at `position`, as bytes of `run` when given.
  // Runs are in document order, and neighbors that share a key are one run.
  const giveBack = (length: number, key: number, run: ChunkRun | null) => {
    if (length <= 0) return;
    doc =
      run === null
        ? insertStandIn(doc, position, length, key)
        : insertChunkStandIn(doc, position, run.chunk, run.start, length);
    const last = runs[runs.length - 1];
    if (last?.key === key) runs[runs.length - 1] = { ...last, end: position + length };
    else runs.push({ start: position, end: position + length, key });
    position += length;
  };
  for (let p = 0; p < parts.length; p++) {
    const { length, run, key: partKey } = parts[p]!;
    if (partKey !== undefined) {
      giveBack(length, partKey, run);
      continue;
    }
    let limit = Infinity;
    for (let q = p + 1; q < parts.length && limit === Infinity; q++) {
      limit = parts[q]!.key ?? Infinity;
    }
    giveBack(length, fitting(doc, position, limit, inside, insertedKey), null);
  }
  return { key, inserts, runs, before: doc };
}

/**
 * Version 2 adds a chunk placement key to add pieces and stores history
 * positions as anchors (see `HistoryAnchor`) instead of resident offsets.
 *
 * Version 1 placed a re-loaded chunk after every add piece that followed a
 * higher chunk, so an add piece belongs after the nearest chunk before it. The
 * derived keys reproduce that placement. Version 1 history offsets are read in
 * the captured chunk layout, each in the document its entry applied to, and
 * anchored there, which keeps undo and redo behaving as they would have right
 * after restore.
 *
 * Documents with neither chunk pieces nor loaded chunks need no change: every
 * key is -1 and every anchor equals its offset. Malformed input is returned as
 * is for the validators to report.
 */
function migrateV1ToV2(data: CheckpointWireData): CheckpointWireData {
  return anchorV1Positions(trimV1Tuples(data));
}

/**
 * How many elements version 1 restore read from a history change of each
 * kind: kind, offset and text, and for a replace the old text too.
 */
const V1_CHANGE_LENGTH: Readonly<Record<string, number>> = { i: 3, d: 3, r: 4 };

/**
 * Cut every version 1 tuple that version 2 reads further than version 1 did
 * back to the elements version 1 read: selection ranges, live and in
 * history, to [anchor, head]; add pieces to [id, "a", start, length]; and
 * history changes as `V1_CHANGE_LENGTH` gives. Version 1 restore ignored the
 * rest, while version 2 reads the next elements as chunk keys or raw bytes,
 * so a tuple that carried extras would fail to restore or take wrong keys.
 * A change of unknown kind is left for restore to report.
 */
function trimV1Tuples(data: CheckpointWireData): CheckpointWireData {
  /** `raw` with each element mapped by `cut`, or `raw` itself when `cut` changes none. */
  const mapArray = (raw: unknown, cut: (item: unknown) => unknown): unknown => {
    if (!Array.isArray(raw)) return raw;
    let changed = false;
    const items = raw.map((item: unknown) => {
      const next = cut(item);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? items : raw;
  };
  const cutTo = (tuple: unknown, length: number | undefined): unknown =>
    isTuple(tuple) && length !== undefined && tuple.length > length
      ? tuple.slice(0, length)
      : tuple;
  const trimSelection = (raw: unknown): unknown => {
    if (typeof raw !== "object" || raw === null) return raw;
    const selection = raw as Record<string, unknown>;
    const ranges = mapArray(selection.ranges, (range) => cutTo(range, 2));
    return ranges === selection.ranges ? raw : { ...selection, ranges };
  };
  const trimChange = (change: unknown): unknown =>
    isTuple(change) && typeof change[0] === "string" && Object.hasOwn(V1_CHANGE_LENGTH, change[0])
      ? cutTo(change, V1_CHANGE_LENGTH[change[0]])
      : change;
  // Rebuild only what changes, so other input reaches restore as it was.
  const trimEntry = (entry: unknown): unknown => {
    if (typeof entry !== "object" || entry === null) return entry;
    const { changes, selectionBefore, selectionAfter } = entry as Record<string, unknown>;
    const trimmedChanges = mapArray(changes, trimChange);
    const before = trimSelection(selectionBefore);
    const after = trimSelection(selectionAfter);
    if (trimmedChanges === changes && before === selectionBefore && after === selectionAfter) {
      return entry;
    }
    return {
      ...entry,
      ...(trimmedChanges !== changes && { changes: trimmedChanges }),
      ...(before !== selectionBefore && { selectionBefore: before }),
      ...(after !== selectionAfter && { selectionAfter: after }),
    };
  };
  let result = data;
  const selection = trimSelection(data.selection);
  if (selection !== data.selection) result = { ...result, selection };
  const rawTable = data.pieceTable;
  if (typeof rawTable === "object" && rawTable !== null) {
    const table = rawTable as Record<string, unknown>;
    const pieces = mapArray(table.pieces, (piece) =>
      isTuple(piece) && piece[1] === "a" ? cutTo(piece, 4) : piece,
    );
    if (pieces !== table.pieces) result = { ...result, pieceTable: { ...table, pieces } };
  }
  const rawHistory = data.history;
  if (typeof rawHistory === "object" && rawHistory !== null) {
    const { undo, redo } = rawHistory as Record<string, unknown>;
    const newUndo = mapArray(undo, trimEntry);
    const newRedo = mapArray(redo, trimEntry);
    if (newUndo !== undo || newRedo !== redo) {
      result = { ...result, history: { ...rawHistory, undo: newUndo, redo: newRedo } };
    }
  }
  return result;
}

/** Assign chunk placement keys to version 1 offsets. See `migrateV1ToV2`. */
function anchorV1Positions(data: CheckpointWireData): CheckpointWireData {
  const pieceTable = data.pieceTable;
  if (typeof pieceTable !== "object" || pieceTable === null) return data;
  const table = pieceTable as Record<string, unknown>;
  const rawPieces = table.pieces;
  if (!Array.isArray(rawPieces) || !rawPieces.every(isTuple)) return data;
  const pieces = rawPieces as readonly WireTuple[];

  const chunkLengths: [number, number][] = [];
  const chunkBase64 = new Map<number, string>();
  if (Array.isArray(table.chunks)) {
    for (const entry of table.chunks) {
      if (isTuple(entry) && isInt(entry[0])) {
        const base64 = typeof entry[1] === "string" ? entry[1] : "";
        chunkLengths.push([entry[0], base64DecodedLength(base64)]);
        chunkBase64.set(entry[0], base64);
      }
    }
  }
  // Without chunk pieces or loaded chunks, every key is -1. A loaded chunk
  // with no piece left can still be where text that undo gives back came from.
  if (chunkBase64.size === 0 && !pieces.some((piece) => piece[1] === "c")) return data;

  // Decoded only for chunks missing where undo gives bytes back.
  const decoded = new Map<number, Uint8Array | undefined>();
  const bytes = (chunk: number) => {
    if (!decoded.has(chunk)) {
      const base64 = chunkBase64.get(chunk);
      let value: Uint8Array | undefined;
      try {
        value = base64 === undefined ? undefined : decodeBase64(base64);
      } catch {
        // Malformed chunk data, which restore reports.
      }
      decoded.set(chunk, value);
    }
    return decoded.get(chunk);
  };
  // Undo gives back the removed text of each change, so the searches for
  // where it came from may scan in all a multiple of the chunk data and that
  // text, counted in UTF-8 bytes like the bytes searched. The redo walk
  // applies changes forward and searches nothing, so its text is not counted.
  let inputBytes = 0;
  for (const [, length] of chunkLengths) inputBytes += length;
  const rawHistory = data.history;
  const undo =
    typeof rawHistory === "object" && rawHistory !== null
      ? (rawHistory as Record<string, unknown>).undo
      : undefined;
  if (Array.isArray(undo)) {
    for (const entry of undo) {
      const changes = (entry as Record<string, unknown> | null)?.changes;
      if (!Array.isArray(changes)) continue;
      for (const change of changes) {
        if (!isTuple(change)) continue;
        const removedText = change[0] === "r" ? change[3] : change[0] === "d" ? change[2] : "";
        if (typeof removedText === "string") inputBytes += utf8ByteLength(removedText);
      }
    }
  }
  const chunks: LoadedChunkBytes = {
    indices: [...chunkBase64.keys()].sort((a, b) => a - b),
    bytes,
    budget: {
      remaining: SEARCH_WORK_PER_BYTE * inputBytes + SEARCH_WORK_FLOOR,
    },
  };

  // Chunk index of each chunk piece, or null for other pieces.
  const chunkOf = pieces.map((piece) => (piece[1] === "c" && isInt(piece[4]) ? piece[4] : null));
  // Chunk index of the nearest chunk piece after each piece, filled in one
  // reverse pass so each add piece finds it in O(1).
  const nextChunkAfter: (number | null)[] = Array.from({
    length: pieces.length,
  });
  for (let i = pieces.length - 1, next: number | null = null; i >= 0; i--) {
    nextChunkAfter[i] = next;
    next = chunkOf[i] ?? next;
  }
  const keys: number[] = [];
  const migratedPieces: WireTuple[] = [];
  let previousChunk = -1;
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i]!;
    const chunk = chunkOf[i];
    // The stand-in documents below need keys in document order, which a
    // chunk piece with a bad index or out of order breaks. Leave those to the
    // validators, which report MALFORMED or CHUNK_ORDER.
    if (piece[1] === "c" && (chunk === null || chunk === undefined || chunk < 0)) return data;
    if (chunk !== null && chunk !== undefined) {
      previousChunk = chunk;
      keys.push(chunk - 1);
      migratedPieces.push(piece);
    } else if (piece[1] === "a") {
      const nextChunk = nextChunkAfter[i];
      // Inside a chunk (the same chunk continues after it), the chunk is not
      // wholly before the piece.
      const key =
        previousChunk === -1 ? -1 : nextChunk === previousChunk ? previousChunk - 1 : previousChunk;
      keys.push(key);
      migratedPieces.push(key === -1 ? piece : [...piece.slice(0, 4), key]);
    } else {
      keys.push(-1);
      migratedPieces.push(piece);
    }
    if (i > 0 && keys[i]! < keys[i - 1]!) return data;
  }

  // A piece tree with the derived keys, so anchoring uses the same `gapKey`
  // as live edits. Only lengths, keys and where chunk pieces start in their
  // chunks matter here: a piece that is not a chunk piece stands in as an add
  // piece carrying its key. Empty and malformed lengths are left out, as no
  // byte lies in them.
  const descriptors: PieceDescriptor[] = [];
  for (let i = 0; i < pieces.length; i++) {
    const [, , start, length] = pieces[i]!;
    if (!isInt(length) || length <= 0) continue;
    const chunkIndex = chunkOf[i];
    descriptors.push(
      chunkIndex !== null && chunkIndex !== undefined
        ? {
            id: pieceID(`m${i}`),
            bufferType: "chunk",
            chunkIndex,
            start: byteOffset(isInt(start) ? Math.max(0, start) : 0),
            length: byteLength(length),
          }
        : {
            id: pieceID(`m${i}`),
            bufferType: "add",
            afterChunk: keys[i]!,
            start: byteOffset(0),
            length: byteLength(length),
          },
    );
  }

  const root = buildPieceTree(descriptors);
  // Only the tree structure and keys are read, so the tree holds no bytes.
  const captured: PieceTableState = {
    ...createEmptyPieceTableState(),
    root,
    totalLength: root?.subtreeLength ?? 0,
    // Every chunk named by a piece or held as loaded, so their keys fit.
    nextExpectedChunk: Math.max(
      chunkOf.reduce<number>((next, chunk) => Math.max(next, (chunk ?? -1) + 1), 0),
      (chunks.indices.at(-1) ?? -1) + 1,
    ),
  };
  // The same tree as live anchoring, so each anchor costs O(log C).
  const loaded = buildLoadedChunks(chunkLengths);
  const anchorWith = (offset: number, key: number): [number, number] => [
    offset - loadedSumAtOrBelow(loaded, key),
    key,
  ];
  // Version 1 kept text next to the content before it, as `"before"` does.
  const anchor = (doc: PieceTableState, offset: unknown, side: GapSide): [unknown, number] =>
    isInt(offset) ? anchorWith(offset, gapKey(doc.root, offset, side)) : [offset, -1];

  const migrateSelection = (raw: unknown, doc: PieceTableState): unknown => {
    if (typeof raw !== "object" || raw === null) return raw;
    const selection = raw as Record<string, unknown>;
    if (!Array.isArray(selection.ranges)) return raw;
    return {
      ...selection,
      ranges: selection.ranges.map((range: unknown) => {
        if (!isTuple(range)) return range;
        // Each endpoint takes the side a live selection gives it (see
        // `endpointSides`). Malformed offsets are kept for restore to report.
        const [anchorSide, headSide] =
          isInt(range[0]) && isInt(range[1])
            ? endpointSides(range[0], range[1])
            : (["before", "before"] as const);
        const [anchorPos, anchorKey] = anchor(doc, range[0], anchorSide);
        const [headPos, headKey] = anchor(doc, range[1], headSide);
        return anchorKey === -1 && headKey === -1
          ? [anchorPos, headPos]
          : [anchorPos, headPos, anchorKey, headKey];
      }),
    };
  };

  // Each version 1 offset is a resident offset in the document its change or
  // selection applied to, which edits since then have changed. Read in the
  // captured tree, an older offset would take the key of whatever text sits
  // there now. Instead, follow the document back through the undo stack and
  // forward through the redo stack, and key each offset in its own document.
  // Inserted bytes only stand in for their length and key.
  const shapeOf = (raw: unknown): ChangeShape | null => {
    if (!isTuple(raw) || !isInt(raw[1])) return null;
    const text = (value: unknown) => (typeof value === "string" ? value : "");
    const length = (value: unknown) => utf8ByteLength(text(value));
    switch (raw[0]) {
      case "i":
        return {
          offset: raw[1],
          removed: 0,
          inserted: length(raw[2]),
          removedText: "",
        };
      case "d":
        return {
          offset: raw[1],
          removed: length(raw[2]),
          inserted: 0,
          removedText: text(raw[2]),
        };
      case "r":
        return {
          offset: raw[1],
          removed: length(raw[3]),
          inserted: length(raw[2]),
          removedText: text(raw[3]),
        };
      default:
        return null;
    }
  };
  const migrateChange = (raw: unknown, key: number): unknown => {
    if (!isTuple(raw) || !isInt(raw[1])) return raw;
    const [position] = anchorWith(raw[1], key);
    const head = [raw[0], position, ...raw.slice(2, raw[0] === "r" ? 4 : 3)];
    return key === -1 ? head : [...head, key];
  };
  /**
   * A change whose removed bytes span several keys, split as `applyEdit`
   * records it, so undo gives every byte back its key: one delete per run
   * after the first, right to left, then the change itself over the first
   * run. A run whose text does not encode back to its bytes, where a run
   * edge cuts a character, keeps the bytes as well.
   */
  const splitChange = (raw: WireTuple, runs: readonly KeyRun[]): unknown[] => {
    const runText = runTexts(raw[0] === "r" ? raw[3] : raw[2], runs);
    const base = runs[0]!.start;
    const changes: unknown[] = [];
    for (let r = runs.length - 1; r >= 1; r--) {
      const run = runs[r]!;
      const [text, bytes] = runText(run);
      const [position] = anchorWith(run.start, run.key);
      changes.push(["d", position, text, run.key, ...(bytes === undefined ? [] : [bytes])]);
    }
    const { key } = runs[0]!;
    const [position] = anchorWith(base, key);
    const [text, bytes] = runText(runs[0]!);
    changes.push(
      raw[0] === "r"
        ? ["r", position, raw[2], text, key, ...(bytes === undefined ? [] : [null, bytes])]
        : ["d", position, text, key, ...(bytes === undefined ? [] : [bytes])],
    );
    return changes;
  };
  /** Inserts of `text` split into `runs`, left to right. */
  const insertChanges = (text: unknown, runs: readonly KeyRun[]): unknown[] => {
    const runText = runTexts(text, runs);
    return runs.map((run) => {
      const [position] = anchorWith(run.start, run.key);
      const [part, bytes] = runText(run);
      return ["i", position, part, run.key, ...(bytes === undefined ? [] : [bytes])];
    });
  };
  /**
   * The version 2 changes for version 1 change `raw`, given the runs its
   * inserted text (`inserts`) and its removed bytes (`runs`) split into, and
   * `key`, the key of a change with neither. One change has one key, so
   * inserted text that spans keys becomes one insert per run, after deletes
   * of the removed runs. So does a replace whose inserted text takes another
   * key than its first removed run.
   */
  const keyedChanges = (
    raw: WireTuple,
    key: number,
    inserts: readonly KeyRun[],
    runs: readonly KeyRun[],
  ): unknown[] => {
    const insertKey = inserts[0]?.key ?? key;
    if (inserts.length > 1 || (raw[0] === "r" && runs.length > 0 && runs[0]!.key !== insertKey)) {
      const deletes = runs.length === 0 ? [] : splitChange(["d", raw[1], raw[3]], runs);
      return [...deletes, ...insertChanges(raw[2], inserts)];
    }
    if (runs.length === 0) return [migrateChange(raw, insertKey)];
    return runs.length > 1 ? splitChange(raw, runs) : [migrateChange(raw, runs[0]!.key)];
  };
  /**
   * Migrate one entry. `doc` is the document on the side the walk starts
   * from: after the entry for undo, before it for redo. Returns the migrated
   * entry and the document on the other side.
   */
  const migrateEntry = (
    raw: unknown,
    doc: PieceTableState,
    direction: "undo" | "redo",
  ): [unknown, PieceTableState] => {
    if (typeof raw !== "object" || raw === null) return [raw, doc];
    const entry = raw as Record<string, unknown>;
    const rawChanges = Array.isArray(entry.changes) ? entry.changes : [];
    // The wire changes each version 1 change becomes, in order.
    const changes: unknown[][] = Array.from({ length: rawChanges.length });
    const start = doc;
    let current = doc;
    // Undo replays an entry's changes last to first, redo first to last.
    for (let n = 0; n < rawChanges.length; n++) {
      const i = direction === "undo" ? rawChanges.length - 1 - n : n;
      const change = rawChanges[i];
      const shape = shapeOf(change);
      if (shape === null) {
        changes[i] = [change];
      } else {
        let key: number;
        let inserts: readonly KeyRun[];
        let runs: readonly KeyRun[];
        if (direction === "undo") {
          ({ key, inserts, runs, before: current } = unapplyShape(current, shape, chunks));
        } else {
          ({ key, runs, after: current } = applyShape(current, shape));
          const { offset, inserted } = shape;
          inserts = inserted > 0 ? [{ start: offset, end: offset + inserted, key }] : [];
        }
        changes[i] = keyedChanges(change as WireTuple, key, inserts, runs);
      }
    }
    const [before, after] = direction === "undo" ? [current, start] : [start, current];
    return [
      {
        ...entry,
        changes: Array.isArray(entry.changes) ? changes.flat() : entry.changes,
        selectionBefore: migrateSelection(entry.selectionBefore, before),
        selectionAfter: migrateSelection(entry.selectionAfter, after),
      },
      current,
    ];
  };
  // Stacks are stored oldest first, so the newest undo entry and the next
  // redo entry are both last.
  const migrateStack = (raw: unknown, direction: "undo" | "redo"): unknown => {
    if (!Array.isArray(raw)) return raw;
    const migrated: unknown[] = Array.from({ length: raw.length });
    let doc = captured;
    for (let i = raw.length - 1; i >= 0; i--) {
      [migrated[i], doc] = migrateEntry(raw[i], doc, direction);
    }
    return migrated;
  };

  let history = data.history;
  if (typeof history === "object" && history !== null) {
    const source = history as Record<string, unknown>;
    history = {
      ...source,
      undo: migrateStack(source.undo, "undo"),
      redo: migrateStack(source.redo, "redo"),
    };
  }

  return { ...data, pieceTable: { ...table, pieces: migratedPieces }, history };
}

/**
 * The shipped migration registry, ordered by `from`.
 *
 * Append a step here when bumping `CHECKPOINT_VERSION` so `migrationPath` can
 * route older data.
 */
export const CHECKPOINT_MIGRATIONS: readonly CheckpointMigration[] = Object.freeze([
  Object.freeze({ from: 1, to: 2, migrate: migrateV1ToV2 }),
]);

/**
 * The lowest version this build can bring forward.
 *
 * An empty registry supports only the current version. Adding migration steps
 * extends the supported version range automatically.
 */
export function minimumSupportedVersion(
  registry: readonly CheckpointMigration[] = CHECKPOINT_MIGRATIONS,
  target: number = CHECKPOINT_VERSION,
): number {
  let lowest = target;
  // Walk backwards while a step exists that lands on the current lowest version.
  for (;;) {
    const step = registry.find((migration) => migration.to === lowest);
    if (step === undefined || step.from >= lowest) return lowest;
    lowest = step.from;
  }
}

/**
 * Resolve the chain of steps from `from` to `target`, or `null` when no
 * complete path exists.
 */
export function migrationPath(
  from: number,
  target: number = CHECKPOINT_VERSION,
  registry: readonly CheckpointMigration[] = CHECKPOINT_MIGRATIONS,
): CheckpointMigration[] | null {
  if (from === target) return [];
  // Downgrades are refused outright rather than attempted lossily.
  if (from > target) return null;

  const path: CheckpointMigration[] = [];
  let version = from;
  while (version < target) {
    const step = registry.find((migration) => migration.from === version);
    // A step that does not advance would loop forever.
    if (step === undefined || step.to <= version) return null;
    path.push(step);
    version = step.to;
  }

  return version === target ? path : null;
}

/**
 * Migrate raw checkpoint data to the current version.
 * Throw `CheckpointError('VERSION_UNSUPPORTED')` when no migration path exists.
 * This preserves the error code used for unsupported versions before migration.
 */
export function migrateCheckpointData(
  data: CheckpointWireData,
  fromVersion: number,
  target: number = CHECKPOINT_VERSION,
  registry: readonly CheckpointMigration[] = CHECKPOINT_MIGRATIONS,
): {
  readonly data: CheckpointWireData;
  readonly applied: readonly CheckpointMigration[];
} {
  const path = migrationPath(fromVersion, target, registry);

  if (path === null) {
    const lowest = minimumSupportedVersion(registry, target);
    const window = lowest === target ? `${target}` : `${lowest}-${target}`;
    throw new CheckpointError(
      "VERSION_UNSUPPORTED",
      `checkpoint version ${fromVersion} is unsupported; this build reads version ${window}`,
    );
  }

  let current = data;
  for (const step of path) {
    // Each step receives a fresh shallow copy, so a step that mutates in place
    // cannot corrupt the caller's object or an earlier step's output.
    const next = step.migrate({ ...current });
    current = { ...next, version: step.to };
  }

  return { data: current, applied: path };
}
