/**
 * Pure edit-pipeline functions for the Reed document editor.
 *
 * Extracted from reducer.ts so that applyEdit, applyChange, and their helpers
 * can be tested and imported in isolation without pulling in the full reducer.
 *
 * History-push logic (historyPush) lives here because applyEdit calls it
 * directly. historyUndo / historyRedo live in history.ts and import the
 * applyChange / applyInverseChange functions exported below.
 */

import type {
  DocumentState,
  LineIndexState,
  HistoryEntry,
  HistoryChange,
  HistoryInsertChange,
  HistoryDeleteChange,
  HistoryReplaceChange,
  SelectionState,
  SelectionRange,
  NonEmptyReadonlyArray,
} from "../../types/state.ts";
import { pstackPush, pstackPeek, pstackPop, pstackTrimToSize } from "../../types/state.ts";
import type { ByteOffset } from "../../types/branded.ts";
import type { DeleteBoundaryContext, ReadTextFn } from "../../types/operations.ts";
import { byteOffset, byteLength } from "../../types/branded.ts";
import { withState, withLineIndexState } from "../core/state.ts";
import { asEagerLineIndex } from "../core/state.ts";
import {
  pieceTableInsert as ptInsert,
  pieceTableDelete as ptDelete,
  getText,
} from "../core/piece-table.ts";
import {
  lineIndexInsert as liInsert,
  lineIndexDelete as liDelete,
  lineIndexInsertLazy as liInsertLazy,
  lineIndexDeleteLazy as liDeleteLazy,
  reconcileFull,
  reconcileRange,
  findLineAtPosition,
  rebuildLineIndex,
} from "../core/line-index.ts";
import { textEncoder } from "../core/encoding.ts";

// =============================================================================
// Position Validation
// =============================================================================

/**
 * Validate and clamp position to valid document range.
 * Returns clamped position within [0, totalLength].
 */
export function validatePosition(position: number, totalLength: number): ByteOffset {
  if (!Number.isFinite(position)) {
    console.warn(`Invalid position: ${position}, defaulting to 0`);
    return byteOffset(0);
  }
  return byteOffset(Math.max(0, Math.min(position, totalLength)));
}

/**
 * Validate and clamp a range to valid document bounds.
 * Returns { start, end, valid } with both within [0, totalLength].
 * If start > end, marks as invalid (caller should treat as no-op).
 */
export function validateRange(
  start: number,
  end: number,
  totalLength: number,
): { start: ByteOffset; end: ByteOffset; valid: boolean } {
  // Inverted range is invalid (should be no-op). Clamp anyway so callers that
  // accidentally use start/end without checking valid still get in-bounds values.
  if (start > end) {
    return {
      start: validatePosition(start, totalLength),
      end: validatePosition(end, totalLength),
      valid: false,
    };
  }

  const validStart = validatePosition(start, totalLength);
  const validEnd = validatePosition(end, totalLength);

  return { start: validStart, end: validEnd, valid: true };
}

// =============================================================================
// Piece Table Operations
// =============================================================================

/**
 * Insert text into piece table at position.
 * Returns new document state with updated piece table and inserted byte length.
 */
export function pieceTableInsert(
  state: DocumentState,
  position: ByteOffset,
  text: string,
): { state: DocumentState; insertedByteLength: number } {
  const result = ptInsert(state.pieceTable, position, text);
  return {
    state: withState(state, { pieceTable: result.state }),
    insertedByteLength: result.insertedByteLength,
  };
}

/**
 * Delete text from piece table in range [start, end).
 * Returns new document state with updated piece table.
 */
export function pieceTableDelete(
  state: DocumentState,
  start: ByteOffset,
  end: ByteOffset,
): DocumentState {
  const newPieceTable = ptDelete(state.pieceTable, start, end);
  return withState(state, {
    pieceTable: newPieceTable,
  });
}

