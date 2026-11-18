/**
 * Capture and restore document state as JSON-safe checkpoints.
 *
 * `getSnapshot()` returns an in-memory `DocumentState`. A checkpoint stores
 * that state as JSON-safe data without replaying edits on restore. Capture
 * requires an eager state, and restore returns one with all line offsets resolved.
 *
 * Trees are stored as flat in-order lists and rebuilt with the balanced
 * bulk-loaders in `core/state.ts`. Piece IDs are preserved so attention points
 * continue to resolve across changes to tree shape.
 *
 * Restore validates structural invariants before assembling a state. Invalid
 * payloads raise `CheckpointError`.
 */

import type {
  DocumentState,
  PieceTableState,
  LineIndexState,
  SelectionState,
  SelectionRange,
  HistoryState,
  HistoryEntry,
  HistoryChange,
  HistorySelectionRange,
  HistorySelectionState,
  DocumentMetadata,
  ChunkMetadata,
} from "../../types/state.js";
import { HISTORY_EVICTION_POLICIES, pstackFromArray } from "../../types/state.js";
import type { NonEmptyReadonlyArray } from "../../types/utils.js";
import type { AttentionLayerState, Attention } from "../../types/attention.js";
import type { PieceID, AttentionID, ReadonlyUint8Array } from "../../types/branded.js";
import { byteOffset, byteLength, pieceID, attentionID } from "../../types/branded.js";
import type {
  CheckpointEnvelope,
  CheckpointRestoreOptions,
  CheckpointErrorCode,
} from "../../types/checkpoint.js";
import { CHECKPOINT_FORMAT, CHECKPOINT_VERSION, CheckpointError } from "../../types/checkpoint.js";
import {
  isInt,
  migrateCheckpointData,
  migrationPath,
  minimumSupportedVersion,
} from "./checkpoint-migrate.js";
import type { PieceDescriptor, LineDescriptor } from "../core/state.js";
import {
  buildPieceTree,
  buildLineIndexTree,
  freezePieceTableState,
  freezeLineIndexState,
} from "../core/state.js";
import { base64DecodedLength, decodeBase64 } from "../core/base64.js";
import { inOrderPieces } from "../core/piece-table-stream.js";
import { decodedCharLength, joinDecoded, type DecodedSummary } from "../core/decoded-metrics.js";
import { utf8ByteLength } from "../core/encoding.js";
import { loadedLengthAtOrBelow } from "../core/chunk-anchor.js";
import { pieceTableDelete, pieceTableInsertPlaceholder } from "../core/piece-table.js";
import { changeReplayFailure, selectionRange } from "./history-anchor.js";
import { insertedLength, removedLength } from "./history-entry.js";
import { GrowableBuffer } from "../core/growable-buffer.js";
import {
  asReadonlyMap,
  asReadonlyUint8Array,
  unwrapReadonlyUint8Array,
} from "../core/runtime-readonly.js";

export { createCheckpoint, encodeCheckpoint } from "./checkpoint-capture.js";

// =============================================================================
// Errors
// =============================================================================

function fail(code: CheckpointErrorCode, message: string): never {
  throw new CheckpointError(code, message);
}

interface RestoreLimits {
  readonly maxJsonLength: number;
  readonly maxBufferBytes: number;
  readonly maxPieces: number;
  readonly maxLines: number;
  readonly maxHistoryEntries: number;
  readonly maxAttentions: number;
  readonly maxCollectionItems: number;
  readonly maxStringCodeUnits: number;
}

interface RestoreBudget {
  readonly limits: RestoreLimits;
  remainingBufferBytes: number;
  remainingCollectionItems: number;
  remainingStringCodeUnits: number;
}

const UNLIMITED_RESTORE_RESOURCE = Number.MAX_SAFE_INTEGER;

