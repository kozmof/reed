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
  HistorySelectionState,
  DocumentMetadata,
  ChunkMetadata,
} from "../../types/state.js";
import { pstackToArray } from "../../types/state.js";
import type { AttentionLayerState } from "../../types/attention.js";
import { byteOffset, type ReadonlyUint8Array } from "../../types/branded.js";
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
  CheckpointHistorySelection,
  CheckpointMetadata,
  CheckpointAttention,
  CheckpointAttentionLayer,
  CheckpointErrorCode,
} from "../../types/checkpoint.js";
import { CHECKPOINT_FORMAT, CHECKPOINT_VERSION, CheckpointError } from "../../types/checkpoint.js";
import { collectPieces, compactAddBuffer, getBytes } from "../core/piece-table.js";
import { collectLines } from "../core/line-index.js";
import { resolveAllAttentions } from "../core/attention.js";
import { encodeBase64 } from "../core/base64.js";
import { unwrapReadonlyUint8Array } from "../core/runtime-readonly.js";
import { scanPieceLines } from "../core/decoded-metrics.js";

function fail(code: CheckpointErrorCode, message: string): never {
  throw new CheckpointError(code, message);
}

// =============================================================================
// Capture
// =============================================================================

const BUFFER_TAG = { original: "o", add: "a", chunk: "c" } as const;

