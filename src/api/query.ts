/**
 * Query namespace — O(1), O(log n), and bounded linear operations.
 * Functions here are read-only selectors over immutable document state.
 * For O(n) traversals see `scan.*`. For rendering utilities see `rendering.*`.
 */

import type { DocumentState } from '../types/state.ts';
import { $constCostFn } from '../types/cost.ts';
import {
  getText,
  getLength,
  findPieceAtPosition,
  getBufferStats,
} from '../store/core/piece-table.ts';
import {
  findLineAtPosition as findLineAtPositionFromRoot,
  findLineByNumber as findLineByNumberFromRoot,
  getLineStartOffset as getLineStartOffsetFromRoot,
  getLineRange as getLineRangeFromIndex,
  getLineRangePrecise as getLineRangePreciseFromIndex,
  getLineCountFromIndex as getLineCountFromIndexState,
  getCharStartOffset as getCharStartOffsetFromRoot,
  findLineAtCharPosition as findLineAtCharPositionFromRoot,
} from '../store/core/line-index.ts';
import { asEagerLineIndex } from '../store/core/state.ts';
import type { QueryApi } from './interfaces.ts';

function isReconciledState(state: DocumentState): state is DocumentState<'eager'> {
  return state.lineIndex.rebuildPending === false && state.lineIndex.dirtyRanges.length === 0;
}


function findLineAtPosition(
  state: DocumentState,
  position: Parameters<typeof findLineAtPositionFromRoot>[1]
) {
  return findLineAtPositionFromRoot(state.lineIndex.root, position);
}

function findLineByNumber(state: DocumentState, lineNumber: number) {
  return findLineByNumberFromRoot(state.lineIndex.root, lineNumber);
}

function getLineStartOffset(state: DocumentState, lineNumber: number) {
  return getLineStartOffsetFromRoot(state.lineIndex.root, lineNumber);
}

/**
 * Return the byte range of a line. Requires an eager state (all offsets resolved).
 *
 * Use this when the caller already holds a `DocumentState<'eager'>` — e.g. the
 * result of `store.reconcileNow()` or after an undo/redo operation.
 * Guaranteed non-null at compile time; no runtime check overhead.
 *
 * Decision guide:
 *  - Caller has eager state (post-reconcile, undo/redo) → use `getLineRange`
 *  - Caller has unknown state and wants a throw on violation → use `getLineRangeChecked`
 *  - Caller needs best-effort from any state, tolerates null → use `getLineRangePrecise`
 *  - Caller needs to reconcile on demand → call `store.reconcileNow()` first
 */
function getLineRange(state: DocumentState<'eager'>, lineNumber: number) {
  return getLineRangeFromIndex(state.lineIndex, lineNumber);
}

/**
 * Return the byte range of a line after asserting the state is eager at runtime.
 *
 * Accepts any `DocumentState` but throws if `dirtyRanges` is non-empty or
 * `rebuildPending` is true (`asEagerLineIndex` invariant). Use when the caller
 * cannot guarantee eager state at compile time but wants an explicit failure
 * rather than a silent null.
 *
 * @throws if state has unreconciled dirty ranges or a pending rebuild
 */
function getLineRangeChecked(state: DocumentState, lineNumber: number) {
  return getLineRangeFromIndex(asEagerLineIndex(state.lineIndex), lineNumber);
}

/**
 * Return the byte range of a line without requiring reconciliation.
 *
 * Works on any `DocumentState` regardless of mode. Returns `null` for the
 * `documentOffset` field on lines whose offsets have not yet been computed
 * (lazy state, post-edit before reconciliation). Use when rendering or
 * displaying lines where a best-effort result is acceptable and reconciliation
 * overhead must be avoided on the critical path.
 */
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
  isReconciledState: $constCostFn(isReconciledState),
/** @complexity O(log n) — tree walk to find line at byte position */
  findLineAtPosition,
  /** @complexity O(log n) — tree walk to find line by 1-based line number */
  findLineByNumber,
  /** @complexity O(log n) — byte offset of line start via prefix sum */
  getLineStartOffset,
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
  /** Low-level line-index selectors for callers operating directly on LineIndexState/root. */
  lineIndex: {
    findLineAtPosition: findLineAtPositionFromRoot,
    findLineByNumber: findLineByNumberFromRoot,
    getLineStartOffset: getLineStartOffsetFromRoot,
    getLineRange: getLineRangeFromIndex,
    getLineRangePrecise: getLineRangePreciseFromIndex,
    getLineCount: getLineCountFromIndexState,
    getCharStartOffset: getCharStartOffsetFromRoot,
    findLineAtCharPosition: findLineAtCharPositionFromRoot,
  },
} satisfies QueryApi;