function readRestoreLimit(value: number | undefined, what: string): number {
  if (value === undefined) return UNLIMITED_RESTORE_RESOURCE;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${what} must be a non-negative safe integer`);
  }
  return value;
}

function normalizeRestoreOptions(options: CheckpointRestoreOptions): RestoreLimits {
  return {
    maxJsonLength: readRestoreLimit(options.maxJsonLength, "maxJsonLength"),
    maxBufferBytes: readRestoreLimit(options.maxBufferBytes, "maxBufferBytes"),
    maxPieces: readRestoreLimit(options.maxPieces, "maxPieces"),
    maxLines: readRestoreLimit(options.maxLines, "maxLines"),
    maxHistoryEntries: readRestoreLimit(options.maxHistoryEntries, "maxHistoryEntries"),
    maxAttentions: readRestoreLimit(options.maxAttentions, "maxAttentions"),
    maxCollectionItems: readRestoreLimit(options.maxCollectionItems, "maxCollectionItems"),
    maxStringCodeUnits: readRestoreLimit(options.maxStringCodeUnits, "maxStringCodeUnits"),
  };
}

function assertResourceLimit(actual: number, limit: number, what: string): void {
  if (actual > limit) {
    fail("RESOURCE_LIMIT", `${what} ${actual} exceeds the configured limit of ${limit}`);
  }
}

/**
 * Check the collections a migration walks before it runs.
 *
 * Migration copies, sorts, and searches raw wire data, decodes chunk data, and
 * encodes change text, so untrusted input must meet the restore limits first.
 * The checks here cover only what the migration reads, which validation counts
 * as well, so they never reject a payload that validation would accept:
 *
 * - Validation reads every array counted here.
 * - Validation reads and decodes the chunk strings as they are.
 * - Migration keeps a change's text, or splits it into runs whose texts are
 *   together at least as long: a run edge inside a character decodes to a
 *   replacement character on each side, and keeps the bytes as well.
 *
 * Validation repeats the full check.
 */
function assertMigrationLimits(source: Record<string, unknown>, limits: RestoreLimits): void {
  const length = (value: unknown): number => (Array.isArray(value) ? value.length : 0);
  const section = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const units = (value: unknown): number => (typeof value === "string" ? value.length : 0);
  const pieceTable = section(source.pieceTable);
  const history = section(source.history);
  assertResourceLimit(length(pieceTable.pieces), limits.maxPieces, "pieceTable.pieces");
  assertResourceLimit(
    length(history.undo) + length(history.redo),
    limits.maxHistoryEntries,
    "history entries",
  );
  // The entry count is bounded above, so this walk is too.
  let items = length(pieceTable.pieces) + length(pieceTable.chunks);
  let codeUnits = 0;
  let decodedBytes = 0;
  if (Array.isArray(pieceTable.chunks)) {
    for (const chunk of pieceTable.chunks) {
      if (!Array.isArray(chunk) || typeof chunk[1] !== "string") continue;
      codeUnits += chunk[1].length;
      decodedBytes += decodedLengthBound(chunk[1]);
    }
  }
  for (const entries of [history.undo, history.redo]) {
    if (!Array.isArray(entries)) continue;
    for (const raw of entries) {
      const entry = section(raw);
      items +=
        length(entry.changes) +
        length(section(entry.selectionBefore).ranges) +
        length(section(entry.selectionAfter).ranges);
      if (!Array.isArray(entry.changes)) continue;
      // The texts a version 1 change holds: inserted text, then a replace's old text.
      for (const change of entry.changes) {
        if (!Array.isArray(change)) continue;
        codeUnits += units(change[2]) + (change[0] === "r" ? units(change[3]) : 0);
      }
    }
  }
  assertResourceLimit(items, limits.maxCollectionItems, "checkpoint collection items");
  assertResourceLimit(codeUnits, limits.maxStringCodeUnits, "checkpoint string code units");
  assertResourceLimit(decodedBytes, limits.maxBufferBytes, "pieceTable.chunks decoded bytes");
}

function createRestoreBudget(limits: RestoreLimits): RestoreBudget {
  return {
    limits,
    remainingBufferBytes: limits.maxBufferBytes,
    remainingCollectionItems: limits.maxCollectionItems,
    remainingStringCodeUnits: limits.maxStringCodeUnits,
  };
}

function consumeRestoreBudget(
  budget: RestoreBudget,
  remaining: "remainingCollectionItems" | "remainingStringCodeUnits",
  amount: number,
  what: string,
): void {
  assertResourceLimit(amount, budget[remaining], what);
  budget[remaining] -= amount;
}

// =============================================================================
// Read and validate untrusted JSON one field at a time.
// =============================================================================

function readObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("MALFORMED", `${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readArray(value: unknown, what: string, budget: RestoreBudget): readonly unknown[] {
  if (!Array.isArray(value)) {
    fail("MALFORMED", `${what} must be an array`);
  }
  consumeRestoreBudget(budget, "remainingCollectionItems", value.length, `${what} array elements`);
  return value;
}

function readString(value: unknown, what: string, budget: RestoreBudget): string {
  if (typeof value !== "string") {
    fail("MALFORMED", `${what} must be a string`);
  }
  consumeRestoreBudget(
    budget,
    "remainingStringCodeUnits",
    value.length,
    `${what} string code units`,
  );
  return value;
}

function readBoolean(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") {
    fail("MALFORMED", `${what} must be a boolean`);
  }
  return value;
}

/** Validate a safe integer no smaller than `min`. `expected` words the error. */
function readInteger(
  value: unknown,
  what: string,
  min: number = Number.MIN_SAFE_INTEGER,
  expected = `a safe integer of at least ${min}`,
): number {
  if (!isInt(value) || value < min) {
    fail("MALFORMED", `${what} must be ${expected}`);
  }
  return value;
}

/**
 * Validate a non-negative safe integer for an offset, length, or count,
 * worded as the spec's error messages are.
 */
function readCount(value: unknown, what: string): number {
  return readInteger(value, what, 0, "a non-negative safe integer");
}

/** Read an optional chunk placement key (>= -1), defaulting to -1. */
function readPlacementKey(value: unknown, what: string): number {
  return value === undefined ? -1 : readInteger(value, what, -1);
}

function readFiniteNumber(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("MALFORMED", `${what} must be a finite number`);
  }
  return value;
}

function readEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  what: string,
  budget: RestoreBudget,
): T {
  const stringValue = readString(value, what, budget);
  if (!allowed.includes(stringValue as T)) {
    fail("MALFORMED", `${what} must be one of ${allowed.join(", ")}`);
  }
  return stringValue as T;
}

function readOptionalString(
  value: unknown,
  what: string,
  budget: RestoreBudget,
): string | undefined {
  return value === undefined ? undefined : readString(value, what, budget);
}

/**
 * The decoded length of `base64`, checked against limits before decoding.
 * decodeBase64 rejects a length that is not a multiple of four, but the limit
 * is checked first, so that case rounds up.
 */
function decodedLengthBound(base64: string): number {
  return base64.length % 4 === 0 ? base64DecodedLength(base64) : Math.ceil(base64.length / 4) * 3;
}

function readBytes(value: unknown, what: string, budget: RestoreBudget): Uint8Array {
  const base64 = readString(value, what, budget);
  const decodedLength = decodedLengthBound(base64);
  assertResourceLimit(decodedLength, budget.remainingBufferBytes, `${what} decoded bytes`);
  try {
    const bytes = decodeBase64(base64);
    assertResourceLimit(bytes.length, budget.remainingBufferBytes, `${what} decoded bytes`);
    budget.remainingBufferBytes -= bytes.length;
    return bytes;
  } catch (error) {
    if (error instanceof CheckpointError) throw error;
    fail("MALFORMED", `${what} is not valid base64: ${(error as Error).message}`);
  }
}

/**
 * Highest `n` among ids shaped `<prefix><n>`, or -1 when none match.
 * Ids from other sources are opaque and do not constrain the allocator.
 */
function maxNumericSuffix(ids: Iterable<string>, prefix: string): number {
  let max = -1;
  for (const id of ids) {
    if (!id.startsWith(prefix)) continue;
    const suffix = id.slice(prefix.length);
    if (!/^\d+$/.test(suffix)) continue;
    max = Math.max(max, Number(suffix));
  }
  return max;
}

// =============================================================================
// Restore
// =============================================================================

