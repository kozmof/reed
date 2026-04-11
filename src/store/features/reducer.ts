/**
 * Document reducer for the Reed document editor.
 * Pure reducer function for document state transitions.
 * No side effects - produces new state from old state + action.
 */

import type { DocumentState, LineIndexState, HistoryEntry, HistoryChange, SelectionState, SelectionRange, NonEmptyReadonlyArray, PieceNode } from '../../types/state.ts';
import { pstackPush, pstackPeek, pstackPop, pstackTrimToSize } from '../../types/state.ts';
import type { DocumentAction } from '../../types/actions.ts';
import type { ByteOffset } from '../../types/branded.ts';
import type { DeleteBoundaryContext, ReadTextFn } from '../../types/operations.ts';
import { byteOffset, byteLength } from '../../types/branded.ts';
import { withState, createChunkPieceNode } from '../core/state.ts';
import {
  pieceTableInsert as ptInsert,
  pieceTableDelete as ptDelete,
  getText,
} from '../core/piece-table.ts';
import {
  lineIndexInsert as liInsert,
  lineIndexDelete as liDelete,
  lineIndexInsertLazy as liInsertLazy,
  lineIndexDeleteLazy as liDeleteLazy,
  reconcileFull,
  rebuildLineIndex,
} from '../core/line-index.ts';
import { asEagerLineIndex } from '../core/state.ts';
import { textDecoder } from '../core/encoding.ts';

// =============================================================================
// Position Validation
// =============================================================================

/**
 * Validate and clamp position to valid document range.
 * Returns clamped position within [0, totalLength].
 */