/**
 * Get text in a range from the piece table.
 * Used for capturing deleted text for undo.
 */
export function getTextRange(state: DocumentState, start: ByteOffset, end: ByteOffset): string {
  return getText(state.pieceTable, start, end);
}

// =============================================================================
// Line Index Strategies (Formalized Eager/Lazy Duality)
// =============================================================================

/**
 * Normalizes eager and lazy line-index update functions behind a common interface.
 * Callers (applyEdit, applyChange) select the appropriate strategy at their boundary
 * rather than scattering ad-hoc `if (eager) liInsert(...) else liInsertLazy(...)` branches.
 *
 * The rebuild path (CRLF edge cases → rebuildLineIndexFromPieceTableState) is outside
 * the strategy — it applies regardless of evaluation mode.
 */
interface LineIndexStrategy {
  insert(
    lineIndex: LineIndexState,
    position: ByteOffset,
    text: string,
    readText?: ReadTextFn,
  ): LineIndexState;
  delete(
    lineIndex: LineIndexState,
    position: ByteOffset,
    end: ByteOffset,
    text: string,
    context?: DeleteBoundaryContext,
  ): LineIndexState;
}

/** Eager strategy: updates byte offsets immediately (used by undo/redo after reconcile). */
export const eagerStrategy: LineIndexStrategy = {
  insert: (li, pos, text, readText) => liInsert(li, pos, text, readText),
  delete: (li, pos, end, text, ctx) => liDelete(li, pos, end, text, ctx),
};

/** Lazy strategy: records dirty ranges for background reconciliation (used by normal edits). */
export function lazyStrategy(version: number): LineIndexStrategy {
  return {
    insert: (li, pos, text, readText) => liInsertLazy(li, pos, text, version, readText),
    delete: (li, pos, end, text, ctx) => liDeleteLazy(li, pos, end, text, version, ctx),
  };
}

export function getDeleteBoundaryContext(
  state: DocumentState,
  start: ByteOffset,
  end: ByteOffset,
): DeleteBoundaryContext {
  const startN = start;
  const endN = end;
  const totalLength = state.pieceTable.totalLength;

  const prevChar = startN > 0 ? getText(state.pieceTable, byteOffset(startN - 1), start) : "";
  const nextChar = endN < totalLength ? getText(state.pieceTable, end, byteOffset(endN + 1)) : "";

  return {
    prevChar: prevChar.length > 0 ? prevChar : undefined,
    nextChar: nextChar.length > 0 ? nextChar : undefined,
  };
}

export function shouldRebuildLineIndexForDelete(
  deletedText: string,
  deleteContext?: DeleteBoundaryContext,
): boolean {
  if (deletedText.includes("\r")) return true;
  // Deleting LF immediately after a CR can rewrite CRLF boundaries across
  // line edges while keeping logical line-break count unchanged.
  if (deletedText.includes("\n") && deleteContext?.prevChar === "\r") return true;
  // Deleting any content between '\r' and '\n' can collapse two logical
  // breaks into one CRLF break without deleting newline bytes directly.
  if (deleteContext?.prevChar === "\r" && deleteContext?.nextChar === "\n") return true;
  return false;
}

export function rebuildLineIndexFromPieceTableState(state: DocumentState): DocumentState {
  const content = getText(
    state.pieceTable,
    byteOffset(0),
    byteOffset(state.pieceTable.totalLength),
  );
  const rebuilt = rebuildLineIndex(content);
  // Preserve user-configured maxDirtyRanges — rebuildLineIndex resets it to the default 32.
  const rebuiltWithConfig = withLineIndexState(rebuilt, {
    maxDirtyRanges: state.lineIndex.maxDirtyRanges,
  });
  return withState(state, { lineIndex: rebuiltWithConfig });
}

// =============================================================================
// History Operations
// =============================================================================

/**
 * Compute the expected cursor position after a change.
 * This is used to properly restore selection on redo.
 */