function restorePieces(
  raw: readonly unknown[],
  originalLength: number,
  addLength: number,
  chunkMap: Map<number, Uint8Array>,
  nextExpectedChunk: number,
  budget: RestoreBudget,
): { pieces: PieceDescriptor[]; totalLength: number; lengthByID: Map<PieceID, number> } {
  const pieces: PieceDescriptor[] = [];
  const lengthByID = new Map<PieceID, number>();
  let totalLength = 0;
  let lastChunkIndex = -1;
  // Placement keys never decrease in document order (see core/chunk-anchor.ts).
  let lastKey = -1;
  const checkKey = (key: number, what: string) => {
    if (key < lastKey) {
      fail(
        "CHUNK_ORDER",
        `${what} has placement key ${key} after ${lastKey}: keys must not decrease in document order`,
      );
    }
    lastKey = key;
  };

  for (let i = 0; i < raw.length; i++) {
    const what = `pieceTable.pieces[${i}]`;
    const tuple = readArray(raw[i], what, budget);
    const id = pieceID(readString(tuple[0], `${what}[0]`, budget));
    const tag = readEnum(tuple[1], ["o", "a", "c"] as const, `${what}[1]`, budget);
    const start = readCount(tuple[2], `${what}[2]`);
    const length = readCount(tuple[3], `${what}[3]`);

    if (length === 0) {
      fail("MALFORMED", `${what} has zero length: the piece table holds no empty pieces`);
    }
    if (lengthByID.has(id)) {
      fail("ID_COLLISION", `${what} repeats piece id ${id}`);
    }

    if (tag === "c") {
      const chunkIndex = readCount(tuple[4], `${what}[4]`);
      const chunk = chunkMap.get(chunkIndex);
      if (chunk === undefined) {
        fail(
          "CHUNK_MISSING",
          `${what} reads from chunk ${chunkIndex}, which is not in the payload`,
        );
      }
      if (start + length > chunk.length) {
        fail(
          "PIECE_OUT_OF_BOUNDS",
          `${what} covers [${start}, ${start + length}) of chunk ${chunkIndex}, which holds ${chunk.length} bytes`,
        );
      }
      // Invariants §1.4: chunk pieces appear in ascending chunkIndex order, which
      // loading relies on to place a re-loaded chunk.
      if (chunkIndex < lastChunkIndex) {
        fail(
          "CHUNK_ORDER",
          `${what} has chunkIndex ${chunkIndex} after ${lastChunkIndex}: chunk pieces must be in ascending order`,
        );
      }
      lastChunkIndex = chunkIndex;
      checkKey(chunkIndex - 1, what);
      pieces.push({
        id,
        bufferType: "chunk",
        start: byteOffset(start),
        length: byteLength(length),
        chunkIndex,
      });
    } else {
      const bufferType = tag === "a" ? "add" : "original";
      const bufferLength = tag === "a" ? addLength : originalLength;
      if (start + length > bufferLength) {
        fail(
          "PIECE_OUT_OF_BOUNDS",
          `${what} covers [${start}, ${start + length}) of the ${bufferType} buffer, which holds ${bufferLength} bytes`,
        );
      }
      if (tag === "a") {
        const afterChunk = readPlacementKey(tuple[4], `${what}[4]`);
        checkKey(afterChunk, what);
        // Text can only follow chunks that have been loaded. A higher key would
        // place the next sequentially streamed chunk on the wrong side of it.
        if (afterChunk >= nextExpectedChunk) {
          fail(
            "CHUNK_ORDER",
            `${what} has placement key ${afterChunk} but only chunks below ${nextExpectedChunk} have been loaded`,
          );
        }
        pieces.push({
          id,
          bufferType,
          start: byteOffset(start),
          length: byteLength(length),
          afterChunk,
        });
      } else {
        // Original bytes have key -1, so they cannot follow chunk text.
        checkKey(-1, what);
        pieces.push({ id, bufferType, start: byteOffset(start), length: byteLength(length) });
      }
    }

    lengthByID.set(id, length);
    totalLength += length;
  }

  return { pieces, totalLength, lengthByID };
}

function restorePieceTable(
  raw: unknown,
  budget: RestoreBudget,
): {
  pieceTable: PieceTableState;
  lengthByID: Map<PieceID, number>;
} {
  const source = readObject(raw, "pieceTable");
  const originalBuffer = readBytes(source.originalBuffer, "pieceTable.originalBuffer", budget);
  const addBytes = readBytes(source.addBuffer, "pieceTable.addBuffer", budget);
  const chunkSize = readCount(source.chunkSize, "pieceTable.chunkSize");
  const nextExpectedChunk = readCount(source.nextExpectedChunk, "pieceTable.nextExpectedChunk");
  const totalFileSize = readCount(source.totalFileSize, "pieceTable.totalFileSize");
  const expectedChunkCount =
    chunkSize > 0 && totalFileSize > 0 ? Math.ceil(totalFileSize / chunkSize) : undefined;

  const chunkMap = new Map<number, Uint8Array>();
  const rawChunks = readArray(source.chunks, "pieceTable.chunks", budget);
  let lastChunkIndex = -1;
  for (let i = 0; i < rawChunks.length; i++) {
    const what = `pieceTable.chunks[${i}]`;
    const tuple = readArray(rawChunks[i], what, budget);
    const chunkIndex = readCount(tuple[0], `${what}[0]`);
    if (chunkIndex <= lastChunkIndex) {
      fail("MALFORMED", `${what}[0] must be unique and strictly ascending`);
    }
    const bytes = readBytes(tuple[1], `${what}[1]`, budget);
    if (chunkSize === 0 || bytes.length === 0 || bytes.length > chunkSize) {
      fail("MALFORMED", `${what} has ${bytes.length} bytes but chunkSize is ${chunkSize}`);
    }
    if (expectedChunkCount !== undefined) {
      const expectedLength = Math.min(chunkSize, totalFileSize - chunkIndex * chunkSize);
      if (chunkIndex >= expectedChunkCount || bytes.length !== expectedLength) {
        fail("MALFORMED", `${what} is incompatible with the declared file geometry`);
      }
    }
    chunkMap.set(chunkIndex, bytes);
    lastChunkIndex = chunkIndex;
  }

  const chunkMetadata = new Map<number, ChunkMetadata>();
  const rawMetadata = readArray(source.chunkMetadata, "pieceTable.chunkMetadata", budget);
  let lastMetadataIndex = -1;
  for (let i = 0; i < rawMetadata.length; i++) {
    const what = `pieceTable.chunkMetadata[${i}]`;
    const tuple = readArray(rawMetadata[i], what, budget);
    const chunkIndex = readCount(tuple[0], `${what}[0]`);
    const byteLengthValue = readCount(tuple[1], `${what}[1]`);
    const lineCount = readCount(tuple[2], `${what}[2]`);
    if (chunkIndex <= lastMetadataIndex) {
      fail("MALFORMED", `${what}[0] must be unique and strictly ascending`);
    }
    if (chunkSize === 0 || byteLengthValue === 0 || byteLengthValue > chunkSize) {
      fail("MALFORMED", `${what}[1] is incompatible with chunkSize ${chunkSize}`);
    }
    if (expectedChunkCount !== undefined) {
      const expectedLength = Math.min(chunkSize, totalFileSize - chunkIndex * chunkSize);
      if (chunkIndex >= expectedChunkCount || byteLengthValue !== expectedLength) {
        fail("MALFORMED", `${what} is incompatible with the declared file geometry`);
      }
    }
    chunkMetadata.set(
      chunkIndex,
      Object.freeze({ chunkIndex, byteLength: byteLengthValue, lineCount }),
    );
    lastMetadataIndex = chunkIndex;
  }

  const loadedChunks = new Set<number>();
  const rawLoaded = readArray(source.loadedChunks, "pieceTable.loadedChunks", budget);
  let lastLoadedIndex = -1;
  for (let i = 0; i < rawLoaded.length; i++) {
    const chunkIndex = readCount(rawLoaded[i], `pieceTable.loadedChunks[${i}]`);
    if (chunkIndex <= lastLoadedIndex) {
      fail("MALFORMED", `pieceTable.loadedChunks[${i}] must be unique and strictly ascending`);
    }
    if (chunkSize === 0 || (expectedChunkCount !== undefined && chunkIndex >= expectedChunkCount)) {
      fail("MALFORMED", `pieceTable.loadedChunks[${i}] is outside the declared chunk geometry`);
    }
    loadedChunks.add(chunkIndex);
    lastLoadedIndex = chunkIndex;
  }

  if (
    chunkSize === 0 &&
    (chunkMap.size > 0 ||
      chunkMetadata.size > 0 ||
      loadedChunks.size > 0 ||
      nextExpectedChunk !== 0)
  ) {
    fail("MALFORMED", "non-chunked checkpoints cannot carry chunk runtime state");
  }

  for (const chunkIndex of chunkMap.keys()) {
    if (!loadedChunks.has(chunkIndex)) {
      fail(
        "MALFORMED",
        `pieceTable.chunks contains ${chunkIndex} but loadedChunks does not record it`,
      );
    }
    const metadata = chunkMetadata.get(chunkIndex);
    if (metadata !== undefined && metadata.byteLength !== chunkMap.get(chunkIndex)!.length) {
      fail("MALFORMED", `chunk ${chunkIndex} disagrees with its declared byteLength`);
    }
  }

  const expectedNextChunk = loadedChunks.size === 0 ? 0 : lastLoadedIndex + 1;
  if (nextExpectedChunk !== expectedNextChunk) {
    fail(
      "MALFORMED",
      `pieceTable.nextExpectedChunk is ${nextExpectedChunk} but loadedChunks requires ${expectedNextChunk}`,
    );
  }

  const rawPieces = readArray(source.pieces, "pieceTable.pieces", budget);
  assertResourceLimit(rawPieces.length, budget.limits.maxPieces, "pieceTable.pieces");
  const { pieces, totalLength, lengthByID } = restorePieces(
    rawPieces,
    originalBuffer.length,
    addBytes.length,
    chunkMap,
    nextExpectedChunk,
    budget,
  );

  const declaredLength = readCount(source.totalLength, "pieceTable.totalLength");
  if (declaredLength !== totalLength) {
    fail(
      "LENGTH_MISMATCH",
      `pieceTable.totalLength is ${declaredLength} but the pieces cover ${totalLength} bytes`,
    );
  }

  const nextPieceID = readCount(source.nextPieceID, "pieceTable.nextPieceID");
  const highestPieceID = maxNumericSuffix(lengthByID.keys(), "p");
  if (nextPieceID <= highestPieceID) {
    fail(
      "ID_COLLISION",
      `pieceTable.nextPieceID is ${nextPieceID} but piece p${highestPieceID} is already in use: the next edit would reuse a live identity`,
    );
  }

  const readonlyChunkMap = new Map<number, ReadonlyUint8Array>();
  for (const [chunkIndex, bytes] of chunkMap) {
    readonlyChunkMap.set(chunkIndex, asReadonlyUint8Array(bytes));
  }

  const pieceTable = freezePieceTableState({
    root: buildPieceTree(pieces),
    nextPieceID,
    originalBuffer: asReadonlyUint8Array(originalBuffer),
    addBuffer: new GrowableBuffer(addBytes, addBytes.length),
    totalLength,
    chunkMap: readonlyChunkMap,
    chunkSize,
    nextExpectedChunk,
    loadedChunks,
    chunkMetadata,
    totalFileSize,
  });

  return { pieceTable, lengthByID };
}

