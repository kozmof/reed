/**
 * Checkpoint capture and restore — serialize a live `DocumentState` and load it
 * back without replaying the edits that produced it.
 *
 * `getSnapshot()` hands out an in-memory `DocumentState`; a *checkpoint* is that
 * state flattened to JSON-safe data. Capture requires an eager state so every
 * line offset is a resolved number, and restore returns one for the same reason:
 * a checkpoint never carries pending reconciliation work.
 *
 * Trees are captured as flat in-order lists and rebuilt with the balanced
 * bulk-loaders in `core/state.ts`. Topology is therefore not preserved, and
 * nothing needs it to be — attention points anchor to `PieceID`, which is.
 *
 * Restore is fail-closed. Every structural invariant a checkpoint could violate
 * is checked before a state is assembled, so a truncated or hand-edited payload
 * raises `CheckpointError` instead of quietly corrupting later edits.
 */

import type {
  DocumentState,
  PieceTableState,
  PieceNode,
  LineIndexState,
  SelectionState,
  SelectionRange,
  HistoryState,
  HistoryEntry,
  HistoryChange,
  DocumentMetadata,
  ChunkMetadata,
} from "../../types/state.js";
import { pstackToArray, pstackFromArray } from "../../types/state.js";
import type { NonEmptyReadonlyArray } from "../../types/utils.js";
import type { AttentionLayerState, Attention } from "../../types/attention.js";
import type { PieceID, AttentionID, ReadonlyUint8Array } from "../../types/branded.js";
import { byteOffset, byteLength, pieceID, attentionID } from "../../types/branded.js";
import type {
  DocumentCheckpoint,
  CheckpointOptions,
  CheckpointMode,
  CheckpointPiece,
  CheckpointChunk,
  CheckpointChunkMetadata,
  CheckpointLine,
  CheckpointPieceTable,
  CheckpointLineIndex,
  CheckpointSelection,
  CheckpointHistory,
  CheckpointHistoryEntry,
  CheckpointHistoryChange,
  CheckpointMetadata,
  CheckpointAttention,
  CheckpointAttentionLayer,
  CheckpointErrorCode,
} from "../../types/checkpoint.js";
import { CHECKPOINT_FORMAT, CHECKPOINT_VERSION, CheckpointError } from "../../types/checkpoint.js";
import type { PieceDescriptor, LineDescriptor } from "../core/state.js";
import {
  buildPieceTree,
  buildLineIndexTree,
  createPieceTableState,
  createLineIndexState,
  freezePieceTableState,
  freezeLineIndexState,
} from "../core/state.js";
import { collectPieces, compactAddBuffer, getValue } from "../core/piece-table.js";
import { collectLines } from "../core/line-index.js";
import { createPoint, resolveAttention } from "../core/attention.js";
import { encodeBase64, decodeBase64 } from "../core/base64.js";
import { utf8ByteLength } from "../core/encoding.js";
import { GrowableBuffer } from "../core/growable-buffer.js";
import {
  asReadonlyMap,
  asReadonlyUint8Array,
  unwrapReadonlyUint8Array,
} from "../core/runtime-readonly.js";

// =============================================================================
// Errors
// =============================================================================

function fail(code: CheckpointErrorCode, message: string): never {
  throw new CheckpointError(code, message);
}

// =============================================================================
// Capture
// =============================================================================

const BUFFER_TAG = { original: "o", add: "a", chunk: "c" } as const;

function capturePiece(piece: PieceNode): CheckpointPiece {
  return piece.bufferType === "chunk"
    ? [piece.id, "c", piece.start, piece.length, piece.chunkIndex]
    : [piece.id, BUFFER_TAG[piece.bufferType], piece.start, piece.length];
}

function captureChunks(chunkMap: ReadonlyMap<number, ReadonlyUint8Array>): CheckpointChunk[] {
  const chunks: CheckpointChunk[] = [];
  for (const [chunkIndex, bytes] of chunkMap) {
    chunks.push([chunkIndex, encodeBase64(unwrapReadonlyUint8Array(bytes))]);
  }
  return chunks.sort((a, b) => a[0] - b[0]);
}

