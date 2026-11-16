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
  SelectionState,
  NonEmptyReadonlyArray,
} from "../../types/state.js";
import { pstackPush, pstackPeek, pstackPop, pstackTrimToSize } from "../../types/state.js";
import type { ByteOffset, ReadonlyUint8Array } from "../../types/branded.js";
import type { DeleteBoundaryContext, ReadTextFn } from "../../types/operations.js";
import { byteOffset, byteLength } from "../../types/branded.js";
import { withState, withLineIndexState } from "../core/state.js";
import {
  pieceTableInsert as ptInsert,
  pieceTableDelete as ptDelete,
  getText,
  getRawByte,
  getBytes,
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
import { asReadonlyUint8Array, unwrapReadonlyUint8Array } from "../core/runtime-readonly.js";
import { encodesTo, textDecoder, utf8ByteLength } from "../core/encoding.js";
import { NO_CHUNK, placementRuns } from "../core/chunk-anchor.js";
import type { KeyRun } from "../core/chunk-anchor.js";
import {
  anchorAt,
  anchorSelection,
  anchoredCursor,
  insertionKey,
  residentOffset,
  selectionRangesWithKeys,
} from "./history-anchor.js";
import { coalescedTails, lastHistoryChange } from "./history-entry.js";

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
  text: string | Uint8Array,
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
 * Selection to restore when redoing `change`: a cursor after the inserted text,
 * or at the deletion point.
 *
 * The cursor takes the change's own placement key. Redo replays the change
 * with that key, so the cursor stays next to the replayed text even when a
 * chunk next to it loads in between. The gap's key in the edited document can
 * name the far side of a chunk that was not loaded when the edit was made.
 */
function selectionAfterChange(change: HistoryChange): HistorySelectionState {
  const position = change.type === "delete" ? change.position : change.position + change.byteLength;
  return anchoredCursor(change.afterChunk, position);
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
  // A change with raw bytes restores exactly the bytes one edit removed. Keep
  // it separate rather than merge decoded text with a neighbour.
  if (last.bytes !== undefined || newChange.bytes !== undefined) return false;
  // A merged change re-inserts all its text with one placement key, so only
  // changes with the same key merge (see `placementRuns`).
  if (last.afterChunk !== newChange.afterChunk) return false;
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

/**
 * True when `text`, the decoding of `length` bytes, is known to encode back to
 * them without comparing bytes.
 *
 * Decoding changes bytes only by replacing malformed sequences with U+FFFD or
 * dropping a leading byte order mark. Dropping a BOM shortens the text, so text
 * of the right length with no U+FFFD is exact. A replacement can keep the
 * length (three malformed bytes become one 3-byte U+FFFD), so text containing
 * U+FFFD has to be compared byte for byte.
 */
function isExactDecoding(text: string, length: number): boolean {
  return utf8ByteLength(text) === length && !text.includes("�");
}

/** The bytes in `[start, end)` when `text`, their decoding, does not encode back to them. */
function rawBytesUnlessExact(
  pieceTable: PieceTableState,
  text: string,
  start: number,
  end: number,
): ReadonlyUint8Array | undefined {
  if (isExactDecoding(text, end - start)) return undefined;
  const raw = getBytes(pieceTable, byteOffset(start), byteOffset(end));
  return encodesTo(text, raw) ? undefined : asReadonlyUint8Array(raw);
}

/** Deleted text of one placement run, with its bytes when the text is inexact. */
interface DeletedRun {
  readonly text: string;
  readonly length: number;
  readonly bytes?: ReadonlyUint8Array;
}

/**
 * Text and, where needed, raw bytes of each run of a delete. `deletedText` is
 * the decoding of the whole range, which a single run reuses. Several runs
 * read the range's bytes once and decode each run from them, the way
 * `getText` decodes a range.
 */
function deletedRuns(
  pieceTable: PieceTableState,
  runs: readonly KeyRun[],
  deletedText: string,
): DeletedRun[] {
  if (runs.length === 1) {
    const { start, end } = runs[0]!;
    const bytes = rawBytesUnlessExact(pieceTable, deletedText, start, end);
    return [
      bytes === undefined
        ? { text: deletedText, length: end - start }
        : { text: deletedText, length: end - start, bytes },
    ];
  }
  if (runs.length === 0) return [];
  const base = runs[0]!.start;
  const all = getBytes(pieceTable, byteOffset(base), byteOffset(runs[runs.length - 1]!.end));
  return runs.map((run) => {
    const raw = all.subarray(run.start - base, run.end - base);
    const text = textDecoder.decode(raw);
    const length = run.end - run.start;
    return isExactDecoding(text, length) || encodesTo(text, raw)
      ? { text, length }
      : { text, length, bytes: asReadonlyUint8Array(raw.slice()) };
  });
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
 * timeout. `state` is the document after the changes. `selectionBefore` is
 * only called when a new entry is created: a coalesced entry keeps the
 * selection of the entry it extends. It must anchor the selection against the
 * document before the changes, which `state` no longer holds.
 */
export function historyPush(
  state: DocumentState,
  changes: NonEmptyReadonlyArray<HistoryChange>,
  now: number,
  selectionBefore: () => HistorySelectionState,
): DocumentState {
  const history = state.history;

  // Compute expected selection after the change for proper redo. The last
  // change of an entry is the one applied last, so it places the cursor.
  const selectionAfter = selectionAfterChange(changes[changes.length - 1]!);

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
    selectionBefore: selectionBefore(),
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
  const anchor = { position: change.position, afterChunk: change.afterChunk };
  switch (change.type) {
    case "insert":
      return Object.freeze({
        type: "delete" as const,
        ...anchor,
        ...(change.bytes !== undefined && { bytes: change.bytes }),
        text: change.text,
        byteLength: change.byteLength,
      });
    case "delete":
      return Object.freeze({
        type: "insert" as const,
        ...anchor,
        ...(change.bytes !== undefined && { bytes: change.bytes }),
        text: change.text,
        byteLength: change.byteLength,
      });
    case "replace":
      return Object.freeze({
        type: "replace" as const,
        ...anchor,
        ...(change.oldBytes !== undefined && { bytes: change.oldBytes }),
        text: change.oldText,
        byteLength: change.oldByteLength,
        ...(change.bytes !== undefined && { oldBytes: change.bytes }),
        oldText: change.text,
        oldByteLength: change.byteLength,
      });
  }
}

/** Bytes a delete or replace change removes. */
function historyDeletedLength(change: HistoryDeleteChange | HistoryReplaceChange): number {
  return change.type === "delete" ? change.byteLength : change.oldByteLength;
}

/**
 * Replay history through the same lazy structural pipeline as local edits.
 * The anchored position is resolved against the current chunk layout, and
 * inserted text gets the recorded placement key. Recorded raw bytes are
 * inserted as they are, so undo restores bytes that decoding altered.
 */
export function applyChange(state: DocumentState, change: HistoryChange): DocumentState {
  const position = residentOffset(state.pieceTable, change);
  // A position is recorded in the document the change applies to, so a valid
  // history always resolves inside it. Insert would append an out-of-range
  // position at the end and delete would remove other bytes, so refuse instead.
  const removed = change.type === "insert" ? 0 : historyDeletedLength(change);
  if (position < 0 || position + removed > state.pieceTable.totalLength) {
    throw new RangeError(
      `history ${change.type} at anchored position ${change.position} with placement key ` +
        `${change.afterChunk} resolves to [${position}, ${position + removed}), outside the ` +
        `${state.pieceTable.totalLength}-byte document`,
    );
  }
  const insertBytes =
    change.bytes !== undefined ? { insertBytes: unwrapReadonlyUint8Array(change.bytes) } : {};
  switch (change.type) {
    case "insert":
      return applyUntrackedEdit(
        state,
        {
          kind: "insert",
          position,
          insertText: change.text,
          ...insertBytes,
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
          ...(change.bytes !== undefined && { deletedTextInexact: true }),
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
          ...(change.oldBytes !== undefined && { deletedTextInexact: true }),
          insertText: change.text,
          ...insertBytes,
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
      /** Raw bytes to insert in place of `insertText` encoded as UTF-8. */
      readonly insertBytes?: Uint8Array | undefined;
      /** Placement key for the inserted text. Defaults to the gap's key. */
      readonly afterChunk?: number | undefined;
    }
  | {
      readonly kind: "delete";
      readonly position: ByteOffset;
      readonly deleteEnd: ByteOffset;
      readonly deletedText: string;
      /** The deleted bytes do not encode `deletedText`, so lines are re-read. */
      readonly deletedTextInexact?: boolean | undefined;
    }
  | {
      readonly kind: "replace";
      readonly position: ByteOffset;
      readonly deleteEnd: ByteOffset;
      readonly deletedText: string;
      /** The deleted bytes do not encode `deletedText`, so lines are re-read. */
      readonly deletedTextInexact?: boolean | undefined;
      readonly insertText: string;
      /** Raw bytes to insert in place of `insertText` encoded as UTF-8. */
      readonly insertBytes?: Uint8Array | undefined;
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
  // Line updates read the edit's text. When that text is not the bytes being
  // deleted or inserted, re-read the affected lines from the piece table.
  const insertBytes = op.kind !== "delete" ? op.insertBytes : undefined;
  const needsRebuild =
    insertBytes !== undefined ||
    (op.kind !== "insert" &&
      (op.deletedTextInexact === true ||
        shouldRebuildLineIndexForDelete(op.deletedText, deleteContext))) ||
    splitsCharacter(state.pieceTable, op);

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

  const insertContent = insertBytes ?? (op.kind !== "delete" ? op.insertText : "");
  if (op.kind !== "delete" && insertContent.length > 0) {
    // Without a key from the caller, take the one a cursor there holds (see
    // `insertionKey`), so remote text typed into an empty document stays
    // where the cursor was in the file.
    const afterChunk =
      op.afterChunk ?? insertionKey(newState.pieceTable, state.selection, op.position);
    const result = pieceTableInsert(newState, op.position, insertContent, afterChunk);
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

  const deleteEnd = op.kind === "insert" ? op.position : op.deleteEnd;
  const insertedLength =
    newState.pieceTable.totalLength - state.pieceTable.totalLength + (deleteEnd - op.position);
  // The edit can also join characters across its edges in the edited document.
  // The fast update above is then wrong, so repair from the original index.
  if (
    needsRebuild ||
    splitsCharacterAfter(newState.pieceTable, op.position, op.position + insertedLength)
  ) {
    const window = codePointWindow(newState.pieceTable, op.position, deleteEnd, insertedLength);
    return withState(newState, {
      lineIndex: repairLineIndexWindow(
        state.lineIndex,
        window.start,
        window.end,
        window.insertedLength,
        pieceTableReader(newState.pieceTable),
        revision,
      ),
    });
  }
  return newState;
}

/** Bytes a UTF-8 lead byte can own after it. */
const MAX_CONTINUATION_BYTES = 3;

function isContinuationByte(pieceTable: PieceTableState, offset: number): boolean {
  return (getRawByte(pieceTable, byteOffset(offset)) & 0xc0) === 0x80;
}

/**
 * True when splitting the bytes of `pieceTable` at `offset` leaves the decoding
 * of both sides as it is in the whole document, so their characters can be
 * counted apart.
 *
 * A decoder ends a pending sequence at a byte that is not a continuation byte,
 * just as it does at the end of its input, so splitting before such a byte is
 * safe. So is splitting before a continuation byte that follows three others:
 * no lead byte can own it, so it decodes to U+FFFD on its own either way.
 */
function isSafeSplit(pieceTable: PieceTableState, offset: number): boolean {
  if (offset <= 0 || offset >= pieceTable.totalLength) return true;
  if (!isContinuationByte(pieceTable, offset)) return true;
  for (let back = 1; back <= MAX_CONTINUATION_BYTES; back++) {
    if (offset - back < 0 || !isContinuationByte(pieceTable, offset - back)) return false;
  }
  return true;
}

/**
 * True when an edge of `op` cuts a character of `pieceTable`, the document
 * before the edit.
 *
 * The reducer refuses such edits, but undo and redo replay a change recorded
 * before chunks loaded beside it. A chunk that loaded since can complete a
 * character cut at the edge, so the edit joins or splits characters there. The
 * fast line update counts the edit's text apart from the text around it, so
 * these edits re-read the lines instead (see `codePointWindow`). Text inserted
 * as a string is whole characters, so these edges are the only ones that can
 * cut one. Without chunks, history replays into the document it was recorded
 * in, where the reducer checked every edge.
 */
function splitsCharacter(pieceTable: PieceTableState, op: StructuralEditOperation): boolean {
  if (pieceTable.nextExpectedChunk === 0) return false;
  if (!isSafeSplit(pieceTable, op.position)) return true;
  return op.kind !== "insert" && !isSafeSplit(pieceTable, op.deleteEnd);
}

/**
 * True when the edges of the text an edit left at [start, end) of
 * `pieceTable`, the edited document, cut a character there.
 *
 * Edges that were safe before the edit can stop being safe: deleting a whole
 * character between an incomplete sequence and a continuation byte it left
 * on its own joins the two. See `splitsCharacter`.
 */
function splitsCharacterAfter(pieceTable: PieceTableState, start: number, end: number): boolean {
  if (pieceTable.nextExpectedChunk === 0) return false;
  return !isSafeSplit(pieceTable, start) || !isSafeSplit(pieceTable, end);
}

/**
 * Widen an edit that replaced [start, end) with `insertedLength` bytes so both
 * edges are safe splits of `pieceTable`, the edited document (see
 * `isSafeSplit`).
 *
 * The line-index repair counts the characters before, inside and after the
 * edit apart. Bytes undo or redo puts back can join the bytes beside them into
 * one character, for example a lead byte re-inserted before the continuation
 * bytes of a chunk that loaded since the edit. Counted apart, those bytes give
 * one U+FFFD each. The bytes the window gains are the same in both documents,
 * so they count as deleted and re-inserted. A safe split lies within four bytes
 * of any offset.
 */
function codePointWindow(
  pieceTable: PieceTableState,
  start: ByteOffset,
  end: ByteOffset,
  insertedLength: number,
): { start: ByteOffset; end: ByteOffset; insertedLength: number } {
  let before = 0;
  while (!isSafeSplit(pieceTable, start - before)) before++;
  const insertedEnd = start + insertedLength;
  let after = 0;
  while (!isSafeSplit(pieceTable, insertedEnd + after)) after++;
  if (before === 0 && after === 0) return { start, end, insertedLength };
  return {
    start: byteOffset(start - before),
    end: byteOffset(end + after),
    insertedLength: insertedLength + before + after,
  };
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
  // The selection the edit comes from: the inline selection when given, else
  // the current one. Inline edit selections describe the pre-edit document,
  // so clamp to the original length. A range that repeats the current one
  // keeps its placement keys (see `selectionRangesWithKeys`).
  const selectionBefore: SelectionState = op.selection
    ? Object.freeze({
        ranges: selectionRangesWithKeys(pieceTable, state.selection, op.selection, (offset) =>
          validatePosition(offset, pieceTable.totalLength),
        ),
        primaryIndex: 0,
      })
    : state.selection;
  // Split deleted text into runs that share a placement key, so undo gives
  // every byte back its key. Usually there is a single run.
  const runs = op.kind === "insert" ? [] : placementRuns(pieceTable, op.position, op.deleteEnd);
  // Inserted text takes the key of the text it replaces, or the key a cursor
  // at the insertion point holds, or the gap's key.
  const insertKey =
    runs.length > 0 ? runs[0]!.key : insertionKey(pieceTable, selectionBefore, op.position);
  let newState = applyUntrackedEdit(
    state,
    op.kind === "delete" ? op : { ...op, afterChunk: insertKey },
    nextRevision,
  );

  // Apply inline selection so historyPush records the correct selectionBefore.
  if (op.selection) newState = withState(newState, { selection: selectionBefore });

  // Reuse the insert length measured by the structural edit.
  const deletedLength = op.kind === "insert" ? 0 : op.deleteEnd - op.position;
  const insertedLength =
    newState.pieceTable.totalLength - state.pieceTable.totalLength + deletedLength;
  // History positions are anchored against the pre-edit document. Edits never
  // load or evict chunks, so the post-edit chunk layout resolves them the same way.
  const anchor = anchorAt(pieceTable, insertKey, op.position);
  // Deleted text as undo re-inserts it. Decoding replaces malformed bytes with
  // U+FFFD and drops a leading byte order mark, so the text can encode to
  // different bytes than were deleted. Bytes at the edge of an unloaded chunk
  // are often an incomplete character. When the text does not encode back to
  // the deleted bytes, history keeps the exact bytes, so undo restores the
  // document byte for byte and every recorded position stays valid.
  // Runs are empty for an insert. A single run is the whole deleted range.
  const deleted = deletedRuns(pieceTable, runs, op.kind === "insert" ? "" : op.deletedText);
  // Each run except the first becomes its own delete, ordered right to left so
  // every position is valid when its change is applied. Undo applies them in
  // reverse, re-inserting each run with its own key.
  const changes: HistoryChange[] = [];
  for (let i = runs.length - 1; i >= 1; i--) {
    const run = runs[i]!;
    const { text, length, bytes } = deleted[i]!;
    changes.push(
      Object.freeze({
        type: "delete" as const,
        ...anchorAt(pieceTable, run.key, run.start),
        ...(bytes !== undefined && { bytes }),
        text,
        byteLength: byteLength(length),
      }),
    );
  }
  const first = deleted[0] ?? { text: "", length: 0 };
  const firstBytes = first.bytes;
  changes.push(
    Object.freeze(
      op.kind === "replace"
        ? {
            type: "replace" as const,
            ...anchor,
            text: op.insertText,
            byteLength: byteLength(insertedLength),
            ...(firstBytes !== undefined && { oldBytes: firstBytes }),
            oldText: first.text,
            oldByteLength: byteLength(first.length),
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
              ...(firstBytes !== undefined && { bytes: firstBytes }),
              text: first.text,
              byteLength: byteLength(first.length),
            },
    ),
  );
  // Timestamp-less hand-written actions remain deterministic. Normal callers use
  // DocumentActions, which captures wall-clock time before reduction.
  newState = historyPush(
    newState,
    changes as unknown as NonEmptyReadonlyArray<HistoryChange>,
    op.timestamp ?? state.revision,
    () => anchorSelection(pieceTable, selectionBefore),
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