/** Validate line metrics against resident bytes without flattening the document. */
function validateLineContent(pieceTable: PieceTableState, lines: readonly LineDescriptor[]): void {
  // Count UTF-16 units arithmetically with the decoder's replacement rules,
  // keeping U+FEFF as content, in the same pass that finds line breaks. An
  // ASCII segment has one unit per byte and needs no counting. A code point
  // can span chunk pieces. joinDecoded corrects counts at seams
  // between non-ASCII segments. An ASCII byte ends any pending sequence, so it
  // also ends the seam. Decoding each line natively cost two TextDecoder
  // calls per line plus a separate scan.
  let lineIndex = 0;
  let lineBytes = 0;
  let lineChars = 0;
  let seam: DecodedSummary | null = null;
  let pendingCR = false;

  function consume(bytes: Uint8Array, start: number, end: number, ascii: boolean): void {
    if (start >= end) return;
    lineBytes += end - start;
    if (ascii) {
      lineChars += end - start;
      seam = null;
      return;
    }
    const segment: DecodedSummary = {
      length: end - start,
      chars: decodedCharLength(bytes, start, end),
      head: bytes.subarray(start, Math.min(start + 3, end)),
      tail: bytes.subarray(Math.max(start, end - 3), end),
    };
    if (seam) {
      const joined = joinDecoded(seam, segment);
      lineChars += joined.chars - seam.chars;
      seam = joined;
    } else {
      lineChars += segment.chars;
      seam = segment;
    }
  }

  function finishLine(): void {
    const line = lines[lineIndex];
    if (line === undefined || line.length !== lineBytes || line.charLength !== lineChars) {
      fail("LINE_INDEX_MISMATCH", `lineIndex.lines[${lineIndex}] disagrees with document content`);
    }
    lineIndex++;
    lineBytes = 0;
    lineChars = 0;
    seam = null;
  }

  for (const { piece } of inOrderPieces(pieceTable.root)) {
    const buffer = unwrapReadonlyUint8Array(
      piece.bufferType === "original"
        ? pieceTable.originalBuffer
        : piece.bufferType === "add"
          ? pieceTable.addBuffer.bytes
          : pieceTable.chunkMap.get(piece.chunkIndex)!,
    );
    const end = piece.start + piece.length;
    let start: number = piece.start;
    let ascii = true;
    for (let i = start; i < end; i++) {
      const byte = buffer[i]!;
      if (pendingCR) {
        pendingCR = false;
        if (byte === 0x0a) {
          consume(buffer, start, i + 1, true);
          finishLine();
          start = i + 1;
          continue;
        }
        finishLine();
      }
      if (byte >= 0x80) {
        ascii = false;
      } else if (byte === 0x0d || byte === 0x0a) {
        consume(buffer, start, i + 1, ascii);
        start = i + 1;
        ascii = true;
        if (byte === 0x0d) pendingCR = true;
        else finishLine();
      }
    }
    consume(buffer, start, end, ascii);
  }
  if (pendingCR) finishLine();
  finishLine(); // Every document includes a final line, even after a newline.
  if (lineIndex !== lines.length) {
    fail("LINE_INDEX_MISMATCH", "lineIndex.lines contains extra lines");
  }
}