function captureChunkMetadata(
  chunkMetadata: ReadonlyMap<number, ChunkMetadata>,
): CheckpointChunkMetadata[] {
  const entries: CheckpointChunkMetadata[] = [];
  for (const metadata of chunkMetadata.values()) {
    entries.push([metadata.chunkIndex, metadata.byteLength, metadata.lineCount]);
  }
  return entries.sort((a, b) => a[0] - b[0]);
}

function capturePieceTable(pieceTable: PieceTableState): CheckpointPieceTable {
  return {
    nextPieceID: pieceTable.nextPieceID,
    totalLength: pieceTable.totalLength,
    originalBuffer: encodeBase64(unwrapReadonlyUint8Array(pieceTable.originalBuffer)),
    addBuffer: encodeBase64(unwrapReadonlyUint8Array(pieceTable.addBuffer.bytes)),
    chunkSize: pieceTable.chunkSize,
    nextExpectedChunk: pieceTable.nextExpectedChunk,
    totalFileSize: pieceTable.totalFileSize,
    loadedChunks: [...pieceTable.loadedChunks].sort((a, b) => a - b),
    chunks: captureChunks(pieceTable.chunkMap),
    chunkMetadata: captureChunkMetadata(pieceTable.chunkMetadata),
    pieces: collectPieces(pieceTable.root).map(capturePiece),
  };
}

function captureLineIndex(lineIndex: LineIndexState<"eager">): CheckpointLineIndex {
  const lines: CheckpointLine[] = collectLines(lineIndex.root).map((line) => [
    line.lineLength,
    line.charLength,
  ]);
  const unloadedLineCounts: (readonly [number, number])[] = [
    ...lineIndex.unloadedLineCountsByChunk,
  ].sort((a, b) => a[0] - b[0]);

  return { maxDirtyRanges: lineIndex.maxDirtyRanges, unloadedLineCounts, lines };
}

function captureSelection(selection: SelectionState): CheckpointSelection {
  return {
    ranges: selection.ranges.map((range) => [range.anchor, range.head] as const),
    primaryIndex: selection.primaryIndex,
  };
}

function captureHistoryChange(change: HistoryChange): CheckpointHistoryChange {
  switch (change.type) {
    case "insert":
      return ["i", change.position, change.text];
    case "delete":
      return ["d", change.position, change.text];
    case "replace":
      return ["r", change.position, change.text, change.oldText];
  }
}

function captureHistoryEntry(entry: HistoryEntry): CheckpointHistoryEntry {
  return {
    changes: entry.changes.map(captureHistoryChange),
    selectionBefore: captureSelection(entry.selectionBefore),
    selectionAfter: captureSelection(entry.selectionAfter),
    timestamp: entry.timestamp,
  };
}

function captureHistory(history: HistoryState): CheckpointHistory {
  return {
    limit: history.limit,
    coalesceTimeout: history.coalesceTimeout,
    undo: pstackToArray(history.undoStack).map(captureHistoryEntry),
    redo: pstackToArray(history.redoStack).map(captureHistoryEntry),
  };
}

function captureMetadata(metadata: DocumentMetadata): CheckpointMetadata {
  return {
    ...(metadata.filePath !== undefined ? { filePath: metadata.filePath } : {}),
    encoding: metadata.encoding,
    lineEnding: metadata.lineEnding,
    normalizeInsertedLineEndings: metadata.normalizeInsertedLineEndings,
    isDirty: metadata.isDirty,
    ...(metadata.lastSaved !== undefined ? { lastSaved: metadata.lastSaved } : {}),
  };
}

function captureAttention(attention: AttentionLayerState): CheckpointAttentionLayer {
  const attentions: CheckpointAttention[] = [];
  for (const entry of attention.attentions.values()) {
    attentions.push([
      entry.id,
      entry.start.pieceID,
      entry.start.boundary,
      entry.end.pieceID,
      entry.end.boundary,
    ]);
  }
  return { nextID: attention.nextID, attentions };
}