function capturePiece(piece: PieceNode): CheckpointPiece {
  switch (piece.bufferType) {
    case "chunk":
      return [piece.id, "c", piece.start, piece.length, piece.chunkIndex];
    case "add":
      return piece.afterChunk === -1
        ? [piece.id, BUFFER_TAG.add, piece.start, piece.length]
        : [piece.id, BUFFER_TAG.add, piece.start, piece.length, piece.afterChunk];
    case "original":
      return [piece.id, BUFFER_TAG.original, piece.start, piece.length];
  }
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

/**
 * Capture the live selection with the placement keys it stores (see
 * `SelectionRange.anchorAfterChunk`). Every action that changes the document
 * moves the selection with it, so a stored key fits its offset.
 */
function captureSelection(selection: SelectionState): CheckpointSelection {
  return captureRanges(selection, null);
}

/** Capture a history selection, whose key -1 means no chunk (see `HistoryAnchor`). */
function captureHistorySelection(selection: HistorySelectionState): CheckpointHistorySelection {
  return captureRanges(selection, -1);
}

/**
 * Capture a live or history selection as `[anchor, head]` ranges, followed by
 * both placement keys unless both are `none`. A key the range does not store
 * is written as `none`. Both selection formats share this one wire shape and
 * differ only in what stands for "no key".
 */
function captureRanges<N extends null | -1>(
  selection: {
    readonly ranges: readonly {
      readonly anchor: number;
      readonly head: number;
      readonly anchorAfterChunk?: number | undefined;
      readonly headAfterChunk?: number | undefined;
    }[];
    readonly primaryIndex: number;
  },
  none: N,
): {
  ranges: (readonly [number, number] | readonly [number, number, number | N, number | N])[];
  primaryIndex: number;
} {
  return {
    ranges: selection.ranges.map((range) => {
      const anchorKey: number | N = range.anchorAfterChunk ?? none;
      const headKey: number | N = range.headAfterChunk ?? none;
      const keyless = anchorKey === none && headKey === none;
      return keyless
        ? ([range.anchor, range.head] as const)
        : ([range.anchor, range.head, anchorKey, headKey] as const);
    }),
    primaryIndex: selection.primaryIndex,
  };
}

function captureBytes(bytes: ReadonlyUint8Array | undefined): string | undefined {
  return bytes === undefined ? undefined : encodeBase64(unwrapReadonlyUint8Array(bytes));
}

function captureHistoryChange(change: HistoryChange): CheckpointHistoryChange {
  const bytes = captureBytes(change.bytes);
  switch (change.type) {
    case "insert":
    case "delete": {
      const kind = change.type === "insert" ? "i" : "d";
      if (bytes !== undefined)
        return [kind, change.position, change.text, change.afterChunk, bytes];
      return change.afterChunk !== -1
        ? [kind, change.position, change.text, change.afterChunk]
        : [kind, change.position, change.text];
    }
    case "replace": {
      const oldBytes = captureBytes(change.oldBytes);
      const head = ["r", change.position, change.text, change.oldText] as const;
      if (oldBytes !== undefined) return [...head, change.afterChunk, bytes ?? null, oldBytes];
      if (bytes !== undefined) return [...head, change.afterChunk, bytes];
      return change.afterChunk !== -1 ? [...head, change.afterChunk] : head;
    }
  }
}

function captureHistoryEntry(entry: HistoryEntry): CheckpointHistoryEntry {
  return {
    changes: entry.changes.map(captureHistoryChange),
    selectionBefore: captureHistorySelection(entry.selectionBefore),
    selectionAfter: captureHistorySelection(entry.selectionAfter),
    timestamp: entry.timestamp,
  };
}

function captureHistory(history: HistoryState): CheckpointHistory {
  return {
    limit: history.limit,
    coalesceTimeout: history.coalesceTimeout,
    evictionPolicy: history.evictionPolicy,
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
 * Capture normalized wire data directly instead of first constructing a second
 * piece tree and line tree. This keeps peak memory close to the content bytes
 * plus the final checkpoint payload.
 */
function captureNormalizedCheckpoint(state: DocumentState<"eager">): DocumentCheckpoint {
  if (state.pieceTable.chunkSize > 0) {
    fail(
      "CHUNKED_NORMALIZE",
      "normalized capture is not available for chunked documents: flattening a partially-loaded file to text would drop its unloaded ranges",
    );
  }

  // Copy the bytes as they are. Decoding and re-encoding would drop a leading
  // U+FEFF and turn malformed bytes into U+FFFD. Either changes the byte
  // length and moves every history position recorded against these bytes.
  const total = state.pieceTable.totalLength;
  const bytes = getBytes(state.pieceTable, byteOffset(0), byteOffset(total));
  // Lines split and counted by the same scan the line index uses, so restore
  // accepts them.
  const lines = scanPieceLines(state.pieceTable, 0, total).map(
    ({ length, charLength }): CheckpointLine => [length, charLength],
  );

  const attentions: CheckpointAttention[] = [];
  if (bytes.length > 0) {
    const resolved = resolveAllAttentions(state.pieceTable.root, state.attention);
    for (const entry of state.attention.attentions.values()) {
      const range = resolved.get(entry.id);
      if (range === undefined) continue;
      attentions.push([entry.id, "p0", range.startOffset, "p0", range.endOffset]);
    }
  }

  return {
    format: CHECKPOINT_FORMAT,
    version: CHECKPOINT_VERSION,
    mode: "normalized",
    revision: state.revision,
    selectionRevision: state.selectionRevision,
    pieceTable: {
      nextPieceID: bytes.length === 0 ? 0 : 1,
      totalLength: bytes.length,
      originalBuffer: encodeBase64(bytes),
      addBuffer: "",
      chunkSize: 0,
      nextExpectedChunk: 0,
      totalFileSize: 0,
      loadedChunks: [],
      chunks: [],
      chunkMetadata: [],
      pieces: bytes.length === 0 ? [] : [["p0", "o", 0, bytes.length]],
    },
    lineIndex: {
      maxDirtyRanges: state.lineIndex.maxDirtyRanges,
      unloadedLineCounts: [],
      lines,
    },
    selection: captureSelection(state.selection),
    history: captureHistory(state.history),
    metadata: captureMetadata(state.metadata),
    attention: { nextID: state.attention.nextID, attentions },
  };
}

/**
 * Capture a document state as a JSON-safe checkpoint.
 *
 * Obtain an eager state with `store.getEagerSnapshot()`, `store.reconcileNow()`,
 * or `await store.whenReconciled()`. The eager type requires resolved line
 * offsets at capture time.
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

  if (mode === "normalized") {
    return captureNormalizedCheckpoint(state);
  }

  let source = state;
  if (compact) {
    // threshold 0 forces compaction for any amount of waste,
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