function restoreLineIndex(
  raw: unknown,
  pieceTable: PieceTableState,
  revision: number,
  budget: RestoreBudget,
): LineIndexState<"eager"> {
  const { limits } = budget;
  const { totalLength } = pieceTable;
  const source = readObject(raw, "lineIndex");
  const rawLines = readArray(source.lines, "lineIndex.lines", budget);
  assertResourceLimit(rawLines.length, limits.maxLines, "lineIndex.lines");
  if (rawLines.length === 0) {
    fail("MALFORMED", "lineIndex.lines is empty: even an empty document has one line");
  }

  // Derive each eager line offset from the lengths of preceding lines.
  // The captured tree may contain stale cached offsets.
  const lines: LineDescriptor[] = [];
  let coveredLength = 0;
  for (let i = 0; i < rawLines.length; i++) {
    const what = `lineIndex.lines[${i}]`;
    const tuple = readArray(rawLines[i], what, budget);
    const length = readCount(tuple[0], `${what}[0]`);
    const charLength = readCount(tuple[1], `${what}[1]`);
    lines.push({ offset: coveredLength, length, charLength });
    coveredLength += length;
  }

  if (coveredLength !== totalLength) {
    fail(
      "LINE_INDEX_MISMATCH",
      `lineIndex.lines cover ${coveredLength} bytes but the document holds ${totalLength}`,
    );
  }

  validateLineContent(pieceTable, lines);

  const unloadedLineCountsByChunk = new Map<number, number>();
  let unloadedLineCount = 0;
  const rawUnloaded = readArray(source.unloadedLineCounts, "lineIndex.unloadedLineCounts", budget);
  let lastUnloadedIndex = -1;
  for (let i = 0; i < rawUnloaded.length; i++) {
    const what = `lineIndex.unloadedLineCounts[${i}]`;
    const tuple = readArray(rawUnloaded[i], what, budget);
    const chunkIndex = readCount(tuple[0], `${what}[0]`);
    const count = readCount(tuple[1], `${what}[1]`);
    if (chunkIndex <= lastUnloadedIndex) {
      fail("MALFORMED", `${what}[0] must be unique and strictly ascending`);
    }
    unloadedLineCountsByChunk.set(chunkIndex, count);
    unloadedLineCount += count;
    lastUnloadedIndex = chunkIndex;
  }

  assertResourceLimit(
    rawLines.length + unloadedLineCount,
    limits.maxLines,
    "lineIndex total lines",
  );
  const maxDirtyRanges = readCount(source.maxDirtyRanges, "lineIndex.maxDirtyRanges");
  if (maxDirtyRanges < 1) {
    fail("MALFORMED", "lineIndex.maxDirtyRanges must be a positive integer");
  }

  return freezeLineIndexState<"eager">({
    root: buildLineIndexTree(lines) as LineIndexState<"eager">["root"],
    lineCount: lines.length,
    dirtyRanges: Object.freeze([]),
    lastReconciledRevision: revision,
    rebuildPending: false,
    maxDirtyRanges,
    unloadedLineCountsByChunk,
    unloadedLineCount,
  });
}

/**
 * Read a selection's ranges and primary index. `readRange` validates one range
 * tuple of 2 or 4 elements; the tuple length, empty-selection and
 * primary-index rules are shared by live and history selections.
 */
function restoreSelectionShape<R>(
  raw: unknown,
  what: string,
  budget: RestoreBudget,
  readRange: (tuple: readonly unknown[], rangeWhat: string) => R,
): { ranges: NonEmptyReadonlyArray<R>; primaryIndex: number } {
  const source = readObject(raw, what);
  const rawRanges = readArray(source.ranges, `${what}.ranges`, budget);
  if (rawRanges.length === 0) {
    fail("SELECTION_OUT_OF_RANGE", `${what}.ranges is empty: a selection always has one range`);
  }

  const ranges: R[] = [];
  for (let i = 0; i < rawRanges.length; i++) {
    const rangeWhat = `${what}.ranges[${i}]`;
    const tuple = readArray(rawRanges[i], rangeWhat, budget);
    // Keys come as a pair or not at all: a lone anchor key would leave the
    // head unanchored.
    if (tuple.length !== 2 && tuple.length !== 4) {
      fail(
        "MALFORMED",
        `${rangeWhat} has ${tuple.length} elements: expected [anchor, head] or [anchor, head, anchorAfterChunk, headAfterChunk]`,
      );
    }
    ranges.push(Object.freeze(readRange(tuple, rangeWhat)));
  }

  const primaryIndex = readCount(source.primaryIndex, `${what}.primaryIndex`);
  if (primaryIndex >= ranges.length) {
    fail(
      "SELECTION_OUT_OF_RANGE",
      `${what}.primaryIndex is ${primaryIndex} but only ${ranges.length} ranges are present`,
    );
  }

  return {
    ranges: Object.freeze(ranges) as unknown as NonEmptyReadonlyArray<R>,
    primaryIndex,
  };
}

/** Restore the live selection. Every offset must lie within the document. */
function restoreSelection(
  raw: unknown,
  what: string,
  pieceTable: PieceTableState,
  budget: RestoreBudget,
): SelectionState {
  const maxOffset = pieceTable.totalLength;
  return Object.freeze(
    restoreSelectionShape(raw, what, budget, (tuple, rangeWhat): SelectionRange => {
      const anchor = readCount(tuple[0], `${rangeWhat}[0]`);
      const head = readCount(tuple[1], `${rangeWhat}[1]`);
      if (anchor > maxOffset || head > maxOffset) {
        fail(
          "SELECTION_OUT_OF_RANGE",
          `${rangeWhat} spans [${anchor}, ${head}] but the document holds ${maxOffset} bytes`,
        );
      }
      // null stands for no stored key. A key text at its offset could not
      // take is ignored, as it is on the live selection (see
      // `SelectionRange.anchorAfterChunk`): remote edits do not move stored keys.
      const readKey = (index: 2 | 3): number | undefined => {
        const value = tuple[index];
        if (value === null || value === undefined) return undefined;
        return readPlacementKey(value, `${rangeWhat}[${index}]`);
      };
      return selectionRange(
        pieceTable,
        byteOffset(anchor),
        byteOffset(head),
        readKey(2),
        readKey(3),
      );
    }),
  );
}

/**
 * Read and validate one anchored history position and its placement key.
 *
 * A placement key can only name a chunk that has been loaded, so it is at most
 * `nextExpectedChunk - 1` (always `-1` without chunking).
 *
 * An anchored position subtracts the lengths of loaded chunks at or below its
 * key from a non-negative resident offset. `kind` picks the lower bound:
 *
 * - `"change"`: undo and redo replay a change in the restored chunk layout,
 *   where it must resolve to a non-negative offset, so the position is at
 *   least minus the loaded chunks at or below its key. Only an edited chunk
 *   makes a position negative, and an edited chunk cannot be evicted, so a
 *   valid history meets this bound.
 * - `"selection"`: a selection is clamped into the document when restored,
 *   so it only needs the bound that holds in any layout, `-(key + 1) * chunkSize`.
 *
 * Both are `0` for key `-1`.
 */