function computeSelectionAfterChange(state: DocumentState, change: HistoryChange): SelectionState {
  let newPosition: number;

  switch (change.type) {
    case "insert":
      // After insert, cursor should be at end of inserted text
      newPosition = change.position + change.byteLength;
      break;
    case "delete":
      // After delete, cursor should be at the deletion point
      newPosition = change.position;
      break;
    case "replace":
      // After replace, cursor should be at end of inserted text
      newPosition = change.position + change.byteLength;
      break;
    default:
      return state.selection;
  }

  return Object.freeze({
    ranges: Object.freeze([
      Object.freeze({ anchor: byteOffset(newPosition), head: byteOffset(newPosition) }),
    ] as const),
    primaryIndex: 0,
  });
}

/**
 * Check if a new change can be coalesced with the last history entry.
 * Coalescing merges consecutive same-type changes within a timeout window
 * into a single undo entry (e.g., typing a word becomes one undo step).
 */
function canCoalesce(
  lastEntry: HistoryEntry,
  newChange: HistoryChange,
  timeout: number,
  now: number,
): boolean {
  if (timeout <= 0) return false;
  if (now - lastEntry.timestamp > timeout) return false;
  if (lastEntry.changes.length !== 1) return false;

  const last = lastEntry.changes[0];
  if (last.type !== newChange.type) return false;

  switch (newChange.type) {
    case "insert":
      // Contiguous typing: new insert starts where last insert ended
      return newChange.position === last.position + last.byteLength;
    case "delete": {
      // Backspace: new delete ends where last delete starts
      if (newChange.position + newChange.byteLength === last.position) return true;
      // Forward delete: same position as last delete
      if (newChange.position === last.position) return true;
      return false;
    }
    default:
      return false;
  }
}

/**
 * Merge two changes into a single coalesced change.
 * Assumes canCoalesce() returned true for these changes.
 */
function coalesceChanges(existing: HistoryChange, incoming: HistoryChange): HistoryChange {
  switch (incoming.type) {
    case "insert":
      // Append: concatenate text, keep earlier position
      return makeInsertChange(existing.position, existing.text + incoming.text);
    case "delete": {
      if (incoming.position + incoming.byteLength === existing.position) {
        // Backspace: prepend text, use earlier position
        return makeDeleteChange(incoming.position, incoming.text + existing.text);
      }
      // Forward delete: append text, keep position
      return makeDeleteChange(existing.position, existing.text + incoming.text);
    }
    default:
      // canCoalesce() only returns true for 'insert' and 'delete' changes, so
      // 'replace' (the only remaining variant) should never reach here.
      throw new Error(
        `coalesceChanges called with uncoalesceable change type: ${(incoming as HistoryChange).type}`,
      );
  }
}

// =============================================================================
// HistoryChange Factories
// =============================================================================
// Using factories rather than inline object literals enforces the invariant:
//   byteLength === textEncoder.encode(text).byteLength
// At every construction site the byte length is derived from the text rather
// than passed as a separate parameter, making silent divergence impossible.

export function makeInsertChange(position: ByteOffset, text: string): HistoryInsertChange {
  return Object.freeze({
    type: "insert" as const,
    position,
    text,
    byteLength: byteLength(textEncoder.encode(text).byteLength),
  });
}

export function makeDeleteChange(position: ByteOffset, text: string): HistoryDeleteChange {
  return Object.freeze({
    type: "delete" as const,
    position,
    text,
    byteLength: byteLength(textEncoder.encode(text).byteLength),
  });
}

export function makeReplaceChange(
  position: ByteOffset,
  text: string,
  oldText: string,
): HistoryReplaceChange {
  return Object.freeze({
    type: "replace" as const,
    position,
    text,
    byteLength: byteLength(textEncoder.encode(text).byteLength),
    oldText,
    oldByteLength: byteLength(textEncoder.encode(oldText).byteLength),
  });
}

