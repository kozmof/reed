import { carryLineOffsetIndexes } from "../core/line-offsets.js";
import { pieceTableReader } from "../core/piece-table-reader.js";
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
  HistorySelectionState,
  PieceTableState,
  SelectionRange,
  NonEmptyReadonlyArray,
} from "../../types/state.js";
import { pstackPush, pstackPeek, pstackPop, pstackTrimToSize } from "../../types/state.js";
import type { ByteOffset } from "../../types/branded.js";
import type { DeleteBoundaryContext, ReadTextFn } from "../../types/operations.js";
import { byteOffset, byteLength } from "../../types/branded.js";
import { withState, withLineIndexState } from "../core/state.js";
import {
  pieceTableInsert as ptInsert,
  pieceTableDelete as ptDelete,
  getText,
  getRawByte,
  isUtf8Boundary,
} from "../core/piece-table.js";
import type { SplitRecord } from "../core/piece-table.js";
import { migrateSplits, migrateDelete } from "../core/attention.js";
import {
  lineIndexInsert as liInsert,
  lineIndexDelete as liDelete,
  lineIndexInsertLazy as liInsertLazy,
  lineIndexDeleteLazy as liDeleteLazy,
  rebuildLineIndex,
  repairLineIndexWindow,
} from "../core/line-index.js";
import { utf8ByteLength } from "../core/encoding.js";
import { NO_CHUNK, gapKey, hasUnloadedChunkBetween, placementRuns } from "../core/chunk-anchor.js";
import { anchorAt, anchorSelection, residentOffset } from "./history-anchor.js";

// =============================================================================
// Position Validation
// =============================================================================

/**
 * Validate and clamp position to valid document range.
 * Returns clamped position within [0, totalLength].
 */
