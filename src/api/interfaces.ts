/**
 * Explicit interface types for API namespaces.
 *
 * These contracts pin the public shape of each namespace (parameter and return
 * types) and are applied with `satisfies` on each namespace export:
 *   export const query = { ... } satisfies QueryApi;
 *
 * Returns are plain (unbranded): the `cost-doc` algebra is an implementation
 * detail of `store/core`, stripped at the `api/*` boundary via `$uncostedFn`.
 * Algorithmic complexity is documented with `@complexity` JSDoc tags on each
 * namespace member instead of being carried in the type.
 */

import type {
  DocumentState,
  HistoryState,
  LineIndexState,
  LineIndexNode,
  PieceTableState,
  PieceNode,
} from "../types/state.js";
import type { ByteOffset, ByteLength, CharOffset, AttentionID } from "../types/branded.js";
import type { LineLocation } from "../store/core/line-index.js";
import type {
  PieceLocation,
  BufferStats,
  DocumentChunk,
  StreamOptions,
  SplitRecord,
} from "../store/core/piece-table.js";
import type {
  AttentionPoint,
  Attention,
  AttentionLayerState,
  ResolvedRange,
} from "../types/attention.js";
import type {
  InsertWithAttentionResult,
  DeleteWithAttentionResult,
} from "../store/core/attention.js";

// =============================================================================
// Query namespace interfaces
// =============================================================================

/**
 * Contract for the `query.lineIndex` sub-namespace.
 * Low-level selectors operating directly on LineIndexState / LineIndexNode.
 */
export interface QueryLineIndexApi {
  findLineAtPosition(root: LineIndexNode | null, position: ByteOffset): LineLocation | null;
  findLineByNumber(root: LineIndexNode | null, lineNumber: number): LineIndexNode | null;
  getLineStartOffset(root: LineIndexNode | null, lineNumber: number): ByteOffset;
  getLineRange(
    state: LineIndexState<"eager">,
    lineNumber: number,
  ): { start: ByteOffset; length: ByteLength } | null;
  getLineRangePrecise(
    state: LineIndexState,
    lineNumber: number,
  ): { start: ByteOffset; length: ByteLength } | null;
  getLineCount(state: LineIndexState): number;
  getCharStartOffset(root: LineIndexNode | null, lineNumber: number): CharOffset;
  findLineAtCharPosition(
    root: LineIndexNode | null,
    charPosition: number,
  ): { lineNumber: number; charOffsetInLine: number } | null;
}

/**
 * Contract for the `query` namespace.
 * All operations are O(1) or O(log n) — see the `@complexity` tags on `query`.
 */
export interface QueryApi {
  getText(state: PieceTableState, start: ByteOffset, end: ByteOffset): string;
  getLength(state: PieceTableState): number;
  getBufferStats(state: PieceTableState): BufferStats;
  findPieceAtPosition(root: PieceNode | null, position: ByteOffset): PieceLocation | null;
  isReconciledState(state: DocumentState): boolean;
  findLineAtPosition(state: DocumentState, position: ByteOffset): LineLocation | null;
  findLineByNumber(state: DocumentState, lineNumber: number): LineIndexNode | null;
  getLineStartOffset(state: DocumentState, lineNumber: number): ByteOffset;
  getLineRange(
    state: DocumentState<"eager">,
    lineNumber: number,
  ): { start: ByteOffset; length: ByteLength } | null;
  getLineRangeChecked(
    state: DocumentState,
    lineNumber: number,
  ): { start: ByteOffset; length: ByteLength } | null;
  getLineRangePrecise(
    state: DocumentState,
    lineNumber: number,
  ): { start: ByteOffset; length: ByteLength } | null;
  getLineCount(state: DocumentState): number;
  getCharStartOffset(state: DocumentState, lineNumber: number): CharOffset;
  findLineAtCharPosition(
    state: DocumentState,
    charPosition: number,
  ): { lineNumber: number; charOffsetInLine: number } | null;
  getSelectionHead(state: DocumentState): ByteOffset | undefined;
  lineIndex: QueryLineIndexApi;
}

// =============================================================================
// Scan namespace interface
// =============================================================================

/**
 * Contract for the `scan` namespace.
 * All operations are O(n) — see the `@complexity` tags on `scan`.
 */
export interface ScanApi {
  getValue(state: PieceTableState): string;
  getValueStream(
    state: PieceTableState,
    options?: StreamOptions,
  ): Generator<DocumentChunk, void, undefined>;
  collectPieces(root: PieceNode | null): readonly PieceNode[];
  collectLines(root: LineIndexNode | null): readonly LineIndexNode[];
  rebuildLineIndex(content: string): LineIndexState;
}

// =============================================================================
// History namespace interface
// =============================================================================

/**
 * Contract for the `history` namespace.
 * All operations are O(1) — see the `@complexity` tags on `history`.
 */
export interface HistoryApi {
  canUndo(state: DocumentState | HistoryState): boolean;
  canRedo(state: DocumentState | HistoryState): boolean;
  getUndoCount(state: DocumentState | HistoryState): number;
  getRedoCount(state: DocumentState | HistoryState): number;
  isHistoryEmpty(state: DocumentState | HistoryState): boolean;
}

// =============================================================================
// Attention namespace interface
// =============================================================================

/**
 * Contract for the `attention` namespace.
 * Mixed complexity — see the `@complexity` tags on `attention`.
 */
export interface AttentionApi {
  emptyState: AttentionLayerState;
  createPoint(root: PieceNode | null, offset: ByteOffset): AttentionPoint | null;
  resolvePoint(root: PieceNode | null, point: AttentionPoint): ByteOffset | null;
  createAttention(
    state: AttentionLayerState,
    start: AttentionPoint,
    end: AttentionPoint,
  ): [AttentionLayerState, AttentionID];
  getAttention(state: AttentionLayerState, id: AttentionID): Attention | null;
  deleteAttention(state: AttentionLayerState, id: AttentionID): AttentionLayerState;
  resolveAttention(
    root: PieceNode | null,
    state: AttentionLayerState,
    id: AttentionID,
  ): ResolvedRange | null;
  getTextForAttention(
    pieceTableState: PieceTableState,
    attentionState: AttentionLayerState,
    id: AttentionID,
  ): string | null;
  findAttentionsAt(
    state: AttentionLayerState,
    root: PieceNode | null,
    offset: number,
  ): AttentionID[];
  findAttentionsOverlapping(
    state: AttentionLayerState,
    root: PieceNode | null,
    start: number,
    end: number,
  ): AttentionID[];
  insertWithAttention(
    pieceTableState: PieceTableState,
    attentionState: AttentionLayerState,
    position: ByteOffset,
    text: string,
  ): InsertWithAttentionResult;
  deleteWithAttention(
    pieceTableState: PieceTableState,
    attentionState: AttentionLayerState,
    start: ByteOffset,
    end: ByteOffset,
  ): DeleteWithAttentionResult;
  migrateSplits(state: AttentionLayerState, splits: readonly SplitRecord[]): AttentionLayerState;
  migrateDelete(
    state: AttentionLayerState,
    oldRoot: PieceNode | null,
    newRoot: PieceNode | null,
    start: number,
    end: number,
  ): AttentionLayerState;
}