/**
 * Push a change to the history stack.
 * May coalesce with the previous entry if within the coalesce timeout.
 */
export function historyPush(
  state: DocumentState,
  change: HistoryChange,
  now: number,
): DocumentState {
  const history = state.history;

  // Compute expected selection after the change for proper redo
  const selectionAfter = computeSelectionAfterChange(state, change);

  // Try to coalesce with the last entry
  const lastEntry = pstackPeek(history.undoStack);
  if (lastEntry && canCoalesce(lastEntry, change, history.coalesceTimeout, now)) {
    const merged = coalesceChanges(lastEntry.changes[0], change);
    const mergedEntry: HistoryEntry = Object.freeze({
      changes: Object.freeze([merged]),
      selectionBefore: lastEntry.selectionBefore,
      selectionAfter,
      timestamp: now,
    });
    const [, restUndo] = pstackPop(history.undoStack!);
    return withState(state, {
      history: Object.freeze({
        ...history,
        undoStack: pstackPush(restUndo, mergedEntry),
        redoStack: null,
      }),
    });
  }

  const entry: HistoryEntry = Object.freeze({
    changes: Object.freeze([change]),
    selectionBefore: state.selection,
    selectionAfter,
    timestamp: now,
  });

  // Trim undo stack if it exceeds limit.
  // pstackTrimToSize is O(limit) — visits only the top `limit` nodes rather than
  // the full O(H) array round-trip that pstackToArray+slice+pstackFromArray would require.
  const undoStack = pstackTrimToSize(pstackPush(history.undoStack, entry), history.limit);

  return withState(state, {
    history: Object.freeze({
      ...history,
      undoStack,
      redoStack: null, // Clear redo stack on new change
    }),
  });
}

// =============================================================================
// Reconciliation Helper
// =============================================================================

/**
 * Reconcile only the line range touched by a set of history changes.
 *
 * This replaces the previous O(n) `reconcileFull` call that ran before every
 * undo/redo. For each change we find the starting line via `findLineAtPosition`
 * (O(log n), works in lazy mode since subtreeByteLength is always accurate).
 * We then call `reconcileRange` covering the union of those lines.
 *
 * Falls back to `reconcileFull` when the line index has a sentinel dirty range
 * (which signals that the entire tree needs rebuilding).
 */
export function reconcileRangeForChanges(
  lineIndex: LineIndexState,
  changes: readonly HistoryChange[],
  version: number,
): LineIndexState {
  if (!lineIndex.rebuildPending) return lineIndex;

  // If the sentinel is set, we cannot do a targeted reconcile — fall back.
  if (lineIndex.dirtyRanges.some((r) => r.kind === "sentinel")) {
    return reconcileFull(lineIndex, version);
  }

  let minLine = Infinity;
  let maxLine = -Infinity;

  for (const change of changes) {
    const startLoc = findLineAtPosition(lineIndex.root, change.position);
    if (startLoc !== null) {
      minLine = Math.min(minLine, startLoc.lineNumber);
      maxLine = Math.max(maxLine, startLoc.lineNumber);
    }
    // Extend to cover the end of the change range
    const endPos = byteOffset(change.position + change.byteLength);
    const endLoc = findLineAtPosition(lineIndex.root, endPos);
    if (endLoc !== null) {
      maxLine = Math.max(maxLine, endLoc.lineNumber);
    }
  }

  if (minLine === Infinity) {
    // Could not determine line range (empty history?) — fall back
    return reconcileFull(lineIndex, version);
  }

  return reconcileRange(lineIndex, minLine, maxLine, version);
}

// =============================================================================
// Change Application (used by historyUndo / historyRedo in history.ts)
// =============================================================================

/**
 * Invert a history change.
 * insert ↔ delete, replace swaps text/oldText.
 * This formalizes the duality between applyChange and applyInverseChange.
 */
