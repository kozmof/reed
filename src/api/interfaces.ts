/**
 * Explicit interface types for API namespaces.
 * Every function signature carries a cost-typed return value,
 * enforcing that callers can observe the algorithmic complexity
 * at the type level.
 *
 * Apply with `satisfies` on each namespace export:
 *   export const query = { ... } satisfies QueryApi;
 */

import type { ConstCost, LogCost, LinearCost } from "../types/cost-doc.ts";
import type {
  DocumentState,
  HistoryState,
  LineIndexState,
  LineIndexNode,
  PieceTableState,
  PieceNode,
} from "../types/state.ts";
import type { ByteOffset, ByteLength } from "../types/branded.ts";
import type { LineLocation } from "../store/core/line-index.ts";
import type {
  PieceLocation,
  BufferStats,
  DocumentChunk,
  StreamOptions,
} from "../store/core/piece-table.ts";

// =============================================================================
// Query namespace interfaces
// =============================================================================

/**
 * Contract for the `query.lineIndex` sub-namespace.
 * Low-level selectors operating directly on LineIndexState / LineIndexNode.
 */
export interface QueryLineIndexApi {
  findLineAtPosition(
    root: LineIndexNode | null,
    position: ByteOffset,
  ): LogCost<LineLocation> | null;
  findLineByNumber(root: LineIndexNode | null, lineNumber: number): LogCost<LineIndexNode> | null;
  getLineStartOffset(root: LineIndexNode | null, lineNumber: number): LogCost<number>;
  getLineRange(
    state: LineIndexState<"eager">,
    lineNumber: number,
  ): LogCost<{ start: ByteOffset; length: ByteLength }> | null;
  getLineRangePrecise(
    state: LineIndexState,
    lineNumber: number,
  ): LogCost<{ start: ByteOffset; length: ByteLength }> | null;
  getLineCount(state: LineIndexState): ConstCost<number>;
  getCharStartOffset(root: LineIndexNode | null, lineNumber: number): LogCost<number>;
  findLineAtCharPosition(
    root: LineIndexNode | null,
    charPosition: number,
  ): LogCost<{ lineNumber: number; charOffsetInLine: number }> | null;
}

/**
 * Contract for the `query` namespace.
 * All operations are O(1) or O(log n); return types carry explicit cost brands.
 */
export interface QueryApi {
  getText(state: PieceTableState, start: ByteOffset, end: ByteOffset): LinearCost<string>;
  getLength(state: PieceTableState): ConstCost<number>;
  getBufferStats(state: PieceTableState): ConstCost<BufferStats>;
  findPieceAtPosition(root: PieceNode | null, position: ByteOffset): LogCost<PieceLocation> | null;
  isReconciledState(state: DocumentState): ConstCost<boolean>;
  findLineAtPosition(state: DocumentState, position: ByteOffset): LogCost<LineLocation> | null;
  findLineByNumber(state: DocumentState, lineNumber: number): LogCost<LineIndexNode> | null;
  getLineStartOffset(state: DocumentState, lineNumber: number): LogCost<number>;
  getLineRange(
    state: DocumentState<"eager">,
    lineNumber: number,
  ): LogCost<{ start: ByteOffset; length: ByteLength }> | null;
  getLineRangeChecked(
    state: DocumentState,
    lineNumber: number,
  ): LogCost<{ start: ByteOffset; length: ByteLength }> | null;
  getLineRangePrecise(
    state: DocumentState,
    lineNumber: number,
  ): LogCost<{ start: ByteOffset; length: ByteLength }> | null;
  getLineCount(state: DocumentState): ConstCost<number>;
  getCharStartOffset(state: DocumentState, lineNumber: number): LogCost<number>;
  findLineAtCharPosition(
    state: DocumentState,
    charPosition: number,
  ): LogCost<{ lineNumber: number; charOffsetInLine: number }> | null;
  getSelectionHead(state: DocumentState): ConstCost<ByteOffset | undefined>;
  lineIndex: QueryLineIndexApi;
}

// =============================================================================
// Scan namespace interface
// =============================================================================

/**
 * Contract for the `scan` namespace.
 * All operations are O(n); return types carry LinearCost brands.
 */
export interface ScanApi {
  getValue(state: PieceTableState): LinearCost<string>;
  getValueStream(
    state: PieceTableState,
    options?: StreamOptions,
  ): LinearCost<Generator<DocumentChunk, void, undefined>>;
  collectPieces(root: PieceNode | null): LinearCost<readonly PieceNode[]>;
  collectLines(root: LineIndexNode | null): LinearCost<readonly LineIndexNode[]>;
  rebuildLineIndex(content: string): LinearCost<LineIndexState>;
}

// =============================================================================
// History namespace interface
// =============================================================================

/**
 * Contract for the `history` namespace.
 * All operations are O(1); return types carry ConstCost brands.
 */
export interface HistoryApi {
  canUndo(state: DocumentState | HistoryState): ConstCost<boolean>;
  canRedo(state: DocumentState | HistoryState): ConstCost<boolean>;
  getUndoCount(state: DocumentState | HistoryState): ConstCost<number>;
  getRedoCount(state: DocumentState | HistoryState): ConstCost<number>;
  isHistoryEmpty(state: DocumentState | HistoryState): ConstCost<boolean>;
}