export function validatePosition(position: number, totalLength: number): ByteOffset {
  if (!Number.isFinite(position)) {
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
 * Insert text into piece table at position, migrating the attention layer.
 * Returns new document state, the inserted byte length, and the piece splits.
 *
 * Centralizing attention migration here means every content-edit path that
 * inserts (applyEdit, applyChange/undo-redo, APPLY_REMOTE) re-anchors points
 * automatically via the split records.
 */
export function pieceTableInsert(
  state: DocumentState,
  position: ByteOffset,
  text: string,
  afterChunk?: number,
): { state: DocumentState; insertedByteLength: number; splits: readonly SplitRecord[] } {
  const result = ptInsert(state.pieceTable, position, text, afterChunk);
  const attention = migrateSplits(state.attention, result.splits);
  const nextState = withState(state, { pieceTable: result.state, attention });
  carryLineOffsetIndexes(
    state.pieceTable,
    nextState.pieceTable,
    position,
    position,
    result.insertedByteLength,
  );
  return {
    state: nextState,
    insertedByteLength: result.insertedByteLength,
    splits: result.splits,
  };
}

/**
 * Delete text from piece table in range [start, end), migrating the attention layer.
 * Returns new document state with updated piece table.
 *
 * Points are re-anchored against the post-delete tree (trailing points shift
 * left, points inside the span collapse to its start). `start`/`end` arrive
 * already clamped from the reducer's `validateRange` / `validatePosition`.
 */
export function pieceTableDelete(
  state: DocumentState,
  start: ByteOffset,
  end: ByteOffset,
): DocumentState {
  const oldRoot = state.pieceTable.root;
  const newPieceTable = ptDelete(state.pieceTable, start, end);
  const attention = migrateDelete(state.attention, oldRoot, newPieceTable.root, start, end);
  const nextState = withState(state, { pieceTable: newPieceTable, attention });
  carryLineOffsetIndexes(state.pieceTable, nextState.pieceTable, start, end, 0);
  return nextState;
}

/**
 * Get text in a range from the piece table.
 * Used for capturing deleted text for undo.
 */
export function getTextRange(state: DocumentState, start: ByteOffset, end: ByteOffset): string {
  return getText(state.pieceTable, start, end);
}

// =============================================================================
// Eager and lazy line-index update strategies
// =============================================================================

/**
 * Normalizes eager and lazy line-index update functions behind a common interface.
 * Callers select the appropriate strategy at their boundary
 * rather than scattering ad-hoc `if (eager) liInsert(...) else liInsertLazy(...)` branches.
 *
 * CRLF deletion boundary repair is handled by the structural edit pipeline.
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

/**
 * Eager strategy applies structural changes and downstream absolute-offset
 * updates immediately, with no dirty ranges.
 */
export const eagerStrategy: LineIndexStrategy = {
  insert: (li, pos, text, readText) => liInsert(li, pos, text, readText),
  delete: (li, pos, end, text, ctx) => liDelete(li, pos, end, text, ctx),
};

/** Record dirty ranges for background reconciliation during edits and history replay. */
export function lazyStrategy(revision: number): LineIndexStrategy {
  return {
    insert: (li, pos, text, readText) => liInsertLazy(li, pos, text, revision, readText),
    delete: (li, pos, end, text, ctx) => liDeleteLazy(li, pos, end, text, revision, ctx),
  };
}

export function getDeleteBoundaryContext(
  state: DocumentState,
  start: ByteOffset,
  end: ByteOffset,
): DeleteBoundaryContext {
  const totalLength = state.pieceTable.totalLength;

  // Read raw bytes immediately before and after the delete range.
  // Detect CRLF boundaries using only CR (0x0d) and LF (0x0a).
  // All other byte values (including multi-byte UTF-8 continuation bytes that
  // could appear at the boundary) are irrelevant and map to undefined.
  const prevByte = start > 0 ? getRawByte(state.pieceTable, byteOffset(start - 1)) : -1;
  const nextByte = end < totalLength ? getRawByte(state.pieceTable, end) : -1;

  return {
    prevChar: prevByte === 0x0d ? "\r" : prevByte === 0x0a ? "\n" : undefined,
    nextChar: nextByte === 0x0d ? "\r" : nextByte === 0x0a ? "\n" : undefined,
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
  // Restore maxDirtyRanges because rebuildLineIndex uses the default of 32.
  const rebuiltWithConfig = withLineIndexState(rebuilt, {
    maxDirtyRanges: state.lineIndex.maxDirtyRanges,
  });
  return withState(state, { lineIndex: rebuiltWithConfig });
}

// =============================================================================
// History Operations
// =============================================================================

/**
 * Selection to restore when redoing `change`, anchored against `state`
 * (the document after the change).
 */
function computeSelectionAfterChange(
  state: DocumentState,
  change: HistoryChange,
): HistorySelectionState {
  const start = residentOffset(state.pieceTable, change);
  // After insert and replace the cursor sits after the inserted text; after a
  // delete it sits at the deletion point.
  const position = change.type === "delete" ? start : start + change.byteLength;
  return anchorSelection(
    state.pieceTable,
    Object.freeze({
      ranges: Object.freeze([
        Object.freeze({ anchor: byteOffset(position), head: byteOffset(position) }),
      ] as const),
      primaryIndex: 0,
    }),
  );
}

// Coalesced entries share their original changes until a consumer requests the array.
const coalescedTails = new WeakMap<
  HistoryEntry,
  {
    base: readonly HistoryChange[];
    tail: HistoryChange;
  }
>();

function lastHistoryChange(entry: HistoryEntry): HistoryChange | undefined {
  return coalescedTails.get(entry)?.tail ?? entry.changes[entry.changes.length - 1];
}

/**
 * Check if a new change can be coalesced with the last history entry.
 * Coalescing merges consecutive same-type changes within a timeout window
 * into a single undo entry (e.g., typing a word becomes one undo step).
 *
 * Coalescing targets the last change in the entry regardless of how many
 * changes it contains (e.g., the tail of a batched transaction). The earlier
 * changes are preserved in the merged entry by historyPush.
 *
 * Positions are compared as resident offsets. Chunks may have been loaded
 * between the two edits, which changes resident offsets but not anchors.
 */
function canCoalesce(
  pieceTable: PieceTableState,
  lastEntry: HistoryEntry,
  newChange: HistoryChange,
  timeout: number,
  now: number,
): boolean {
  if (timeout <= 0) return false;
  if (now - lastEntry.timestamp > timeout) return false;
  const last = lastHistoryChange(lastEntry);
  if (!last) return false;
  if (last.type !== newChange.type) return false;
  // A merged change re-inserts its text with one placement key on undo. Keep
  // changes separate when a chunk that is not loaded lies between their keys.
  const lowKey = Math.min(last.afterChunk, newChange.afterChunk);
  const highKey = Math.max(last.afterChunk, newChange.afterChunk);
  if (hasUnloadedChunkBetween(pieceTable, lowKey, highKey)) return false;
  const lastPosition = residentOffset(pieceTable, last);
  const newPosition = residentOffset(pieceTable, newChange);

  switch (newChange.type) {
    case "insert":
      // Coalesce typing when the new insert starts where the last insert ended.
      return newPosition === lastPosition + last.byteLength;
    case "delete": {
      // Coalesce backspaces when the new delete ends where the last delete starts.
      if (newPosition + newChange.byteLength === lastPosition) return true;
      // Coalesce forward deletes at the same position.
      if (newPosition === lastPosition) return true;
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
  pieceTable: PieceTableState,
  existing: HistoryChange,
  incoming: HistoryChange,
): HistoryChange {
  switch (incoming.type) {
    case "insert": {
      // Append the text and keep the earlier position.
      return Object.freeze({
        type: "insert" as const,
        position: existing.position,
        afterChunk: existing.afterChunk,
        text: existing.text + incoming.text,
        byteLength: byteLength(existing.byteLength + incoming.byteLength),
      });
    }
    case "delete": {
      if (
        residentOffset(pieceTable, incoming) + incoming.byteLength ===
        residentOffset(pieceTable, existing)
      ) {
        // Prepend backspaced text and use the earlier position.
        return Object.freeze({
          type: "delete" as const,
          position: incoming.position,
          afterChunk: incoming.afterChunk,
          text: incoming.text + existing.text,
          byteLength: byteLength(existing.byteLength + incoming.byteLength),
        });
      }
      // Append forward-deleted text and keep the position.
      return Object.freeze({
        type: "delete" as const,
        position: existing.position,
        afterChunk: existing.afterChunk,
        text: existing.text + incoming.text,
        byteLength: byteLength(existing.byteLength + incoming.byteLength),
      });
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
// Standalone factories derive lengths from text without allocating UTF-8 arrays.
// applyEdit can instead reuse lengths measured by its structural edit.
// `position` is an anchored position (see HistoryAnchor). It equals the byte
// offset when `afterChunk` is -1 and no chunk is loaded.

export function makeInsertChange(
  position: number,
  text: string,
  afterChunk: number = NO_CHUNK,
): HistoryInsertChange {
  return Object.freeze({
    type: "insert" as const,
    position,
    afterChunk,
    text,
    byteLength: byteLength(utf8ByteLength(text)),
  });
}

export function makeDeleteChange(
  position: number,
  text: string,
  afterChunk: number = NO_CHUNK,
): HistoryDeleteChange {
  return Object.freeze({
    type: "delete" as const,
    position,
    afterChunk,
    text,
    byteLength: byteLength(utf8ByteLength(text)),
  });
}

export function makeReplaceChange(
  position: number,
  text: string,
  oldText: string,
  afterChunk: number = NO_CHUNK,
): HistoryReplaceChange {
  return Object.freeze({
    type: "replace" as const,
    position,
    afterChunk,
    text,
    byteLength: byteLength(utf8ByteLength(text)),
    oldText,
    oldByteLength: byteLength(utf8ByteLength(oldText)),
  });
}

/**
 * Push changes to the history stack as one entry.
 * A single change may coalesce with the previous entry if within the coalesce
 * timeout. `state` is the document after the changes. `selectionBefore`
 * defaults to the selection of `state`, anchored against it.
 */
export function historyPush(
  state: DocumentState,
  changeOrChanges: HistoryChange | NonEmptyReadonlyArray<HistoryChange>,
  now: number,
  selectionBefore: HistorySelectionState = anchorSelection(state.pieceTable, state.selection),
): DocumentState {
  const history = state.history;
  const changes: NonEmptyReadonlyArray<HistoryChange> = Array.isArray(changeOrChanges)
    ? (changeOrChanges as NonEmptyReadonlyArray<HistoryChange>)
    : [changeOrChanges as HistoryChange];

  // Compute expected selection after the change for proper redo. The last
  // change of an entry is the one applied last, so it places the cursor.
  const selectionAfter = computeSelectionAfterChange(state, changes[changes.length - 1]!);

  // Try to coalesce with the last entry
  const change = changes[0];
  const lastEntry = pstackPeek(history.undoStack);
  if (
    changes.length === 1 &&
    lastEntry &&
    canCoalesce(state.pieceTable, lastEntry, change, history.coalesceTimeout, now)
  ) {
    // canCoalesce returning true guarantees a non-empty changes list.
    const lastChange = lastHistoryChange(lastEntry)!;
    const merged = coalesceChanges(state.pieceTable, lastChange, change);
    const base = coalescedTails.get(lastEntry)?.base ?? lastEntry.changes;
    let materialized: readonly HistoryChange[] | undefined;
    // Preserve the array API while keeping repeated tail updates constant-space.
    const mergedEntry: HistoryEntry = Object.freeze({
      get changes() {
        return (materialized ??= Object.freeze([...base.slice(0, -1), merged]));
      },
      selectionBefore: lastEntry.selectionBefore,
      selectionAfter,
      timestamp: now,
    });
    coalescedTails.set(mergedEntry, { base, tail: merged });
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
    changes: Object.freeze([...changes]),
    selectionBefore,
    selectionAfter,
    timestamp: now,
  });

  // Trim undo stack if it exceeds limit.
  // The persistent AVL split keeps this O(log limit) after the stack saturates.
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
// Change Application (used by historyUndo / historyRedo in history.ts)
// =============================================================================

/**
 * Invert a history change.
 * insert ↔ delete, replace swaps text/oldText. The anchor is kept: it is the
 * position of the first affected byte in both directions.
 * This formalizes the duality between applyChange and applyInverseChange.
 */
export function invertChange(change: HistoryChange): HistoryChange {
  switch (change.type) {
    case "insert":
      return Object.freeze({
        type: "delete" as const,
        position: change.position,
        afterChunk: change.afterChunk,
        text: change.text,
        byteLength: change.byteLength,
      });
    case "delete":
      return Object.freeze({
        type: "insert" as const,
        position: change.position,
        afterChunk: change.afterChunk,
        text: change.text,
        byteLength: change.byteLength,
      });
    case "replace":
      return Object.freeze({
        type: "replace" as const,
        position: change.position,
        afterChunk: change.afterChunk,
        text: change.oldText,
        byteLength: change.oldByteLength,
        oldText: change.text,
        oldByteLength: change.byteLength,
      });
  }
}

/**
 * Replay history through the same lazy structural pipeline as local edits.
 * The anchored position is resolved against the current chunk layout, and
 * inserted text gets the recorded placement key.
 */
export function applyChange(state: DocumentState, change: HistoryChange): DocumentState {
  const position = residentOffset(state.pieceTable, change);
  switch (change.type) {
    case "insert":
      return applyUntrackedEdit(
        state,
        {
          kind: "insert",
          position,
          insertText: change.text,
          afterChunk: change.afterChunk,
        },
        state.revision + 1,
      );
    case "delete":
      return applyUntrackedEdit(
        state,
        {
          kind: "delete",
          position,
          deleteEnd: byteOffset(position + change.byteLength),
          deletedText: change.text,
        },
        state.revision + 1,
      );
    case "replace":
      return applyUntrackedEdit(
        state,
        {
          kind: "replace",
          position,
          deleteEnd: byteOffset(position + change.oldByteLength),
          deletedText: change.oldText,
          insertText: change.text,
          afterChunk: change.afterChunk,
        },
        state.revision + 1,
      );
  }
}

export function applyInverseChange(state: DocumentState, change: HistoryChange): DocumentState {
  return applyChange(state, invertChange(change));
}

// =============================================================================
// Unified Edit Pipeline
// =============================================================================

/**
 * An edit operation distinguished by `kind`. Each variant carries only the
 * fields needed for its delete and insert phases.
 */
export type StructuralEditOperation =
  | {
      readonly kind: "insert";
      readonly position: ByteOffset;
      readonly insertText: string;
      /** Placement key for the inserted text. Defaults to the gap's key. */
      readonly afterChunk?: number | undefined;
    }
  | {
      readonly kind: "delete";
      readonly position: ByteOffset;
      readonly deleteEnd: ByteOffset;
      readonly deletedText: string;
    }
  | {
      readonly kind: "replace";
      readonly position: ByteOffset;
      readonly deleteEnd: ByteOffset;
      readonly deletedText: string;
      readonly insertText: string;
      /** Placement key for the inserted text. Defaults to the gap's key. */
      readonly afterChunk?: number | undefined;
    };

export type EditOperation = StructuralEditOperation & {
  readonly timestamp?: number | undefined;
  readonly selection?: NonEmptyReadonlyArray<SelectionRange> | undefined;
};

/**
 * Apply the structural portion of an edit without history, metadata, selection,
 * or revision bookkeeping.
 *
 * Local edits and APPLY_REMOTE both use this path so piece-table mutation,
 * attention migration, CRLF boundary handling, and lazy line-index maintenance
 * cannot drift into separate implementations. `revision` is the revision that
 * owns the resulting dirty ranges. The caller commits it after composing any
 * additional structural edits.
 */
export function applyUntrackedEdit(
  state: DocumentState,
  op: StructuralEditOperation,
  revision: number,
): DocumentState {
  const strategy = lazyStrategy(revision);
  let newState = state;

  const deleteContext =
    op.kind !== "insert"
      ? getDeleteBoundaryContext(newState, op.position, op.deleteEnd)
      : undefined;
  const needsRebuild =
    op.kind !== "insert" && shouldRebuildLineIndexForDelete(op.deletedText, deleteContext);

  if (op.kind !== "insert") {
    if (needsRebuild) {
      newState = pieceTableDelete(newState, op.position, op.deleteEnd);
    } else {
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

  if (op.kind !== "delete" && op.insertText.length > 0) {
    const result = pieceTableInsert(newState, op.position, op.insertText, op.afterChunk);
    newState = result.state;
    if (!needsRebuild) {
      const readText = pieceTableReader(newState.pieceTable);
      const insLineIndex = strategy.insert(
        newState.lineIndex,
        op.position,
        op.insertText,
        readText,
      );
      newState = withState(newState, { lineIndex: insLineIndex });
    }
  }

  if (needsRebuild) {
    const insertedLength =
      newState.pieceTable.totalLength - state.pieceTable.totalLength + (op.deleteEnd - op.position);
    return withState(newState, {
      lineIndex: repairLineIndexWindow(
        state.lineIndex,
        op.position,
        op.deleteEnd,
        insertedLength,
        pieceTableReader(newState.pieceTable),
        revision,
      ),
    });
  }
  return newState;
}

/**
 * Apply a text edit through the unified pipeline:
 * 1. Delete phase (if deleteEnd specified)
 * 2. Insert phase (if insertText non-empty)
 * 3. Build history change
 * 4. Push to history
 * 5. Mark dirty + increment revision
 */
export function applyEdit(state: DocumentState, op: EditOperation): DocumentState {
  // Keep the state invariant intact for JavaScript callers or forged actions that
  // bypass the typed action creators and dispatchValidated boundary.
  if (op.selection?.length === 0) {
    throw new TypeError("Edit selection ranges must be non-empty");
  }
  if (op.selection) {
    for (const [index, range] of op.selection.entries()) {
      const anchor = validatePosition(range.anchor, state.pieceTable.totalLength);
      const head = validatePosition(range.head, state.pieceTable.totalLength);
      if (!isUtf8Boundary(state.pieceTable, anchor)) {
        throw new RangeError(
          `edit selection[${index}].anchor (${anchor}) must be a UTF-8 code-point boundary`,
        );
      }
      if (!isUtf8Boundary(state.pieceTable, head)) {
        throw new RangeError(
          `edit selection[${index}].head (${head}) must be a UTF-8 code-point boundary`,
        );
      }
    }
  }
  const nextRevision = state.revision + 1;
  const pieceTable = state.pieceTable;
  // Split deleted text where parts of it would land on different sides of an
  // unloaded chunk when re-inserted. Usually there is a single run.
  const runs = op.kind === "insert" ? [] : placementRuns(pieceTable, op.position, op.deleteEnd);
  // Inserted text takes the key of the text it replaces, or the gap's key.
  const insertKey = runs.length > 0 ? runs[0]!.key : gapKey(pieceTable.root, op.position);
  let newState = applyUntrackedEdit(
    state,
    op.kind === "delete" ? op : { ...op, afterChunk: insertKey },
    nextRevision,
  );

  // Apply inline selection so historyPush records the correct selectionBefore.
  // Inline edit selections describe the pre-edit document, so clamp to the original length.
  if (op.selection) {
    newState = withState(newState, {
      selection: Object.freeze({
        ranges: Object.freeze(
          op.selection.map((r) =>
            Object.freeze({
              anchor: validatePosition(r.anchor, state.pieceTable.totalLength),
              head: validatePosition(r.head, state.pieceTable.totalLength),
            }),
          ),
        ) as NonEmptyReadonlyArray<SelectionRange>,
        primaryIndex: 0,
      }),
    });
  }

  // Reuse measured insert lengths. Deleted text may have been normalized by
  // decoding (malformed chunk bytes or a BOM), so measure it without encoding.
  const deletedLength = op.kind === "insert" ? 0 : op.deleteEnd - op.position;
  const insertedLength =
    newState.pieceTable.totalLength - state.pieceTable.totalLength + deletedLength;
  // History positions are anchored against the pre-edit document. Edits never
  // load or evict chunks, so the post-edit chunk layout resolves them the same way.
  const anchor = anchorAt(pieceTable, insertKey, op.position);
  // Each run except the first becomes its own delete, ordered right to left so
  // every position is valid when its change is applied. Undo applies them in
  // reverse, re-inserting each run with its own key.
  const changes: HistoryChange[] = [];
  for (let i = runs.length - 1; i >= 1; i--) {
    const run = runs[i]!;
    changes.push(
      makeDeleteChange(
        anchorAt(pieceTable, run.key, run.start).position,
        getTextRange(state, byteOffset(run.start), byteOffset(run.end)),
        run.key,
      ),
    );
  }
  const firstDeletedText =
    runs.length > 1
      ? getTextRange(state, byteOffset(runs[0]!.start), byteOffset(runs[0]!.end))
      : op.kind === "insert"
        ? ""
        : op.deletedText;
  const historyDeletedLength = utf8ByteLength(firstDeletedText);
  changes.push(
    Object.freeze(
      op.kind === "replace"
        ? {
            type: "replace" as const,
            ...anchor,
            text: op.insertText,
            byteLength: byteLength(insertedLength),
            oldText: firstDeletedText,
            oldByteLength: byteLength(historyDeletedLength),
          }
        : op.kind === "insert"
          ? {
              type: "insert" as const,
              ...anchor,
              text: op.insertText,
              byteLength: byteLength(insertedLength),
            }
          : {
              type: "delete" as const,
              ...anchor,
              text: firstDeletedText,
              byteLength: byteLength(historyDeletedLength),
            },
    ),
  );
  // Timestamp-less hand-written actions remain deterministic. Normal callers use
  // DocumentActions, which captures wall-clock time before reduction.
  newState = historyPush(
    newState,
    changes as unknown as NonEmptyReadonlyArray<HistoryChange>,
    op.timestamp ?? state.revision,
    anchorSelection(pieceTable, newState.selection),
  );

  // Mark as dirty and increment revision
  return withState(newState, {
    revision: nextRevision,
    metadata: Object.freeze({
      ...state.metadata,
      isDirty: true,
    }),
  });
}