export function invertChange(change: HistoryChange): HistoryChange {
  switch (change.type) {
    case "insert":
      return Object.freeze({
        type: "delete" as const,
        position: change.position,
        text: change.text,
        byteLength: change.byteLength,
      });
    case "delete":
      return Object.freeze({
        type: "insert" as const,
        position: change.position,
        text: change.text,
        byteLength: change.byteLength,
      });
    case "replace":
      return Object.freeze({
        type: "replace" as const,
        position: change.position,
        text: change.oldText,
        byteLength: change.oldByteLength,
        oldText: change.text,
        oldByteLength: change.byteLength,
      });
  }
}

/**
 * Apply a single change (for redo).
 * Precondition: state.lineIndex is already eager (reconciled by the caller).
 * Uses eager line index strategy for immediate offset accuracy.
 */
export function applyChange(state: DocumentState, change: HistoryChange): DocumentState {
  // O(1) assertion that the precondition holds — callers must reconcile before the loop.
  const li = asEagerLineIndex(state.lineIndex);

  switch (change.type) {
    case "insert": {
      const { state: s } = pieceTableInsert(state, change.position, change.text);
      const readText = (start: ByteOffset, end: ByteOffset) => getText(s.pieceTable, start, end);
      const newLineIndex = eagerStrategy.insert(li, change.position, change.text, readText);
      return withState(s, { lineIndex: newLineIndex });
    }
    case "delete": {
      const end = byteOffset(change.position + change.byteLength);
      const deleteContext = getDeleteBoundaryContext(state, change.position, end);
      const s = pieceTableDelete(state, change.position, end);
      if (shouldRebuildLineIndexForDelete(change.text, deleteContext)) {
        return rebuildLineIndexFromPieceTableState(s);
      }
      const newLineIndex = eagerStrategy.delete(
        li,
        change.position,
        end,
        change.text,
        deleteContext,
      );
      return withState(s, { lineIndex: newLineIndex });
    }
    case "replace": {
      const deleteEnd = byteOffset(change.position + change.oldByteLength);
      const deleteContext = getDeleteBoundaryContext(state, change.position, deleteEnd);
      const s = pieceTableDelete(state, change.position, deleteEnd);
      const { state: s2 } = pieceTableInsert(s, change.position, change.text);
      if (shouldRebuildLineIndexForDelete(change.oldText, deleteContext)) {
        return rebuildLineIndexFromPieceTableState(s2);
      }
      const li1 = eagerStrategy.delete(
        li,
        change.position,
        deleteEnd,
        change.oldText,
        deleteContext,
      );
      const readText = (start: ByteOffset, end: ByteOffset) => getText(s2.pieceTable, start, end);
      const li2 = eagerStrategy.insert(li1, change.position, change.text, readText);
      return withState(s2, { lineIndex: li2 });
    }
    default:
      return state;
  }
}

/**
 * Apply inverse of a change (for undo).
 * Delegates to applyChange(invertChange(change)) — the structural dual.
 */
export function applyInverseChange(state: DocumentState, change: HistoryChange): DocumentState {
  return applyChange(state, invertChange(change));
}

// =============================================================================
// Unified Edit Pipeline
// =============================================================================

/**
 * Describes an edit operation as a proper discriminated union.
 * The `kind` field makes the variant unambiguous and eliminates all
 * `op.deleteEnd !== undefined` guards that previously coupled delete-phase
 * decisions to insert-phase behavior.
 */
export type EditOperation =
  | {
      readonly kind: "insert";
      readonly position: ByteOffset;
      readonly insertText: string;
      readonly timestamp?: number;
      readonly selection?: readonly SelectionRange[];
    }
  | {
      readonly kind: "delete";
      readonly position: ByteOffset;
      readonly deleteEnd: ByteOffset;
      readonly deletedText: string;
      readonly timestamp?: number;
      readonly selection?: readonly SelectionRange[];
    }
  | {
      readonly kind: "replace";
      readonly position: ByteOffset;
      readonly deleteEnd: ByteOffset;
      readonly deletedText: string;
      readonly insertText: string;
      readonly timestamp?: number;
      readonly selection?: readonly SelectionRange[];
    };

