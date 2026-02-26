/**
 * Query namespace — O(1), O(log n), and bounded linear operations.
 * Functions here are read-only selectors over immutable document state.
 */

import type { DocumentState } from '../types/state.ts';
import {
  getText,
  getLength,
  findPieceAtPosition,
  getBufferStats,
} from '../store/core/piece-table.ts';
import {
  findLineAtPosition as findLineAtPositionFromRoot,
  getLineRange as getLineRangeFromIndex,
  getLineRangePrecise as getLineRangePreciseFromIndex,
  getLineCountFromIndex as getLineCountFromIndexState,
  getCharStartOffset as getCharStartOffsetFromRoot,
  findLineAtCharPosition as findLineAtCharPositionFromRoot,
} from '../store/core/line-index.ts';
import { asEagerLineIndex } from '../store/core/state.ts';
import {
  getLineContent,
  getVisibleLine,
  getVisibleLines,
  positionToLineColumn,
  lineColumnToPosition,
} from '../store/features/rendering.ts';

function isReconciledState(state: DocumentState): state is DocumentState<'eager'> {
  return state.lineIndex.rebuildPending === false && state.lineIndex.dirtyRanges.length === 0;
}

function assertReconciledState(state: DocumentState): asserts state is DocumentState<'eager'> {
  if (!isReconciledState(state)) {
    throw new Error(
      'Line index is not reconciled. Call store.reconcileNow() first or use query.getLineRangePrecise().'
    );
  }
}

function findLineAtPosition(
  state: DocumentState,
  position: Parameters<typeof findLineAtPositionFromRoot>[1]
) {
  return findLineAtPositionFromRoot(state.lineIndex.root, position);
}

function getLineRange(state: DocumentState<'eager'>, lineNumber: number) {
  return getLineRangeFromIndex(state.lineIndex, lineNumber);
}

function getLineRangeChecked(state: DocumentState, lineNumber: number) {
  return getLineRangeFromIndex(asEagerLineIndex(state.lineIndex), lineNumber);
}

function getLineRangePrecise(state: DocumentState, lineNumber: number) {
  return getLineRangePreciseFromIndex(state.lineIndex, lineNumber);
}

function getLineCount(state: DocumentState) {
  return getLineCountFromIndexState(state.lineIndex);
}

function getCharStartOffset(state: DocumentState, lineNumber: number) {
  return getCharStartOffsetFromRoot(state.lineIndex.root, lineNumber);
}

function findLineAtCharPosition(state: DocumentState, charPosition: number) {
  return findLineAtCharPositionFromRoot(state.lineIndex.root, charPosition);
}

export const query = {
  /** @complexity O(log n + m) — tree traversal to collect byte range */
  getText,
  /** @complexity O(1) — cached totalLength on piece table state */
  getLength,
  /** @complexity O(1) — cached on piece table state */
  getBufferStats,
  /** @complexity O(log n) — tree walk to find piece at position */
  findPieceAtPosition,
  /** @complexity O(1) — runtime mode check for line-index cleanliness */
  isReconciledState,
  /** @complexity O(1) — runtime assertion with narrowed mode on success */
  assertReconciledState,
  /** @complexity O(log n) — tree walk to find line at byte position */
  findLineAtPosition,
  /** @complexity O(log n) — tree walk; requires eager DocumentState */
  getLineRange,
  /** @complexity O(log n) — runtime-checked eager range; throws on dirty lazy state */
  getLineRangeChecked,
  /** @complexity O(log n) — range lookup safe for eager and lazy states */
  getLineRangePrecise,
  /** @complexity O(1) — cached lineCount */
  getLineCount,
  /** @complexity O(log n) — prefix sum via subtreeCharLength */
  getCharStartOffset,
  /** @complexity O(log n) — tree descent via subtreeCharLength */
  findLineAtCharPosition,
  /** @complexity O(log n + line_length) — line lookup + text extraction */
  getLineContent,
  /** @complexity O(log n + line_length) — single line lookup and text extraction */
  getVisibleLine,
  /** @complexity O(k * log n) — k line lookups for visible range */
  getVisibleLines,
  /** @complexity O(log n + line_length) — byte position to line/column */
  positionToLineColumn,
  /** @complexity O(log n + line_length) — line/column to byte position */
  lineColumnToPosition,
  /** Low-level line-index selectors for callers operating directly on LineIndexState/root. */
  lineIndex: {
    findLineAtPosition: findLineAtPositionFromRoot,
    getLineRange: getLineRangeFromIndex,
    getLineRangePrecise: getLineRangePreciseFromIndex,
    getLineCount: getLineCountFromIndexState,
    getCharStartOffset: getCharStartOffsetFromRoot,
    findLineAtCharPosition: findLineAtCharPositionFromRoot,
  },
} as const;