function readAnchor(
  rawPosition: unknown,
  rawKey: unknown,
  positionWhat: string,
  keyWhat: string,
  pieceTable: PieceTableState,
  kind: "change" | "selection",
): { position: number; afterChunk: number } {
  const afterChunk = readPlacementKey(rawKey, keyWhat);
  const maxKey = pieceTable.nextExpectedChunk - 1;
  if (afterChunk > maxKey) {
    fail(
      "HISTORY_INVALID",
      `${keyWhat} is placement key ${afterChunk} but only chunks up to ${maxKey} have been loaded`,
    );
  }
  const minPosition =
    kind === "change"
      ? -loadedLengthAtOrBelow(pieceTable, afterChunk)
      : Math.max(-(afterChunk + 1) * pieceTable.chunkSize, Number.MIN_SAFE_INTEGER);
  return { position: readInteger(rawPosition, positionWhat, minPosition), afterChunk };
}

function restoreHistoryChange(
  raw: unknown,
  what: string,
  pieceTable: PieceTableState,
  budget: RestoreBudget,
): HistoryChange {
  const tuple = readArray(raw, what, budget);
  const kind = readEnum(tuple[0], ["i", "d", "r"] as const, `${what}[0]`, budget);
  const text = readString(tuple[2], `${what}[2]`, budget);
  // Anchored positions may be negative (see HistoryAnchor). The placement key
  // follows the text fields, so its index depends on the change kind.
  const keyIndex = kind === "r" ? 4 : 3;
  const anchor = readAnchor(
    tuple[1],
    tuple[keyIndex],
    `${what}[1]`,
    `${what}[${keyIndex}]`,
    pieceTable,
    "change",
  );
  // Raw bytes follow the key: `bytes`, then a replace's `oldBytes`.
  const maxLength = kind === "r" ? keyIndex + 3 : keyIndex + 2;
  if (tuple.length > maxLength) {
    fail("MALFORMED", `${what} has ${tuple.length} elements: expected at most ${maxLength}`);
  }
  // A null `bytes` only holds the place of a replace's `oldBytes`, so it is
  // accepted only when `oldBytes` follows.
  const readRawBytes = (index: number): { bytes: ReadonlyUint8Array } | undefined => {
    const value = tuple[index];
    if (value === undefined) return undefined;
    if (value === null && kind === "r" && index === keyIndex + 1 && tuple.length === maxLength) {
      return undefined;
    }
    return {
      bytes: asReadonlyUint8Array(readBytes(value, `${what}[${index}]`, budget)),
    };
  };
  const bytes = readRawBytes(keyIndex + 1);
  // Derive byte lengths from the bytes undo inserts, so an incorrect stored
  // length cannot shift the offsets computed during undo.
  const lengthOf = (value: string, raw: { bytes: ReadonlyUint8Array } | undefined) =>
    byteLength(raw?.bytes.length ?? utf8ByteLength(value));

  if (kind === "r") {
    const oldText = readString(tuple[3], `${what}[3]`, budget);
    const oldBytes = readRawBytes(keyIndex + 2);
    return Object.freeze({
      type: "replace",
      ...anchor,
      ...bytes,
      text,
      byteLength: lengthOf(text, bytes),
      ...(oldBytes !== undefined && { oldBytes: oldBytes.bytes }),
      oldText,
      oldByteLength: lengthOf(oldText, oldBytes),
    });
  }
  return Object.freeze({
    type: kind === "i" ? "insert" : "delete",
    ...anchor,
    ...bytes,
    text,
    byteLength: lengthOf(text, bytes),
  });
}

/** Restore a history selection: anchored positions with optional placement keys. */
function restoreHistorySelection(
  raw: unknown,
  what: string,
  pieceTable: PieceTableState,
  budget: RestoreBudget,
): HistorySelectionState {
  return Object.freeze(
    restoreSelectionShape(raw, what, budget, (tuple, rangeWhat): HistorySelectionRange => {
      const read = (index: 0 | 1) =>
        readAnchor(
          tuple[index],
          tuple[index + 2],
          `${rangeWhat}[${index}]`,
          `${rangeWhat}[${index + 2}]`,
          pieceTable,
          "selection",
        );
      const anchor = read(0);
      const head = read(1);
      return {
        anchor: anchor.position,
        head: head.position,
        anchorAfterChunk: anchor.afterChunk,
        headAfterChunk: head.afterChunk,
      };
    }),
  );
}

function restoreHistoryEntry(
  raw: unknown,
  what: string,
  pieceTable: PieceTableState,
  budget: RestoreBudget,
): HistoryEntry {
  const source = readObject(raw, what);
  const rawChanges = readArray(source.changes, `${what}.changes`, budget);
  const changes = rawChanges.map((change, i) =>
    restoreHistoryChange(change, `${what}.changes[${i}]`, pieceTable, budget),
  );

  return Object.freeze({
    changes: Object.freeze(changes),
    selectionBefore: restoreHistorySelection(
      source.selectionBefore,
      `${what}.selectionBefore`,
      pieceTable,
      budget,
    ),
    selectionAfter: restoreHistorySelection(
      source.selectionAfter,
      `${what}.selectionAfter`,
      pieceTable,
      budget,
    ),
    timestamp: readFiniteNumber(source.timestamp, `${what}.timestamp`),
  });
}

/**
 * Check that a stack replays inside the document: undo (`direction` -1) walks
 * changes last to first, and redo (1) first to last, both from the newest
 * entry. Each change applies to the document the newer ones left. A change
 * would make UNDO or REDO drop the entry when it does not replay there by the
 * rule `applyChange` applies (see `changeReplayFailure`). Restore catches
 * that here instead.
 *
 * A replayed entry moves to the other stack, and the next replay applies it in
 * the other direction, so the key must also fit for the text that direction
 * inserts. Undoing changes n-1 down to i leaves the document that redoing
 * change i starts from, and the other way round. Both directions insert at the
 * same offset, into the document left once this direction's removed bytes are
 * gone, so the one rule covers both.
 *
 * Without chunks every key is NO_CHUNK and fits everywhere, so the walk
 * tracks only the length. With chunks it replays each change on stand-in
 * bytes, since whether a key fits depends on the keys around it. That costs
 * O(log n) per change.
 *
 * Replay loads and evicts no chunks, so every position resolves against the
 * restored layout. `readAnchor` has already checked each against zero.
 *
 * Returns the index of the newest entry that does not replay, with the
 * reason, or null when the whole stack replays.
 */
