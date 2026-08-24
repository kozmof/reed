/**
 * Query namespace — O(1), O(log n), and bounded linear operations.
 * Functions here are read-only selectors over immutable document state.
 * For O(n) traversals see `scan.*`. For rendering utilities see `rendering.*`.
 */

import type { DocumentState } from "../types/state.js";
import type { ByteOffset } from "../types/branded.js";
import { $uncostedFn } from "../types/cost-doc.js";
import {
  getText,
  getLength,
  isUtf8Boundary,
  findPieceAtPosition,
  getBufferStats,
} from "../store/core/piece-table.js";
import {
  findLineAtPosition as findLineAtPositionFromRoot,
  findLineByNumber as findLineByNumberFromRoot,
  getLineStartOffset as getLineStartOffsetFromRoot,
  getLineRange as getLineRangeFromIndex,
  getLineRangePrecise as getLineRangePreciseFromIndex,
  getLineCountFromIndex as getLineCountFromIndexState,
  getCharStartOffset as getCharStartOffsetFromRoot,
  findLineAtCharPosition as findLineAtCharPositionFromRoot,
} from "../store/core/line-index.js";
import { asEagerLineIndex } from "../store/core/state.js";
import type { QueryApi } from "./interfaces.js";

function getTextAtBoundaries(
  state: Parameters<typeof getText>[0],
  start: Parameters<typeof getText>[1],
  end: Parameters<typeof getText>[2],
) {
  if (!isUtf8Boundary(state, start)) {
    throw new RangeError(`text start (${start}) must be a UTF-8 code-point boundary`);
  }
  if (!isUtf8Boundary(state, end)) {
    throw new RangeError(`text end (${end}) must be a UTF-8 code-point boundary`);
  }
  return getText(state, start, end);
}

function isReconciledState(state: DocumentState): state is DocumentState<"eager"> {
  return state.lineIndex.rebuildPending === false && state.lineIndex.dirtyRanges.length === 0;
}

function findLineAtPosition(
  state: DocumentState,
  position: Parameters<typeof findLineAtPositionFromRoot>[1],
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
function getLineRange(state: DocumentState<"eager">, lineNumber: number) {
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
 * Works on any `DocumentState` regardless of mode. The range stays exact in lazy
 * states because it is derived from current subtree byte-length aggregates rather
 * than cached `documentOffset` values. Returns `null` only when the line does not
 * exist.
 */
function getLineRangePrecise(state: DocumentState, lineNumber: number) {
  return getLineRangePreciseFromIndex(state.lineIndex, lineNumber);
}

function getResidentLineCount(state: DocumentState): number {
  return state.lineIndex.lineCount;
}

function getLineCountInfo(state: DocumentState) {
  const resident = state.lineIndex.lineCount;
  const unloaded = state.lineIndex.unloadedLineCount;
  return Object.freeze({
    resident,
    unloaded,
    expected: resident + unloaded,
    isComplete: unloaded === 0,
  });
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

/**
 * Return the head ByteOffset of the primary selection range.
 * Convenience accessor for reading cursor position after undo/redo without
 * indexing into ranges manually or casting through `as unknown as number`.
 * Returns undefined when the selection has no ranges.
 */
function getSelectionHead(state: DocumentState): ByteOffset | undefined {
  return state.selection.ranges[state.selection.primaryIndex]?.head;
}

export const query: QueryApi = {
  /** @complexity O(log n + m) — tree traversal to collect byte range */
  getText: $uncostedFn(getTextAtBoundaries),
  /** @complexity O(1) — cached totalLength on piece table state */
  getLength: $uncostedFn(getLength),
  /** @complexity O(log n) — checks the byte at the requested document position */
  isUtf8Boundary,
  /** @complexity O(1) — cached on piece table state */
  getBufferStats: $uncostedFn(getBufferStats),
  /** @complexity O(log n) — tree walk to find piece at position */
  findPieceAtPosition: $uncostedFn(findPieceAtPosition),
  /** @complexity O(1) — runtime mode check for line-index cleanliness */
  isReconciledState,
  /** @complexity O(h) — tree walk to find line at byte position */
  findLineAtPosition: $uncostedFn(findLineAtPosition),
  /** @complexity O(h) — tree walk to find line by 0-based line number */
  findLineByNumber: $uncostedFn(findLineByNumber),
  /** @complexity O(h) — byte offset of line start via prefix sum */
  getLineStartOffset: $uncostedFn(getLineStartOffset),
  /** @complexity O(h) — tree walk; requires eager DocumentState */
  getLineRange: $uncostedFn(getLineRange),
  /** @complexity O(h) — runtime-checked eager range; throws on dirty lazy state */
  getLineRangeChecked: $uncostedFn(getLineRangeChecked),
  /** @complexity O(h) — range lookup safe for eager and lazy states */
  getLineRangePrecise: $uncostedFn(getLineRangePrecise),
  /** @complexity O(1) — lines represented by the resident line tree */
  getResidentLineCount,
  /** @complexity O(1) — resident, unloaded, and expected line counts */
  getLineCountInfo,
  /** @complexity O(1) — cached lineCount */
  getLineCount: $uncostedFn(getLineCount),
  /** @complexity O(h) — prefix sum via subtreeCharLength */
  getCharStartOffset: $uncostedFn(getCharStartOffset),
  /** @complexity O(h) — tree descent via subtreeCharLength */
  findLineAtCharPosition: $uncostedFn(findLineAtCharPosition),
  /** @complexity O(1) — index into selection.ranges array */
  getSelectionHead,
  /** Low-level line-index selectors for callers operating directly on LineIndexState/root. */
  lineIndex: {
    findLineAtPosition: $uncostedFn(findLineAtPositionFromRoot),
    findLineByNumber: $uncostedFn(findLineByNumberFromRoot),
    getLineStartOffset: $uncostedFn(getLineStartOffsetFromRoot),
    getLineRange: $uncostedFn(getLineRangeFromIndex),
    getLineRangePrecise: $uncostedFn(getLineRangePreciseFromIndex),
    getLineCount: $uncostedFn(getLineCountFromIndexState),
    getCharStartOffset: $uncostedFn(getCharStartOffsetFromRoot),
    findLineAtCharPosition: $uncostedFn(findLineAtCharPositionFromRoot),
  },
};