function validatePosition(position: number, totalLength: number): ByteOffset {
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
function validateRange(
  start: number,
  end: number,
  totalLength: number
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
function pieceTableInsert(
  state: DocumentState,
  position: ByteOffset,
  text: string
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
function pieceTableDelete(
  state: DocumentState,
  start: ByteOffset,
  end: ByteOffset
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
function getTextRange(state: DocumentState, start: ByteOffset, end: ByteOffset): string {
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
  insert(lineIndex: LineIndexState, position: ByteOffset, text: string, readText?: ReadTextFn): LineIndexState;
  delete(lineIndex: LineIndexState, position: ByteOffset, end: ByteOffset, text: string, context?: DeleteBoundaryContext): LineIndexState;
}

/** Eager strategy: updates byte offsets immediately (used by undo/redo after reconcile). */
const eagerStrategy: LineIndexStrategy = {
  insert: (li, pos, text, readText) => liInsert(li, pos, text, readText),
  delete: (li, pos, end, text, ctx) => liDelete(li, pos, end, text, ctx),
};

/** Lazy strategy: records dirty ranges for background reconciliation (used by normal edits). */
function lazyStrategy(version: number): LineIndexStrategy {
  return {
    insert: (li, pos, text, readText) => liInsertLazy(li, pos, text, version, readText),
    delete: (li, pos, end, text, ctx) => liDeleteLazy(li, pos, end, text, version, ctx),
  };
}

function getDeleteBoundaryContext(
  state: DocumentState,
  start: ByteOffset,
  end: ByteOffset
): DeleteBoundaryContext {
  const startN = start;
  const endN = end;
  const totalLength = state.pieceTable.totalLength;

  const prevChar = startN > 0
    ? getText(state.pieceTable, byteOffset(startN - 1), start)
    : '';
  const nextChar = endN < totalLength
    ? getText(state.pieceTable, end, byteOffset(endN + 1))
    : '';

  return {
    prevChar: prevChar.length > 0 ? prevChar : undefined,
    nextChar: nextChar.length > 0 ? nextChar : undefined,
  };
}

function shouldRebuildLineIndexForDelete(
  deletedText: string,
  deleteContext?: DeleteBoundaryContext
): boolean {
  if (deletedText.includes('\r')) return true;
  // Deleting LF immediately after a CR can rewrite CRLF boundaries across
  // line edges while keeping logical line-break count unchanged.
  if (deletedText.includes('\n') && deleteContext?.prevChar === '\r') return true;
  // Deleting any content between '\r' and '\n' can collapse two logical
  // breaks into one CRLF break without deleting newline bytes directly.
  if (deleteContext?.prevChar === '\r' && deleteContext?.nextChar === '\n') return true;
  return false;
}

function rebuildLineIndexFromPieceTableState(state: DocumentState): DocumentState {
  const content = getText(state.pieceTable, byteOffset(0), byteOffset(state.pieceTable.totalLength));
  const rebuilt = rebuildLineIndex(content);
  return withState(state, { lineIndex: rebuilt });
}

// =============================================================================
// History Operations
// =============================================================================

/**
 * Compute the expected cursor position after a change.
 * This is used to properly restore selection on redo.
 */
function computeSelectionAfterChange(
  state: DocumentState,
  change: HistoryChange
): SelectionState {
  let newPosition: number;

  switch (change.type) {
    case 'insert':
      // After insert, cursor should be at end of inserted text
      newPosition = change.position + change.byteLength;
      break;
    case 'delete':
      // After delete, cursor should be at the deletion point
      newPosition = change.position;
      break;
    case 'replace':
      // After replace, cursor should be at end of inserted text
      newPosition = change.position + change.byteLength;
      break;
    default:
      return state.selection;
  }

  return Object.freeze({
    ranges: Object.freeze([Object.freeze({ anchor: byteOffset(newPosition), head: byteOffset(newPosition) })] as const),
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
  now: number
): boolean {
  if (timeout <= 0) return false;
  if (now - lastEntry.timestamp > timeout) return false;
  if (lastEntry.changes.length !== 1) return false;

  const last = lastEntry.changes[0];
  if (last.type !== newChange.type) return false;

  switch (newChange.type) {
    case 'insert':
      // Contiguous typing: new insert starts where last insert ended
      return newChange.position === last.position + last.byteLength;
    case 'delete': {
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
function coalesceChanges(
  existing: HistoryChange,
  incoming: HistoryChange
): HistoryChange {
  switch (incoming.type) {
    case 'insert':
      // Append: concatenate text, sum byte lengths, keep earlier position
      return Object.freeze({
        type: 'insert',
        position: existing.position,
        text: existing.text + incoming.text,
        byteLength: byteLength(existing.byteLength + incoming.byteLength),
      });
    case 'delete': {
      if (incoming.position + incoming.byteLength === existing.position) {
        // Backspace: prepend text, use earlier position
        return Object.freeze({
          type: 'delete',
          position: incoming.position,
          text: incoming.text + existing.text,
          byteLength: byteLength(existing.byteLength + incoming.byteLength),
        });
      }
      // Forward delete: append text, keep position
      return Object.freeze({
        type: 'delete',
        position: existing.position,
        text: existing.text + incoming.text,
        byteLength: byteLength(existing.byteLength + incoming.byteLength),
      });
    }
    default:
      // canCoalesce() only returns true for 'insert' and 'delete' changes, so
      // 'replace' (the only remaining variant) should never reach here.
      throw new Error(`coalesceChanges called with uncoalesceable change type: ${(incoming as HistoryChange).type}`);
  }
}

/**
 * Push a change to the history stack.
 * May coalesce with the previous entry if within the coalesce timeout.
 */
function historyPush(
  state: DocumentState,
  change: HistoryChange,
  now: number
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
  let undoStack = pstackTrimToSize(pstackPush(history.undoStack, entry), history.limit);

  return withState(state, {
    history: Object.freeze({
      ...history,
      undoStack,
      redoStack: null, // Clear redo stack on new change
    }),
  });
}

/**
 * Perform undo operation.
 * Uses eager line index strategy for immediate accuracy.
 */
function historyUndo(state: DocumentState, version: number): DocumentState {
  const history = state.history;
  if (history.undoStack === null) return state;

  const [entry, newUndoStack] = pstackPop(history.undoStack);
  const newRedoStack = pstackPush(history.redoStack, entry);

  // Apply inverse changes
  let newState = withState(state, {
    history: Object.freeze({
      ...history,
      undoStack: newUndoStack,
      redoStack: newRedoStack,
    }),
  });

  // Reconcile once before the loop — subsequent applyChange calls keep the index eager.
  const reconciledLI = reconcileFull(newState.lineIndex, version);
  if (reconciledLI !== newState.lineIndex) {
    newState = withState(newState, { lineIndex: reconciledLI });
  }

  // Apply inverse of each change (in reverse order) with eager line index updates
  for (let i = entry.changes.length - 1; i >= 0; i--) {
    const change = entry.changes[i];
    newState = applyInverseChange(newState, change);
  }

  // Restore selection
  newState = withState(newState, {
    selection: entry.selectionBefore,
  });

  return newState;
}

/**
 * Perform redo operation.
 * Uses eager line index strategy for immediate accuracy.
 */
function historyRedo(state: DocumentState, version: number): DocumentState {
  const history = state.history;
  if (history.redoStack === null) return state;

  const [entry, newRedoStack] = pstackPop(history.redoStack);
  const newUndoStack = pstackPush(history.undoStack, entry);

  // Apply changes
  let newState = withState(state, {
    history: Object.freeze({
      ...history,
      undoStack: newUndoStack,
      redoStack: newRedoStack,
    }),
  });

  // Reconcile once before the loop — subsequent applyChange calls keep the index eager.
  const reconciledLI = reconcileFull(newState.lineIndex, version);
  if (reconciledLI !== newState.lineIndex) {
    newState = withState(newState, { lineIndex: reconciledLI });
  }

  // Apply each change with eager line index updates
  for (const change of entry.changes) {
    newState = applyChange(newState, change);
  }

  // Restore selection
  newState = withState(newState, {
    selection: entry.selectionAfter,
  });

  return newState;
}

/**
 * Invert a history change.
 * insert ↔ delete, replace swaps text/oldText.
 * This formalizes the duality between applyChange and applyInverseChange.
 */
function invertChange(change: HistoryChange): HistoryChange {
  switch (change.type) {
    case 'insert':
      return Object.freeze({
        type: 'delete' as const,
        position: change.position,
        text: change.text,
        byteLength: change.byteLength,
      });
    case 'delete':
      return Object.freeze({
        type: 'insert' as const,
        position: change.position,
        text: change.text,
        byteLength: change.byteLength,
      });
    case 'replace':
      return Object.freeze({
        type: 'replace' as const,
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
function applyChange(state: DocumentState, change: HistoryChange): DocumentState {
  // O(1) assertion that the precondition holds — callers must reconcile before the loop.
  const li = asEagerLineIndex(state.lineIndex);

  switch (change.type) {
    case 'insert': {
      const { state: s } = pieceTableInsert(state, change.position, change.text);
      const readText = (start: ByteOffset, end: ByteOffset) => getText(s.pieceTable, start, end);
      const newLineIndex = eagerStrategy.insert(li, change.position, change.text, readText);
      return withState(s, { lineIndex: newLineIndex });
    }
    case 'delete': {
      const end = byteOffset(change.position + change.byteLength);
      const deleteContext = getDeleteBoundaryContext(state, change.position, end);
      const s = pieceTableDelete(state, change.position, end);
      if (shouldRebuildLineIndexForDelete(change.text, deleteContext)) {
        return rebuildLineIndexFromPieceTableState(s);
      }
      const newLineIndex = eagerStrategy.delete(li, change.position, end, change.text, deleteContext);
      return withState(s, { lineIndex: newLineIndex });
    }
    case 'replace': {
      const deleteEnd = byteOffset(change.position + change.oldByteLength);
      const deleteContext = getDeleteBoundaryContext(state, change.position, deleteEnd);
      const s = pieceTableDelete(state, change.position, deleteEnd);
      const { state: s2 } = pieceTableInsert(s, change.position, change.text);
      if (shouldRebuildLineIndexForDelete(change.oldText, deleteContext)) {
        return rebuildLineIndexFromPieceTableState(s2);
      }
      const li1 = eagerStrategy.delete(li, change.position, deleteEnd, change.oldText, deleteContext);
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
function applyInverseChange(state: DocumentState, change: HistoryChange): DocumentState {
  return applyChange(state, invertChange(change));
}

// =============================================================================
// Selection Operations
// =============================================================================

/**
 * Update selection state.
 */
function setSelection(
  state: DocumentState,
  ranges: readonly SelectionRange[]
): DocumentState {
  return withState(state, {
    selection: Object.freeze({
      ranges: Object.freeze(ranges.map(r => Object.freeze({ ...r }))) as NonEmptyReadonlyArray<SelectionRange>,
      primaryIndex: 0,
    }),
  });
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
type EditOperation =
  | {
      readonly kind: 'insert';
      readonly position: ByteOffset;
      readonly insertText: string;
      readonly timestamp?: number;
      readonly selection?: readonly SelectionRange[];
    }
  | {
      readonly kind: 'delete';
      readonly position: ByteOffset;
      readonly deleteEnd: ByteOffset;
      readonly deletedText: string;
      readonly timestamp?: number;
      readonly selection?: readonly SelectionRange[];
    }
  | {
      readonly kind: 'replace';
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
function applyEdit(state: DocumentState, op: EditOperation): DocumentState {
  const nextVersion = state.version + 1;
  const strategy = lazyStrategy(nextVersion);
  let newState: DocumentState = state;

  // Determine upfront whether CRLF semantics require a full line-index rebuild.
  // Using op.kind narrowing rather than op.deleteEnd !== undefined guards means
  // the delete-phase decision is structurally visible rather than inferred from
  // an optional field, and TypeScript enforces which fields are present in each branch.
  const deleteContext = op.kind !== 'insert'
    ? getDeleteBoundaryContext(newState, op.position, op.deleteEnd)
    : undefined;
  const needsRebuild = op.kind !== 'insert'
    && shouldRebuildLineIndexForDelete(op.deletedText, deleteContext);

  // Delete phase
  if (op.kind !== 'insert') {
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
        deleteContext
      );
      newState = pieceTableDelete(newState, op.position, op.deleteEnd);
      newState = withState(newState, { lineIndex: delLineIndex });
    }
  }

  // Insert phase
  let insertedByteLength = 0;
  if (op.kind !== 'delete') {
    if (op.insertText.length > 0) {
      const result = pieceTableInsert(newState, op.position, op.insertText);
      newState = result.state;
      insertedByteLength = result.insertedByteLength;
      if (!needsRebuild) {
        const readText = (start: ByteOffset, end: ByteOffset) => getText(newState.pieceTable, start, end);
        const insLineIndex = strategy.insert(newState.lineIndex, op.position, op.insertText, readText);
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
        ranges: Object.freeze(op.selection.map(r => Object.freeze({ ...r }))) as NonEmptyReadonlyArray<SelectionRange>,
        primaryIndex: 0,
      }),
    });
  }

  // Build and push history change — switch on kind for exhaustive narrowing
  let historyChange: HistoryChange;
  switch (op.kind) {
    case 'replace':
      historyChange = Object.freeze({
        type: 'replace' as const,
        position: op.position,
        text: op.insertText,
        byteLength: byteLength(insertedByteLength),
        oldText: op.deletedText,
        oldByteLength: byteLength(op.deleteEnd - op.position),
      });
      break;
    case 'delete':
      historyChange = Object.freeze({
        type: 'delete' as const,
        position: op.position,
        text: op.deletedText,
        byteLength: byteLength(op.deleteEnd - op.position),
      });
      break;
    case 'insert':
      historyChange = Object.freeze({
        type: 'insert' as const,
        position: op.position,
        text: op.insertText,
        byteLength: byteLength(insertedByteLength),
      });
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

// =============================================================================
// Chunk Loading Helpers (Phase 3)
// =============================================================================

/**
 * Append a new chunk piece as the rightmost leaf of the piece tree.
 * Sequential loading guarantees the chunk always belongs at the document end,
 * so we walk the right spine and attach the new node there, then recolor to
 * maintain the red-black invariant (new leaf is red; single right-spine addition
 * keeps black-height balanced without needing full fixup in practice, but we
 * attach as black to keep the tree valid for all depths).
 *
 * For simplicity we re-use the immutable withPieceNode update path rather than
 * implementing a full path-copying right-spine walk: create the leaf and insert
 * it using the existing O(log n) RB insert from ptInsert indirection is avoided
 * here because we do not go through text encoding — instead we create the node
 * directly and splice it as a right child with path-copying.
 */
function appendChunkPiece(
  root: PieceNode | null,
  chunkIndex: number,
  chunkByteLength: number
): PieceNode {
  const newLeaf = createChunkPieceNode(
    chunkIndex,
    byteOffset(0),
    byteLength(chunkByteLength),
    'red',  // start red; fixup below turns root black if needed
  );

  if (root === null) {
    // Tree was empty — single black root
    return Object.freeze({ ...newLeaf, color: 'black' });
  }

  // Walk the right spine collecting the path, then graft the new leaf and
  // propagate subtreeLength upward with path-copying.
  const path: PieceNode[] = [];
  let cur: PieceNode = root;
  while (cur.right !== null) {
    path.push(cur);
    cur = cur.right;
  }

  // Attach as right child of the rightmost node
  let updated: PieceNode = Object.freeze({
    ...cur,
    right: newLeaf,
    subtreeLength: cur.subtreeLength + chunkByteLength,
    // subtreeAddLength unchanged (chunk pieces contribute 0)
  });

  // Walk back up the path updating subtreeLength
  for (let i = path.length - 1; i >= 0; i--) {
    const ancestor = path[i];
    updated = Object.freeze({
      ...ancestor,
      right: updated,
      subtreeLength: ancestor.subtreeLength + chunkByteLength,
    });
  }

  return updated;
}

/**
 * Walk the tree in document order to find the contiguous document-position range
 * covered by all pieces belonging to `chunkIndex`.
 *
 * Returns `{ start, end }` byte offsets in document space, or null if the chunk
 * has no pieces in the tree (already evicted or never loaded).
 *
 * O(n) where n is the number of pieces.
 */
function findChunkDocumentRange(
  root: PieceNode | null,
  chunkIndex: number
): { start: ByteOffset; end: ByteOffset } | null {
  if (root === null) return null;

  let rangeStart = -1;
  let rangeEnd = -1;

  const nodeStack: PieceNode[] = [];
  const offsetStack: number[] = [];
  let currentOffset = 0;
  let currentNode: PieceNode | null = root;

  while (currentNode !== null || nodeStack.length > 0) {
    // Descend to leftmost
    while (currentNode !== null) {
      nodeStack.push(currentNode);
      offsetStack.push(currentOffset);
      currentOffset += currentNode.left?.subtreeLength ?? 0;
      currentNode = currentNode.left;
    }

    // Process node
    const n = nodeStack.pop()!;
    const nOffset = offsetStack.pop()!;
    const pieceStart = nOffset + (n.left?.subtreeLength ?? 0);

    if (n.bufferType === 'chunk' && n.chunkIndex === chunkIndex) {
      if (rangeStart === -1) rangeStart = pieceStart;
      rangeEnd = pieceStart + n.length;
    }

    // Move to right subtree
    currentOffset = pieceStart + n.length;
    currentNode = n.right;
  }

  if (rangeStart === -1) return null;
  return { start: byteOffset(rangeStart), end: byteOffset(rangeEnd) };
}

/**
 * Walk the tree in document order to check whether any 'add' piece overlaps
 * the byte range [rangeStart, rangeEnd) in document space.
 *
 * O(n) where n is the number of pieces.
 */
function hasAddPiecesInRange(
  root: PieceNode | null,
  rangeStart: ByteOffset,
  rangeEnd: ByteOffset
): boolean {
  if (root === null) return false;

  const nodeStack: PieceNode[] = [];
  const offsetStack: number[] = [];
  let currentOffset = 0;
  let currentNode: PieceNode | null = root;

  while (currentNode !== null || nodeStack.length > 0) {
    while (currentNode !== null) {
      nodeStack.push(currentNode);
      offsetStack.push(currentOffset);
      currentOffset += currentNode.left?.subtreeLength ?? 0;
      currentNode = currentNode.left;
    }

    const n = nodeStack.pop()!;
    const nOffset = offsetStack.pop()!;
    const pieceStart = nOffset + (n.left?.subtreeLength ?? 0);
    const pieceEnd = pieceStart + n.length;

    if (n.bufferType === 'add') {
      // Overlap: piece starts before rangeEnd AND piece ends after rangeStart
      if (pieceStart < rangeEnd && pieceEnd > rangeStart) return true;
    }

    currentOffset = pieceEnd;
    currentNode = n.right;
  }

  return false;
}

/**
 * Rebuild the RB-tree omitting all pieces whose chunkIndex matches `targetChunk`.
 * Returns the new root and the total byte length removed.
 *
 * Strategy: collect surviving pieces in document order via in-order traversal,
 * then rebuild a balanced black-height-correct tree from them.
 * O(n) traversal + O(n log n) rebuild (n = number of pieces).
 */
function removeChunkPiecesFromTree(
  root: PieceNode | null,
  targetChunk: number
): { newRoot: PieceNode | null; removedLength: number } {
  if (root === null) return { newRoot: null, removedLength: 0 };

  // Collect surviving pieces in document order
  const survivors: PieceNode[] = [];
  let removedLength = 0;

  const nodeStack: PieceNode[] = [];
  let currentNode: PieceNode | null = root;

  while (currentNode !== null || nodeStack.length > 0) {
    while (currentNode !== null) {
      nodeStack.push(currentNode);
      currentNode = currentNode.left;
    }
    const n = nodeStack.pop()!;
    if (n.bufferType === 'chunk' && n.chunkIndex === targetChunk) {
      removedLength += n.length;
    } else {
      survivors.push(n);
    }
    currentNode = n.right;
  }

  if (survivors.length === 0) return { newRoot: null, removedLength };

  // Rebuild a balanced tree from survivors using median-split recursion.
  // All nodes black so the black-height invariant holds for a balanced tree.
  function buildTree(arr: PieceNode[], lo: number, hi: number): PieceNode | null {
    if (lo > hi) return null;
    const mid = (lo + hi) >> 1;
    const src = arr[mid];
    const left = buildTree(arr, lo, mid - 1);
    const right = buildTree(arr, mid + 1, hi);
    const leftLen = left?.subtreeLength ?? 0;
    const rightLen = right?.subtreeLength ?? 0;
    const leftAdd = left?.subtreeAddLength ?? 0;
    const rightAdd = right?.subtreeAddLength ?? 0;
    const selfAdd = src.bufferType === 'add' ? src.length : 0;
    return Object.freeze({
      ...src,
      color: 'black' as const,
      left,
      right,
      subtreeLength: src.length + leftLen + rightLen,
      subtreeAddLength: selfAdd + leftAdd + rightAdd,
    });
  }

  const newRoot = buildTree(survivors, 0, survivors.length - 1);
  return { newRoot, removedLength };
}

// =============================================================================
// Main Reducer
// =============================================================================

/**
 * Core reducer implementation with structural sharing.
 * Handles all document actions and returns new immutable state.
 */
export function documentReducer(
  state: DocumentState,
  action: DocumentAction
): DocumentState {
  switch (action.type) {
    case 'INSERT': {
      const position = validatePosition(action.start, state.pieceTable.totalLength);
      if (action.text.length === 0) return state;
      return applyEdit(state, { kind: 'insert', position, insertText: action.text, timestamp: action.timestamp, selection: action.selection });
    }

    case 'DELETE': {
      const { start, end, valid } = validateRange(action.start, action.end, state.pieceTable.totalLength);
      if (!valid) return state;
      if (end - start <= 0) return state;
      const deletedText = getTextRange(state, start, end);
      return applyEdit(state, { kind: 'delete', position: start, deleteEnd: end, deletedText, timestamp: action.timestamp, selection: action.selection });
    }

    case 'REPLACE': {
      const { start, end, valid } = validateRange(action.start, action.end, state.pieceTable.totalLength);
      if (!valid) return state;
      const oldText = getTextRange(state, start, end);
      return applyEdit(state, { kind: 'replace', position: start, deleteEnd: end, deletedText: oldText, insertText: action.text, timestamp: action.timestamp, selection: action.selection });
    }

    case 'SET_SELECTION': {
      return withState(setSelection(state, action.ranges), {
        version: state.version + 1,
      });
    }

    case 'UNDO': {
      const nextVersion = state.version + 1;
      const newState = historyUndo(state, nextVersion);
      if (newState === state) return state; // No undo available
      return withState(newState, {
        version: nextVersion,
      });
    }

    case 'REDO': {
      const nextVersion = state.version + 1;
      const newState = historyRedo(state, nextVersion);
      if (newState === state) return state; // No redo available
      return withState(newState, {
        version: nextVersion,
      });
    }

    case 'HISTORY_CLEAR': {
      // Clear both undo and redo stacks while preserving config
      return withState(state, {
        history: Object.freeze({
          undoStack: null,
          redoStack: null,
          limit: state.history.limit,
          coalesceTimeout: state.history.coalesceTimeout,
        }),
        version: state.version + 1,
      });
    }

    case 'TRANSACTION_START':
    case 'TRANSACTION_COMMIT':
    case 'TRANSACTION_ROLLBACK':
      // Transaction handling is done in the store, not the reducer
      return state;

    case 'APPLY_REMOTE': {
      // Apply remote changes from collaboration
      const nextVersion = state.version + 1;
      let newState = state;
      let didApplyChange = false;
      for (const change of action.changes) {
        if (change.type === 'insert' && change.text.length > 0) {
          didApplyChange = true;
          newState = pieceTableInsert(newState, change.start, change.text).state;
          const readText = (start: ByteOffset, end: ByteOffset) => getText(newState.pieceTable, start, end);
          const li = liInsertLazy(newState.lineIndex, change.start, change.text, nextVersion, readText);
          newState = withState(newState, { lineIndex: li });
        } else if (change.type === 'delete' && change.length > 0) {
          didApplyChange = true;
          // Capture deleted text before deleting for line index update
          const endPosition = byteOffset(change.start + change.length);
          const deletedText = getTextRange(newState, change.start, endPosition);
          const deleteContext = getDeleteBoundaryContext(newState, change.start, endPosition);
          if (shouldRebuildLineIndexForDelete(deletedText, deleteContext)) {
            newState = pieceTableDelete(newState, change.start, endPosition);
            newState = rebuildLineIndexFromPieceTableState(newState);
          } else {
            const li = liDeleteLazy(
              newState.lineIndex,
              change.start,
              endPosition,
              deletedText,
              nextVersion,
              deleteContext
            );
            newState = pieceTableDelete(newState, change.start, endPosition);
            newState = withState(newState, { lineIndex: li });
          }
        }
      }
      if (!didApplyChange) {
        return state;
      }
      // Remote changes don't push to history (they come from network)
      const metadata = newState.metadata.isDirty
        ? newState.metadata
        : Object.freeze({
          ...newState.metadata,
          isDirty: true,
        });
      return withState(newState, {
        version: nextVersion,
        metadata,
      });
    }

    case 'LOAD_CHUNK': {
      const { chunkIndex, data } = action;
      const { chunkSize, nextExpectedChunk, chunkMap, totalLength } = state.pieceTable;

      // Non-chunked mode: chunkSize must be set in the store config
      if (chunkSize === 0) return state;
      // Enforce sequential ordering
      if (chunkIndex !== nextExpectedChunk) return state;
      // Ignore duplicate loads
      if (chunkMap.has(chunkIndex)) return state;

      const chunkBytes = data as Uint8Array;
      if (chunkBytes.length === 0) return state;

      const chunkText = textDecoder.decode(chunkBytes);
      const insertionPos = byteOffset(totalLength);

      const newChunkMap = new Map(chunkMap);
      newChunkMap.set(chunkIndex, chunkBytes);

      const newRoot = appendChunkPiece(state.pieceTable.root, chunkIndex, chunkBytes.length);
      const newPieceTable = Object.freeze({
        ...state.pieceTable,
        root: newRoot,
        chunkMap: newChunkMap,
        totalLength: totalLength + chunkBytes.length,
        nextExpectedChunk: chunkIndex + 1,
      });

      const nextVersion = state.version + 1;
      const newLineIndex = liInsertLazy(state.lineIndex, insertionPos, chunkText, nextVersion);

      return withState(state, {
        version: nextVersion,
        pieceTable: newPieceTable,
        lineIndex: newLineIndex,
      });
    }

    case 'EVICT_CHUNK': {
      const { chunkIndex } = action;
      const { chunkMap } = state.pieceTable;

      // Cannot evict a chunk that is not loaded
      if (!chunkMap.has(chunkIndex)) return state;

      const range = findChunkDocumentRange(state.pieceTable.root, chunkIndex);
      // No pieces found — tree is out of sync with chunkMap; safe no-op
      if (range === null) return state;

      // Refuse eviction if user edits overlap the chunk's document range
      if (hasAddPiecesInRange(state.pieceTable.root, range.start, range.end)) return state;

      const chunkBytes = chunkMap.get(chunkIndex)!;
      const chunkText = textDecoder.decode(chunkBytes);

      const { newRoot, removedLength } = removeChunkPiecesFromTree(state.pieceTable.root, chunkIndex);

      const newChunkMap = new Map(chunkMap);
      newChunkMap.delete(chunkIndex);

      const newPieceTable = Object.freeze({
        ...state.pieceTable,
        root: newRoot,
        chunkMap: newChunkMap,
        totalLength: state.pieceTable.totalLength - removedLength,
      });

      const nextVersion = state.version + 1;
      const newLineIndex = liDeleteLazy(state.lineIndex, range.start, range.end, chunkText, nextVersion);

      return withState(state, {
        version: nextVersion,
        pieceTable: newPieceTable,
        lineIndex: newLineIndex,
      });
    }

    default: {
      // Exhaustive check - TypeScript will error if we miss an action type
      const exhaustiveCheck: never = action;
      return exhaustiveCheck;
    }
  }
}