function findStackReplayFailure(
  entries: readonly HistoryEntry[],
  pieceTable: PieceTableState,
  direction: 1 | -1,
  what: string,
): { readonly index: number; readonly message: string } | null {
  const chunked = pieceTable.nextExpectedChunk > 0;
  let doc = pieceTable;
  let length = pieceTable.totalLength;
  for (let e = entries.length - 1; e >= 0; e--) {
    const { changes } = entries[e]!;
    for (let n = 0; n < changes.length; n++) {
      const i = direction < 0 ? changes.length - 1 - n : n;
      const change = changes[i]!;
      const remove = removedLength(change, direction);
      const insert = insertedLength(change, direction);
      const start = change.position + loadedLengthAtOrBelow(pieceTable, change.afterChunk);
      // Without chunks only the length matters, and every key is NO_CHUNK.
      const layout = chunked ? doc : { root: null, totalLength: length, nextExpectedChunk: 0 };
      const failure = changeReplayFailure(layout, start, remove, insert, change.afterChunk);
      if (failure === "range") {
        return {
          index: e,
          message:
            `${what}[${e}].changes[${i}] resolves to [${start}, ${start + remove}), past the ` +
            `end of the ${length}-byte document it applies to`,
        };
      }
      if (failure === "key") {
        return {
          index: e,
          message:
            `${what}[${e}].changes[${i}] inserts text with placement key ${change.afterChunk} ` +
            `at offset ${start} on undo or redo, which would put placement keys out of ` +
            `document order`,
        };
      }
      length += insert - remove;
      if (!chunked) continue;
      if (remove > 0) doc = pieceTableDelete(doc, byteOffset(start), byteOffset(start + remove));
      // Only lengths and keys are checked, so the inserted text stands in as
      // a placeholder: no bytes move.
      doc = pieceTableInsertPlaceholder(doc, byteOffset(start), insert, change.afterChunk);
    }
  }
  return null;
}

/**
 * Restore the undo and redo stacks.
 *
 * A stack that does not replay (see `findStackReplayFailure`) rejects the
 * checkpoint unless `dropStale` is set. Version 1 could save offsets that had
 * already gone stale when a chunk was evicted, and its restore still kept the
 * document. A migrated payload does the same: each stack keeps the newer
 * entries that replay and drops the failing entry and everything older, since
 * each older entry applies to the document the failing one would have left.
 */
function restoreHistory(
  raw: unknown,
  pieceTable: PieceTableState,
  budget: RestoreBudget,
  dropStale: boolean,
): HistoryState {
  const { limits } = budget;
  const source = readObject(raw, "history");
  const limit = readCount(source.limit, "history.limit");
  if (limit < 1) {
    fail("HISTORY_INVALID", "history.limit must be a positive integer");
  }

  const coalesceTimeout = readFiniteNumber(source.coalesceTimeout, "history.coalesceTimeout");
  if (coalesceTimeout < 0) {
    fail("HISTORY_INVALID", "history.coalesceTimeout must be a non-negative number");
  }

  const evictionPolicy =
    source.evictionPolicy === undefined
      ? "pin-bounded"
      : readEnum(
          source.evictionPolicy,
          HISTORY_EVICTION_POLICIES,
          "history.evictionPolicy",
          budget,
        );

  const rawUndo = readArray(source.undo, "history.undo", budget);
  const rawRedo = readArray(source.redo, "history.redo", budget);
  assertResourceLimit(rawUndo.length + rawRedo.length, limits.maxHistoryEntries, "history entries");
  const readStack = (rawEntries: readonly unknown[], what: string): HistoryEntry[] => {
    if (rawEntries.length > limit) {
      fail(
        "HISTORY_INVALID",
        `${what} holds ${rawEntries.length} entries, past the declared limit of ${limit}`,
      );
    }
    return rawEntries.map((entry, i) =>
      restoreHistoryEntry(entry, `${what}[${i}]`, pieceTable, budget),
    );
  };
  const replayable = (entries: HistoryEntry[], direction: 1 | -1, what: string) => {
    const failure = findStackReplayFailure(entries, pieceTable, direction, what);
    if (failure === null) return entries;
    if (!dropStale) fail("HISTORY_INVALID", failure.message);
    return entries.slice(failure.index + 1);
  };
  const undo = replayable(readStack(rawUndo, "history.undo"), -1, "history.undo");
  const redo = replayable(readStack(rawRedo, "history.redo"), 1, "history.redo");

  return Object.freeze({
    undoStack: pstackFromArray(undo),
    redoStack: pstackFromArray(redo),
    limit,
    coalesceTimeout,
    evictionPolicy,
  });
}

function restoreMetadata(raw: unknown, budget: RestoreBudget): DocumentMetadata {
  const source = readObject(raw, "metadata");
  const filePath = readOptionalString(source.filePath, "metadata.filePath", budget);
  const lastSaved =
    source.lastSaved === undefined
      ? undefined
      : readFiniteNumber(source.lastSaved, "metadata.lastSaved");

  return Object.freeze({
    filePath,
    encoding: readEnum(source.encoding, ["utf-8"] as const, "metadata.encoding", budget),
    lineEnding: readEnum(
      source.lineEnding,
      ["lf", "crlf", "cr"] as const,
      "metadata.lineEnding",
      budget,
    ),
    normalizeInsertedLineEndings: readBoolean(
      source.normalizeInsertedLineEndings,
      "metadata.normalizeInsertedLineEndings",
    ),
    isDirty: readBoolean(source.isDirty, "metadata.isDirty"),
    lastSaved,
  });
}

function restoreAttention(
  raw: unknown,
  lengthByID: Map<PieceID, number>,
  budget: RestoreBudget,
): AttentionLayerState {
  const { limits } = budget;
  const source = readObject(raw, "attention");
  const rawAttentions = readArray(source.attentions, "attention.attentions", budget);
  assertResourceLimit(rawAttentions.length, limits.maxAttentions, "attention.attentions");
  const attentions = new Map<AttentionID, Attention>();

  const readPoint = (
    rawID: unknown,
    rawBoundary: unknown,
    what: string,
  ): { pieceID: PieceID; boundary: number } => {
    const id = pieceID(readString(rawID, `${what}.pieceID`, budget));
    const boundary = readCount(rawBoundary, `${what}.boundary`);
    const pieceLength = lengthByID.get(id);
    if (pieceLength === undefined) {
      fail("ATTENTION_DANGLING", `${what} anchors to piece ${id}, which is not in the piece table`);
    }
    if (boundary > pieceLength) {
      fail(
        "ATTENTION_DANGLING",
        `${what} sits at boundary ${boundary} of piece ${id}, which is ${pieceLength} bytes long`,
      );
    }
    return { pieceID: id, boundary };
  };

  for (let i = 0; i < rawAttentions.length; i++) {
    const what = `attention.attentions[${i}]`;
    const tuple = readArray(rawAttentions[i], what, budget);
    const id = attentionID(readString(tuple[0], `${what}[0]`, budget));
    if (attentions.has(id)) {
      fail("ID_COLLISION", `${what} repeats attention id ${id}`);
    }
    attentions.set(
      id,
      Object.freeze({
        id,
        start: Object.freeze(readPoint(tuple[1], tuple[2], `${what} start`)),
        end: Object.freeze(readPoint(tuple[3], tuple[4], `${what} end`)),
      }),
    );
  }

  const nextID = readCount(source.nextID, "attention.nextID");
  const highestID = maxNumericSuffix(attentions.keys(), "a");
  if (nextID <= highestID) {
    fail(
      "ID_COLLISION",
      `attention.nextID is ${nextID} but attention a${highestID} is already in use: the next createAttention would collide`,
    );
  }

  return Object.freeze({ attentions: asReadonlyMap(attentions), nextID });
}