/**
 * Apply a text edit through the unified pipeline:
 * 1. Delete phase (if deleteEnd specified)
 * 2. Insert phase (if insertText non-empty)
 * 3. Build history change
 * 4. Push to history
 * 5. Mark dirty + increment version
 */
export function applyEdit(state: DocumentState, op: EditOperation): DocumentState {
  const nextVersion = state.version + 1;
  const strategy = lazyStrategy(nextVersion);
  let newState: DocumentState = state;

  // Determine upfront whether CRLF semantics require a full line-index rebuild.
  // Using op.kind narrowing rather than op.deleteEnd !== undefined guards means
  // the delete-phase decision is structurally visible rather than inferred from
  // an optional field, and TypeScript enforces which fields are present in each branch.
  const deleteContext =
    op.kind !== "insert"
      ? getDeleteBoundaryContext(newState, op.position, op.deleteEnd)
      : undefined;
  const needsRebuild =
    op.kind !== "insert" && shouldRebuildLineIndexForDelete(op.deletedText, deleteContext);

  // Delete phase
  if (op.kind !== "insert") {
    if (needsRebuild) {
      // Skip lazy line-index update — a full rebuild will follow after the insert phase.
      newState = pieceTableDelete(newState, op.position, op.deleteEnd);
    } else {
      // Lazy line-index update is computed from the current (pre-delete) state because
      // dirty-range tracking only needs the deleted text's line-break structure, not the
      // post-delete byte layout. The resulting dirty range is reconciled later against
      // the updated piece table.
      const delLineIndex = strategy.delete(
        newState.lineIndex,
        op.position,
        op.deleteEnd,
        op.deletedText,
        deleteContext,
      );
      newState = pieceTableDelete(newState, op.position, op.deleteEnd);
      newState = withState(newState, { lineIndex: delLineIndex });
    }
  }

  // Insert phase
  if (op.kind !== "delete") {
    if (op.insertText.length > 0) {
      const result = pieceTableInsert(newState, op.position, op.insertText);
      newState = result.state;
      if (!needsRebuild) {
        const readText = (start: ByteOffset, end: ByteOffset) =>
          getText(newState.pieceTable, start, end);
        const insLineIndex = strategy.insert(
          newState.lineIndex,
          op.position,
          op.insertText,
          readText,
        );
        newState = withState(newState, { lineIndex: insLineIndex });
      }
    }
  }

  // Rebuild phase: single consolidated decision point, chosen before any mutation above.
  if (needsRebuild) {
    newState = rebuildLineIndexFromPieceTableState(newState);
  }

  // Apply inline selection so historyPush records the correct selectionBefore
  if (op.selection) {
    newState = withState(newState, {
      selection: Object.freeze({
        ranges: Object.freeze(
          op.selection.map((r) => Object.freeze({ ...r })),
        ) as NonEmptyReadonlyArray<SelectionRange>,
        primaryIndex: 0,
      }),
    });
  }

  // Build and push history change — switch on kind for exhaustive narrowing.
  // Factory functions enforce byteLength === utf8ByteLength(text) at construction.
  let historyChange: HistoryChange;
  switch (op.kind) {
    case "replace":
      historyChange = makeReplaceChange(op.position, op.insertText, op.deletedText);
      break;
    case "delete":
      historyChange = makeDeleteChange(op.position, op.deletedText);
      break;
    case "insert":
      historyChange = makeInsertChange(op.position, op.insertText);
      break;
  }
  newState = historyPush(newState, historyChange, op.timestamp ?? Date.now());

  // Mark as dirty and increment version
  return withState(newState, {
    version: nextVersion,
    metadata: Object.freeze({
      ...state.metadata,
      isDirty: true,
    }),
  });
}
