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
import { base64DecodedLength, decodeBase64, encodeBase64 } from "../core/base64.js";
import type { GapSide, KeyRun } from "../core/chunk-anchor.js";
import {
  buildLoadedChunks,
  byteKey,
  gapKey,
  keyFitsAt,
  loadedSumAtOrBelow,
  placementRuns,
} from "../core/chunk-anchor.js";
import { contentDecoder, encodesTo, textEncoder, utf8ByteLength } from "../core/encoding.js";
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
 * key that does not fit there throws, as `pieceTableInsert` does, and the
 * migration reports the payload as malformed.
 */
function insertStandIn(
  doc: PieceTableState,
  offset: number,
  length: number,
  key: number,
): PieceTableState {
  if (length <= 0) return doc;
  const at = clampTo(doc, offset);
  if (!keyFitsAt(doc, at, key)) {
    throw new RangeError(`placement key ${key} does not fit at offset ${at}`);
  }
  return pieceTableInsertPlaceholder(doc, at, length, key);
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
 * Where `needle` lies in `haystack[from, to)`: the first place, or with
 * `last` the last place, or -1 when it is not there. A plain scan: it runs
 * once per migrated change, over at most one chunk.
 */
function indexIn(
  haystack: Uint8Array,
  needle: Uint8Array,
  from: number,
  to: number,
  last: boolean,
) {
  const n = needle.length;
  for (let k = 0; k <= to - from - n; k++) {
    const at = last ? to - n - k : from + k;
    if (sharedPrefix(needle, 0, haystack, at, n) === n) return at;
  }
  return -1;
}

/**
 * The text of each of `runs`, which split the UTF-8 bytes of `text` from the
 * first run's start, with the bytes as well where a run edge cuts a character.
 */
function runTexts(text: unknown, runs: readonly KeyRun[]) {
  const all = textEncoder.encode(typeof text === "string" ? text : "");
  const base = runs[0]?.start ?? 0;
  return (run: KeyRun): [string] | [string, string] => {
    const bytes = all.subarray(run.start - base, run.end - base);
    const decoded = contentDecoder.decode(bytes);
    return encodesTo(decoded, bytes) ? [decoded] : [decoded, encodeBase64(bytes)];
  };
}

/** The bytes of a loaded chunk, or undefined when the checkpoint does not hold them. */
type ChunkBytes = (chunk: number) => Uint8Array | undefined;

/** Bytes [start, start + length) of chunk `chunk`. */
interface ChunkRun {
  readonly chunk: number;
  readonly start: number;
  readonly length: number;
}

/**
 * Which chunks the bytes `removed` came from, for the gap at `offset` in
 * `doc`, the document without them.
 *
 * A chunk piece that ends at the gap before the end of its chunk, or starts
 * at it after the start of its chunk, lost bytes there. Removed bytes that
 * begin with the bytes the first lost are its (`tail`), and removed bytes
 * that end with the bytes the second lost are its (`head`). Bytes between
 * them that an older edit, not yet given back, kept apart from the piece are
 * looked for in the rest of what it lost (`middle`). When they are not
 * there, `inside` is the key of such a chunk, which they most likely came from.
 */
function removedSources(
  doc: PieceTableState,
  offset: number,
  removed: Uint8Array,
  chunkBytes: ChunkBytes,
): {
  tail: ChunkRun | null;
  middle: ChunkRun | null;
  head: ChunkRun | null;
  inside: number | undefined;
} {
  const before = offset > 0 ? pieceAt(doc.root, offset - 1) : null;
  const after = pieceAt(doc.root, offset);
  const none = { tail: null, middle: null, head: null, inside: undefined };
  // Inside a piece, nothing was lost at the gap.
  if (before !== null && after !== null && before.node === after.node) return none;
  const leftNode =
    before !== null &&
    before.node.bufferType === "chunk" &&
    before.pieceStart + before.node.length === offset
      ? before.node
      : null;
  const rightNode = after !== null && after.node.bufferType === "chunk" ? after.node : null;
  const leftBytes = leftNode === null ? undefined : chunkBytes(leftNode.chunkIndex);
  const rightBytes = rightNode === null ? undefined : chunkBytes(rightNode.chunkIndex);
  // Where each neighbor lost bytes. Two pieces of one chunk lost only the
  // bytes between them.
  const sameChunk = leftNode !== null && leftNode.chunkIndex === rightNode?.chunkIndex;
  const left =
    leftNode !== null && leftBytes !== undefined
      ? {
          chunk: leftNode.chunkIndex,
          bytes: leftBytes,
          from: leftNode.start + leftNode.length,
          to: sameChunk ? rightNode!.start : leftBytes.length,
        }
      : null;
  const right =
    rightNode !== null && rightBytes !== undefined && rightNode.start <= rightBytes.length
      ? {
          chunk: rightNode.chunkIndex,
          bytes: rightBytes,
          from: sameChunk ? leftNode!.start + leftNode!.length : 0,
          to: rightNode.start,
        }
      : null;
  const lostLeft = left !== null && left.from < left.to ? left : null;
  const lostRight = right !== null && right.from < right.to ? right : null;
  if (lostLeft === null && lostRight === null) return none;

  let start = 0;
  let end = removed.length;
  let tail: ChunkRun | null = null;
  let head: ChunkRun | null = null;
  if (lostLeft !== null) {
    const length = sharedPrefix(
      removed,
      0,
      lostLeft.bytes,
      lostLeft.from,
      Math.min(end, lostLeft.to - lostLeft.from),
    );
    if (length > 0) {
      tail = { chunk: lostLeft.chunk, start: lostLeft.from, length };
      start = length;
    }
  }
  if (lostRight !== null) {
    const room = Math.min(
      end - start,
      lostRight.to - (sameChunk ? lostRight.from + start : lostRight.from),
    );
    const length = sharedSuffix(removed, end, lostRight.bytes, lostRight.to, room);
    if (length > 0) {
      head = { chunk: lostRight.chunk, start: lostRight.to - length, length };
      end -= length;
    }
  }
  let middle: ChunkRun | null = null;
  if (end > start) {
    const rest = removed.subarray(start, end);
    for (const lost of [lostLeft, lostRight]) {
      if (lost === null || middle !== null) continue;
      const from = lost === lostLeft ? lost.from + start : lost.from;
      const to = lost === lostRight ? lost.to - (removed.length - end) : lost.to;
      const at = indexIn(lost.bytes, rest, from, to, lost === lostRight);
      if (at >= 0) middle = { chunk: lost.chunk, start: at, length: rest.length };
    }
  }
  const inside = (lostLeft ?? lostRight)!.chunk - 1;
  return { tail, middle, head, inside };
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
 * recorded. Bytes found in a chunk that lost them at the gap (see
 * `removedSources`) come back as that chunk's bytes with its key, so later
 * steps of the walk see the chunk whole again. Other removed bytes take the
 * key of such a chunk, else the key the inserted text had, else the key of
 * the gap.
 */
function unapplyShape(
  after: PieceTableState,
  shape: ChangeShape,
  chunkBytes: ChunkBytes,
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
  const fitting = (doc: PieceTableState, position: number, ...keys: (number | undefined)[]) =>
    keys.find((key) => key !== undefined && keyFitsAt(doc, position, key)) ??
    gapKey(doc.root, position, "before");
  const key = fitting(without, at, insertedKey);
  if (removed <= 0) return { key, inserts, runs: [], before: without };

  const { tail, middle, head, inside } = removedSources(
    without,
    at,
    textEncoder.encode(shape.removedText),
    chunkBytes,
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
  if (tail !== null) giveBack(tail.length, tail.chunk - 1, tail);
  const rest = removed - (tail?.length ?? 0) - (head?.length ?? 0);
  if (middle !== null) giveBack(rest, middle.chunk - 1, middle);
  else giveBack(rest, fitting(doc, position, inside, insertedKey), null);
  if (head !== null) giveBack(head.length, head.chunk - 1, head);
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
 * Documents without chunk pieces need no change: every key is -1 and every
 * anchor equals its offset. Malformed input is returned as is for the
 * validators to report.
 */
function migrateV1ToV2(data: CheckpointWireData): CheckpointWireData {
  const pieceTable = data.pieceTable;
  if (typeof pieceTable !== "object" || pieceTable === null) return data;
  const table = pieceTable as Record<string, unknown>;
  const rawPieces = table.pieces;
  if (!Array.isArray(rawPieces) || !rawPieces.every(isTuple)) return data;
  const pieces = rawPieces as readonly WireTuple[];
  if (!pieces.some((piece) => piece[1] === "c")) return data;

  // Chunk index of each chunk piece, or null for other pieces.
  const chunkOf = pieces.map((piece) => (piece[1] === "c" && isInt(piece[4]) ? piece[4] : null));
  // Chunk index of the nearest chunk piece after each piece, filled in one
  // reverse pass so each add piece finds it in O(1).
  const nextChunkAfter: (number | null)[] = Array.from({ length: pieces.length });
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
  // Decoded only for chunks next to bytes that undo gives back.
  const decoded = new Map<number, Uint8Array | undefined>();
  const chunkBytes: ChunkBytes = (chunk) => {
    if (!decoded.has(chunk)) {
      const base64 = chunkBase64.get(chunk);
      let bytes: Uint8Array | undefined;
      try {
        bytes = base64 === undefined ? undefined : decodeBase64(base64);
      } catch {
        // Malformed chunk data, which restore reports.
      }
      decoded.set(chunk, bytes);
    }
    return decoded.get(chunk);
  };

  const root = buildPieceTree(descriptors);
  // Only the tree structure and keys are read, so the tree holds no bytes.
  const captured: PieceTableState = {
    ...createEmptyPieceTableState(),
    root,
    totalLength: root?.subtreeLength ?? 0,
    nextExpectedChunk: chunkOf.reduce<number>(
      (next, chunk) => Math.max(next, (chunk ?? -1) + 1),
      0,
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
        return { offset: raw[1], removed: 0, inserted: length(raw[2]), removedText: "" };
      case "d":
        return { offset: raw[1], removed: length(raw[2]), inserted: 0, removedText: text(raw[2]) };
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
          ({ key, inserts, runs, before: current } = unapplyShape(current, shape, chunkBytes));
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
): { readonly data: CheckpointWireData; readonly applied: readonly CheckpointMigration[] } {
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