/**
 * Check the format tag, supported version, and required checkpoint sections.
 *
 * Use this envelope check to route values before restoring them. It accepts
 * every version `restoreCheckpoint` can migrate, so a true result may be an
 * older format: read the sections only through `restoreCheckpoint`, which
 * migrates the payload and validates its internal consistency. Code that
 * reads sections directly must also check `value.version === CHECKPOINT_VERSION`.
 * Before 5.0 this guard accepted only the current version.
 */
export function isCheckpoint(value: unknown): value is CheckpointEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.format !== CHECKPOINT_FORMAT) return false;
  // Accept every version restore can migrate forward.
  if (
    typeof candidate.version !== "number" ||
    !Number.isInteger(candidate.version) ||
    candidate.version < minimumSupportedVersion() ||
    candidate.version > CHECKPOINT_VERSION
  ) {
    return false;
  }
  return ["pieceTable", "lineIndex", "selection", "history", "metadata", "attention"].every(
    (key) => {
      const section = candidate[key];
      return typeof section === "object" && section !== null && !Array.isArray(section);
    },
  );
}

function validateChunkLineIndex(
  pieceTable: PieceTableState,
  lineIndex: LineIndexState<"eager">,
): void {
  if (pieceTable.chunkSize === 0 && lineIndex.unloadedLineCountsByChunk.size > 0) {
    fail("MALFORMED", "non-chunked checkpoints cannot carry unloaded chunk line counts");
  }

  for (const [chunkIndex, metadata] of pieceTable.chunkMetadata) {
    const unloadedCount = lineIndex.unloadedLineCountsByChunk.get(chunkIndex);
    if (pieceTable.chunkMap.has(chunkIndex)) {
      if (unloadedCount !== undefined) {
        fail("MALFORMED", `resident chunk ${chunkIndex} cannot also be counted as unloaded`);
      }
    } else if (unloadedCount !== metadata.lineCount) {
      fail("MALFORMED", `unloaded line count for chunk ${chunkIndex} disagrees with metadata`);
    }
  }

  for (const chunkIndex of lineIndex.unloadedLineCountsByChunk.keys()) {
    if (!pieceTable.chunkMetadata.has(chunkIndex)) {
      fail("MALFORMED", `lineIndex.unloadedLineCounts names chunk ${chunkIndex} without metadata`);
    }
  }
}

/**
 * Bring an older payload to the current version. Migration runs before
 * validation and returns malformed input as is for the validators to report,
 * but any other error it raises still means the payload is not restorable,
 * so it surfaces as `CheckpointError('MALFORMED')` as `restoreCheckpoint`
 * promises.
 */
function migrate(source: Record<string, unknown>, version: number): Record<string, unknown> {
  try {
    return migrateCheckpointData(source, version).data;
  } catch (error) {
    if (error instanceof CheckpointError) throw error;
    fail(
      "MALFORMED",
      `checkpoint version ${version} could not be migrated: ${(error as Error).message}`,
    );
  }
}

/**
 * Rebuild a document state from a checkpoint.
 *
 * Read the returned `DocumentState<'eager'>` with `query` and `scan`.
 * To create a live store, pass the checkpoint payload to
 * `store.createDocumentStoreFromCheckpoint` instead.
 *
 * Invalid pieces, incomplete line coverage, dangling attention anchors, and
 * allocator cursors that would reuse a live ID raise `CheckpointError`.
 * Its `code` identifies the failed validation.
 *
 * Use `options` to bound decoded buffers and collection sizes before restoring
 * input from outside the application. Omitted limits remain unrestricted.
 *
 * @throws CheckpointError when the payload is not a restorable checkpoint
 */
export function restoreCheckpoint(
  checkpoint: unknown,
  options: CheckpointRestoreOptions = {},
): DocumentState<"eager"> {
  const limits = normalizeRestoreOptions(options);
  const budget = createRestoreBudget(limits);
  const source = readObject(checkpoint, "checkpoint");

  if (source.format !== CHECKPOINT_FORMAT) {
    fail(
      "NOT_A_CHECKPOINT",
      `expected format '${CHECKPOINT_FORMAT}' but found ${JSON.stringify(source.format)}`,
    );
  }
  readString(source.format, "checkpoint.format", budget);
  const version = readCount(source.version, "checkpoint.version");
  // Migrate older payloads before validating fields against the current
  // format. Raise VERSION_UNSUPPORTED when no migration path exists.
  if (version !== CHECKPOINT_VERSION && migrationPath(version) !== null) {
    assertMigrationLimits(source, limits);
  }
  const migrated = version === CHECKPOINT_VERSION ? source : migrate(source, version);
  readEnum(migrated.mode, ["exact", "normalized"] as const, "checkpoint.mode", budget);

  const revision = readCount(migrated.revision, "checkpoint.revision");
  const { pieceTable, lengthByID } = restorePieceTable(migrated.pieceTable, budget);
  const lineIndex = restoreLineIndex(migrated.lineIndex, pieceTable, revision, budget);
  validateChunkLineIndex(pieceTable, lineIndex);

  return Object.freeze({
    revision,
    selectionRevision: readCount(migrated.selectionRevision, "checkpoint.selectionRevision"),
    pieceTable,
    lineIndex,
    selection: restoreSelection(migrated.selection, "selection", pieceTable, budget),
    history: restoreHistory(migrated.history, pieceTable, budget, version !== CHECKPOINT_VERSION),
    metadata: restoreMetadata(migrated.metadata, budget),
    attention: restoreAttention(migrated.attention, lengthByID, budget),
  });
}

/**
 * Parse and restore a checkpoint string produced by `encodeCheckpoint`.
 *
 * Use `options.maxJsonLength` to reject oversized strings before `JSON.parse`.
 * The remaining restore limits apply after parsing and before state trees are
 * rebuilt.
 *
 * @throws CheckpointError when the string is not valid JSON or not a restorable
 *         checkpoint
 */
export function decodeCheckpoint(
  json: string,
  options: CheckpointRestoreOptions = {},
): DocumentState<"eager"> {
  const maxJsonLength = readRestoreLimit(options.maxJsonLength, "maxJsonLength");
  assertResourceLimit(json.length, maxJsonLength, "checkpoint JSON length");
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    fail("NOT_A_CHECKPOINT", `checkpoint is not valid JSON: ${(error as Error).message}`);
  }
  return restoreCheckpoint(parsed, options);
}
