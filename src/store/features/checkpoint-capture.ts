/** Capture an eager document state as a JSON-safe checkpoint. */
import type {
  DocumentState,
  PieceTableState,
  PieceNode,
  LineIndexState,
  SelectionState,
  HistoryState,
  HistoryEntry,
  HistoryChange,
  DocumentMetadata,
  ChunkMetadata,
} from "../../types/state.js";
import { pstackToArray } from "../../types/state.js";
import type { AttentionLayerState, Attention } from "../../types/attention.js";
import type { AttentionID, ReadonlyUint8Array } from "../../types/branded.js";
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
import { createPieceTableState, createLineIndexState } from "../core/state.js";
import { collectPieces, compactAddBuffer, getValue } from "../core/piece-table.js";
import { collectLines } from "../core/line-index.js";
import { createPoint, resolveAttention } from "../core/attention.js";
import { encodeBase64 } from "../core/base64.js";
import { asReadonlyMap, unwrapReadonlyUint8Array } from "../core/runtime-readonly.js";

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