/**
 * Flatten a state to a single original-buffer piece.
 *
 * Piece identities do not survive — the whole document becomes one fresh piece —
 * so every attention is re-anchored by resolving it against the old tree and
 * re-creating its points against the new one. Attentions that no longer resolve
 * (their text was deleted) are dropped, matching the fail-closed resolution
 * contract: they already read as `null`.
 */
function normalizeState(state: DocumentState<"eager">): DocumentState<"eager"> {
  if (state.pieceTable.chunkSize > 0) {
    fail(
      "CHUNKED_NORMALIZE",
      "normalized capture is not available for chunked documents: flattening a partially-loaded file to text would drop its unloaded ranges",
    );
  }

  const content = getValue(state.pieceTable);
  const pieceTable = createPieceTableState(content);
  const lineIndex = createLineIndexState(
    content,
    state.lineIndex.maxDirtyRanges,
  ) as LineIndexState<"eager">;

  const attentions = new Map<AttentionID, Attention>();
  for (const entry of state.attention.attentions.values()) {
    const range = resolveAttention(state.pieceTable.root, state.attention, entry.id);
    if (range === null) continue;
    const start = createPoint(pieceTable.root, range.startOffset);
    const end = createPoint(pieceTable.root, range.endOffset);
    if (start === null || end === null) continue;
    attentions.set(
      entry.id,
      Object.freeze({
        id: entry.id,
        start: Object.freeze({ pieceID: start.pieceID, boundary: start.boundary }),
        end: Object.freeze({ pieceID: end.pieceID, boundary: end.boundary }),
      }),
    );
  }

  return Object.freeze({
    ...state,
    pieceTable,
    lineIndex,
    attention: Object.freeze({
      attentions: asReadonlyMap(attentions),
      nextID: state.attention.nextID,
    }),
  });
}

/**
 * Capture a document state as a JSON-safe checkpoint.
 *
 * Requires an eager state — obtain one with `store.getEagerSnapshot()`,
 * `store.reconcileNow()`, or `await store.whenReconciled()`. The type parameter
 * does the enforcing: a lazily-reconciled state cannot be passed here, so a
 * checkpoint can never contain unresolved line offsets.
 *
 * @param state - Fully reconciled state to capture
 * @param options - Capture fidelity and add-buffer compaction
 * @throws CheckpointError with code `CHUNKED_NORMALIZE` for a normalized capture
 *         of a chunked document
 */
export function createCheckpoint(
  state: DocumentState<"eager">,
  options: CheckpointOptions = {},
): DocumentCheckpoint {
  const mode: CheckpointMode = options.mode ?? "exact";
  const compact = options.compact ?? true;

  let source = state;
  if (mode === "normalized") {
    source = normalizeState(state);
  } else if (compact) {
    // threshold 0 forces compaction regardless of how little waste there is;
    // the store's own auto-compaction only fires past AUTO_COMPACT_WASTE_RATIO.
    const compacted = compactAddBuffer(source.pieceTable, 0);
    if (compacted !== source.pieceTable) {
      source = Object.freeze({ ...source, pieceTable: compacted });
    }
  }

  return {
    format: CHECKPOINT_FORMAT,
    version: CHECKPOINT_VERSION,
    mode,
    revision: source.revision,
    selectionRevision: source.selectionRevision,
    pieceTable: capturePieceTable(source.pieceTable),
    lineIndex: captureLineIndex(source.lineIndex),
    selection: captureSelection(source.selection),
    history: captureHistory(source.history),
    metadata: captureMetadata(source.metadata),
    attention: captureAttention(source.attention),
  };
}

/**
 * Capture a state and stringify it in one step.
 * Equivalent to `JSON.stringify(createCheckpoint(state, options))`.
 */
export function encodeCheckpoint(
  state: DocumentState<"eager">,
  options: CheckpointOptions = {},
): string {
  return JSON.stringify(createCheckpoint(state, options));
}

// =============================================================================
// Readers — narrow untrusted JSON, one field at a time
// =============================================================================

function readObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("MALFORMED", `${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readArray(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    fail("MALFORMED", `${what} must be an array`);
  }
  return value;
}

function readString(value: unknown, what: string): string {
  if (typeof value !== "string") {
    fail("MALFORMED", `${what} must be a string`);
  }
  return value;
}

function readBoolean(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") {
    fail("MALFORMED", `${what} must be a boolean`);
  }
  return value;
}

/** Non-negative safe integer — the shape of every offset, length, and count. */
function readCount(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail("MALFORMED", `${what} must be a non-negative safe integer`);
  }
  return value;
}

function readFiniteNumber(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("MALFORMED", `${what} must be a finite number`);
  }
  return value;
}

function readEnum<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    fail("MALFORMED", `${what} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function readOptionalString(value: unknown, what: string): string | undefined {
  return value === undefined ? undefined : readString(value, what);
}

function readBytes(value: unknown, what: string): Uint8Array {
  const base64 = readString(value, what);
  try {
    return decodeBase64(base64);
  } catch (error) {
    fail("MALFORMED", `${what} is not valid base64: ${(error as Error).message}`);
  }
}

/**
 * Highest `n` among ids shaped `<prefix><n>`, or -1 when none match.
 * Ids from other sources are opaque and simply do not constrain the allocator.
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
): { pieces: PieceDescriptor[]; totalLength: number; lengthByID: Map<PieceID, number> } {
  const pieces: PieceDescriptor[] = [];
  const lengthByID = new Map<PieceID, number>();
  let totalLength = 0;
  let lastChunkIndex = -1;

  for (let i = 0; i < raw.length; i++) {
    const what = `pieceTable.pieces[${i}]`;
    const tuple = readArray(raw[i], what);
    const id = pieceID(readString(tuple[0], `${what}[0]`));
    const tag = readEnum(tuple[1], ["o", "a", "c"] as const, `${what}[1]`);
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
      // findReloadInsertionPos relies on to place a re-loaded chunk.
      if (chunkIndex < lastChunkIndex) {
        fail(
          "CHUNK_ORDER",
          `${what} has chunkIndex ${chunkIndex} after ${lastChunkIndex}: chunk pieces must be in ascending order`,
        );
      }
      lastChunkIndex = chunkIndex;
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
      pieces.push({ id, bufferType, start: byteOffset(start), length: byteLength(length) });
    }

    lengthByID.set(id, length);
    totalLength += length;
  }

  return { pieces, totalLength, lengthByID };
}

function restorePieceTable(raw: unknown): {
  pieceTable: PieceTableState;
  lengthByID: Map<PieceID, number>;
} {
  const source = readObject(raw, "pieceTable");
  const originalBuffer = readBytes(source.originalBuffer, "pieceTable.originalBuffer");
  const addBytes = readBytes(source.addBuffer, "pieceTable.addBuffer");

  const chunkMap = new Map<number, Uint8Array>();
  const rawChunks = readArray(source.chunks, "pieceTable.chunks");
  for (let i = 0; i < rawChunks.length; i++) {
    const what = `pieceTable.chunks[${i}]`;
    const tuple = readArray(rawChunks[i], what);
    chunkMap.set(readCount(tuple[0], `${what}[0]`), readBytes(tuple[1], `${what}[1]`));
  }

  const chunkMetadata = new Map<number, ChunkMetadata>();
  const rawMetadata = readArray(source.chunkMetadata, "pieceTable.chunkMetadata");
  for (let i = 0; i < rawMetadata.length; i++) {
    const what = `pieceTable.chunkMetadata[${i}]`;
    const tuple = readArray(rawMetadata[i], what);
    const chunkIndex = readCount(tuple[0], `${what}[0]`);
    chunkMetadata.set(
      chunkIndex,
      Object.freeze({
        chunkIndex,
        byteLength: readCount(tuple[1], `${what}[1]`),
        lineCount: readCount(tuple[2], `${what}[2]`),
      }),
    );
  }

  const loadedChunks = new Set<number>();
  const rawLoaded = readArray(source.loadedChunks, "pieceTable.loadedChunks");
  for (let i = 0; i < rawLoaded.length; i++) {
    loadedChunks.add(readCount(rawLoaded[i], `pieceTable.loadedChunks[${i}]`));
  }

  const { pieces, totalLength, lengthByID } = restorePieces(
    readArray(source.pieces, "pieceTable.pieces"),
    originalBuffer.length,
    addBytes.length,
    chunkMap,
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
    chunkSize: readCount(source.chunkSize, "pieceTable.chunkSize"),
    nextExpectedChunk: readCount(source.nextExpectedChunk, "pieceTable.nextExpectedChunk"),
    loadedChunks,
    chunkMetadata,
    totalFileSize: readCount(source.totalFileSize, "pieceTable.totalFileSize"),
  });

  return { pieceTable, lengthByID };
}

function restoreLineIndex(
  raw: unknown,
  totalLength: number,
  revision: number,
): LineIndexState<"eager"> {
  const source = readObject(raw, "lineIndex");
  const rawLines = readArray(source.lines, "lineIndex.lines");
  if (rawLines.length === 0) {
    fail("MALFORMED", "lineIndex.lines is empty: even an empty document has one line");
  }

  // A line's offset is the running prefix sum of the lengths before it: the
  // canonical eager value, rather than whatever cached offset the captured tree
  // happened to hold.
  const lines: LineDescriptor[] = [];
  let coveredLength = 0;
  for (let i = 0; i < rawLines.length; i++) {
    const what = `lineIndex.lines[${i}]`;
    const tuple = readArray(rawLines[i], what);
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

  const unloadedLineCountsByChunk = new Map<number, number>();
  let unloadedLineCount = 0;
  const rawUnloaded = readArray(source.unloadedLineCounts, "lineIndex.unloadedLineCounts");
  for (let i = 0; i < rawUnloaded.length; i++) {
    const what = `lineIndex.unloadedLineCounts[${i}]`;
    const tuple = readArray(rawUnloaded[i], what);
    const count = readCount(tuple[1], `${what}[1]`);
    unloadedLineCountsByChunk.set(readCount(tuple[0], `${what}[0]`), count);
    unloadedLineCount += count;
  }

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
 * @param maxOffset - Upper bound for offsets, or `null` to accept any offset.
 *   History entries describe older revisions, so their selections may point past
 *   the end of the current document and are only checked structurally.
 */
function restoreSelection(raw: unknown, what: string, maxOffset: number | null): SelectionState {
  const source = readObject(raw, what);
  const rawRanges = readArray(source.ranges, `${what}.ranges`);
  if (rawRanges.length === 0) {
    fail("SELECTION_OUT_OF_RANGE", `${what}.ranges is empty: a selection always has one range`);
  }

  const ranges: SelectionRange[] = [];
  for (let i = 0; i < rawRanges.length; i++) {
    const rangeWhat = `${what}.ranges[${i}]`;
    const tuple = readArray(rawRanges[i], rangeWhat);
    const anchor = readCount(tuple[0], `${rangeWhat}[0]`);
    const head = readCount(tuple[1], `${rangeWhat}[1]`);
    if (maxOffset !== null && (anchor > maxOffset || head > maxOffset)) {
      fail(
        "SELECTION_OUT_OF_RANGE",
        `${rangeWhat} spans [${anchor}, ${head}] but the document holds ${maxOffset} bytes`,
      );
    }
    ranges.push(Object.freeze({ anchor: byteOffset(anchor), head: byteOffset(head) }));
  }

  const primaryIndex = readCount(source.primaryIndex, `${what}.primaryIndex`);
  if (primaryIndex >= ranges.length) {
    fail(
      "SELECTION_OUT_OF_RANGE",
      `${what}.primaryIndex is ${primaryIndex} but only ${ranges.length} ranges are present`,
    );
  }

  return Object.freeze({
    ranges: Object.freeze(ranges) as NonEmptyReadonlyArray<SelectionRange>,
    primaryIndex,
  });
}

function restoreHistoryChange(raw: unknown, what: string): HistoryChange {
  const tuple = readArray(raw, what);
  const kind = readEnum(tuple[0], ["i", "d", "r"] as const, `${what}[0]`);
  const position = byteOffset(readCount(tuple[1], `${what}[1]`));
  const text = readString(tuple[2], `${what}[2]`);
  // Byte lengths are derived, never trusted: a stored length that disagreed with
  // its text would misplace every offset an undo computes from it.
  const textLength = byteLength(utf8ByteLength(text));

  if (kind === "r") {
    const oldText = readString(tuple[3], `${what}[3]`);
    return Object.freeze({
      type: "replace",
      position,
      text,
      byteLength: textLength,
      oldText,
      oldByteLength: byteLength(utf8ByteLength(oldText)),
    });
  }
  return Object.freeze({
    type: kind === "i" ? "insert" : "delete",
    position,
    text,
    byteLength: textLength,
  });
}

function restoreHistoryEntry(raw: unknown, what: string): HistoryEntry {
  const source = readObject(raw, what);
  const rawChanges = readArray(source.changes, `${what}.changes`);
  const changes = rawChanges.map((change, i) =>
    restoreHistoryChange(change, `${what}.changes[${i}]`),
  );

  return Object.freeze({
    changes: Object.freeze(changes),
    selectionBefore: restoreSelection(source.selectionBefore, `${what}.selectionBefore`, null),
    selectionAfter: restoreSelection(source.selectionAfter, `${what}.selectionAfter`, null),
    timestamp: readFiniteNumber(source.timestamp, `${what}.timestamp`),
  });
}

function restoreHistory(raw: unknown): HistoryState {
  const source = readObject(raw, "history");
  const limit = readCount(source.limit, "history.limit");
  if (limit < 1) {
    fail("HISTORY_INVALID", "history.limit must be a positive integer");
  }

  const coalesceTimeout = readFiniteNumber(source.coalesceTimeout, "history.coalesceTimeout");
  if (coalesceTimeout < 0) {
    fail("HISTORY_INVALID", "history.coalesceTimeout must be a non-negative number");
  }

  const readStack = (value: unknown, what: string): HistoryEntry[] => {
    const rawEntries = readArray(value, what);
    if (rawEntries.length > limit) {
      fail(
        "HISTORY_INVALID",
        `${what} holds ${rawEntries.length} entries, past the declared limit of ${limit}`,
      );
    }
    return rawEntries.map((entry, i) => restoreHistoryEntry(entry, `${what}[${i}]`));
  };

  return Object.freeze({
    undoStack: pstackFromArray(readStack(source.undo, "history.undo")),
    redoStack: pstackFromArray(readStack(source.redo, "history.redo")),
    limit,
    coalesceTimeout,
  });
}

function restoreMetadata(raw: unknown): DocumentMetadata {
  const source = readObject(raw, "metadata");
  const filePath = readOptionalString(source.filePath, "metadata.filePath");
  const lastSaved =
    source.lastSaved === undefined
      ? undefined
      : readFiniteNumber(source.lastSaved, "metadata.lastSaved");

  return Object.freeze({
    filePath,
    encoding: readEnum(source.encoding, ["utf-8"] as const, "metadata.encoding"),
    lineEnding: readEnum(source.lineEnding, ["lf", "crlf", "cr"] as const, "metadata.lineEnding"),
    normalizeInsertedLineEndings: readBoolean(
      source.normalizeInsertedLineEndings,
      "metadata.normalizeInsertedLineEndings",
    ),
    isDirty: readBoolean(source.isDirty, "metadata.isDirty"),
    lastSaved,
  });
}

function restoreAttention(raw: unknown, lengthByID: Map<PieceID, number>): AttentionLayerState {
  const source = readObject(raw, "attention");
  const rawAttentions = readArray(source.attentions, "attention.attentions");
  const attentions = new Map<AttentionID, Attention>();

  const readPoint = (
    rawID: unknown,
    rawBoundary: unknown,
    what: string,
  ): { pieceID: PieceID; boundary: number } => {
    const id = pieceID(readString(rawID, `${what}.pieceID`));
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
    const tuple = readArray(rawAttentions[i], what);
    const id = attentionID(readString(tuple[0], `${what}[0]`));
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
 * Cheap structural check that `value` looks like a checkpoint envelope.
 *
 * Confirms the format tag, a supported version, and the presence of every
 * section — not that the payload is internally consistent. Use it to route a
 * value before restoring; `restoreCheckpoint` does the full validation.
 */
export function isCheckpoint(value: unknown): value is DocumentCheckpoint {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.format !== CHECKPOINT_FORMAT) return false;
  if (typeof candidate.version !== "number" || candidate.version > CHECKPOINT_VERSION) return false;
  return (
    typeof candidate.pieceTable === "object" &&
    typeof candidate.lineIndex === "object" &&
    typeof candidate.selection === "object" &&
    typeof candidate.history === "object" &&
    typeof candidate.metadata === "object" &&
    typeof candidate.attention === "object"
  );
}

/**
 * Rebuild a document state from a checkpoint.
 *
 * The result is a plain `DocumentState<'eager'>` — pass it to
 * `store.createDocumentStoreFromCheckpoint` for a live store, or read it
 * directly with the `query` / `scan` namespaces.
 *
 * Validation is exhaustive and fail-closed. Anything that would break a
 * documented invariant — a piece reading past its buffer, lines that do not
 * cover the document, an attention anchored to a piece that is not there, an
 * allocator cursor that would reissue a live id — raises `CheckpointError` with
 * a `code` naming the failure.
 *
 * @throws CheckpointError when the payload is not a restorable checkpoint
 */
export function restoreCheckpoint(checkpoint: DocumentCheckpoint): DocumentState<"eager"> {
  const source = readObject(checkpoint, "checkpoint");

  if (source.format !== CHECKPOINT_FORMAT) {
    fail(
      "NOT_A_CHECKPOINT",
      `expected format '${CHECKPOINT_FORMAT}' but found ${JSON.stringify(source.format)}`,
    );
  }
  const version = readCount(source.version, "checkpoint.version");
  if (version > CHECKPOINT_VERSION) {
    fail(
      "VERSION_UNSUPPORTED",
      `checkpoint version ${version} was written by a newer Reed; this build reads up to version ${CHECKPOINT_VERSION}`,
    );
  }
  readEnum(source.mode, ["exact", "normalized"] as const, "checkpoint.mode");

  const revision = readCount(source.revision, "checkpoint.revision");
  const { pieceTable, lengthByID } = restorePieceTable(source.pieceTable);

  return Object.freeze({
    revision,
    selectionRevision: readCount(source.selectionRevision, "checkpoint.selectionRevision"),
    pieceTable,
    lineIndex: restoreLineIndex(source.lineIndex, pieceTable.totalLength, revision),
    selection: restoreSelection(source.selection, "selection", pieceTable.totalLength),
    history: restoreHistory(source.history),
    metadata: restoreMetadata(source.metadata),
    attention: restoreAttention(source.attention, lengthByID),
  });
}

/**
 * Parse and restore a checkpoint string produced by `encodeCheckpoint`.
 *
 * @throws CheckpointError when the string is not valid JSON or not a restorable
 *         checkpoint
 */
export function decodeCheckpoint(json: string): DocumentState<"eager"> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    fail("NOT_A_CHECKPOINT", `checkpoint is not valid JSON: ${(error as Error).message}`);
  }
  return restoreCheckpoint(parsed as DocumentCheckpoint);
}
