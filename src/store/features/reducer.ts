/**
 * Apply document actions as pure state transitions.
 *
 * Route text edits to `edit.ts` and undo/redo to `history.ts`.
 */

import type { DocumentState, SelectionRange, SelectionState } from "../../types/state.js";
import type { DocumentAction } from "../../types/actions.js";
import { byteOffset } from "../../types/branded.js";
import { withState } from "../core/state.js";
import { isUtf8Boundary } from "../core/piece-table.js";
import {
  validatePosition,
  validateRange,
  getTextRange,
  readDeletedRange,
  applyEdit,
  applyUntrackedEdit,
} from "./edit.js";
import { historyUndo, historyRedo } from "./history.js";
import {
  insertionKey,
  keepSameSelection,
  moveSelectionPastEdit,
  selectionRangesWithKeys,
} from "./history-anchor.js";
import { createPoint, createAttention, deleteAttention } from "../core/attention.js";
import { declareChunkMetadata, evictChunk, loadChunk, loadChunks } from "./chunk-actions.js";

/**
 * Normalize line endings in `text` to match `lineEnding`.
 * Returns the original string unchanged if it contains no CR or LF characters
 * to avoid regex work on typical short inserts without newlines.
 */
function normalizeLineEndings(text: string, lineEnding: "lf" | "crlf" | "cr"): string {
  if (!text.includes("\r") && !text.includes("\n")) return text;
  // Collapse every CRLF and lone CR to LF in one pass (\r\n is tried before \r),
  // then convert to the requested style with a second pass when needed.
  const lf = text.replace(/\r\n|\r/g, "\n");
  switch (lineEnding) {
    case "lf":
      return lf;
    case "crlf":
      return lf.replace(/\n/g, "\r\n");
    case "cr":
      return lf.replace(/\n/g, "\r");
  }
}

function validateBoundaryPosition(state: DocumentState, position: number, what: string) {
  const clamped = validatePosition(position, state.pieceTable.totalLength);
  if (!isUtf8Boundary(state.pieceTable, clamped)) {
    throw new RangeError(`${what} (${clamped}) must be a UTF-8 code-point boundary`);
  }
  return clamped;
}

// =============================================================================
// Selection Operations
// =============================================================================

/**
 * Update selection state. A selection equal to the current one, stored keys
 * included, keeps the current object, so an editor that echoes back the
 * selection an edit already moved to does not report a second change.
 */
function setSelection(state: DocumentState, ranges: readonly SelectionRange[]): DocumentState {
  if (ranges.length === 0) {
    throw new Error("SET_SELECTION: ranges must be non-empty");
  }
  // Keep the side of an unloaded chunk each unmoved endpoint is on.
  const selection: SelectionState = Object.freeze({
    ranges: selectionRangesWithKeys(state.pieceTable, state.selection, ranges, (offset, end) =>
      validateBoundaryPosition(state, offset, `selection ${end}`),
    ),
    primaryIndex: 0,
  });
  return withState(state, { selection: keepSameSelection(state.selection, selection) });
}

// =============================================================================
// Main Reducer
// =============================================================================

/**
 * Core reducer implementation with structural sharing.
 * Handles all document actions and returns new immutable state.
 */
export function documentReducer(state: DocumentState, action: DocumentAction): DocumentState {
  switch (action.type) {
    case "INSERT": {
      const position = validateBoundaryPosition(state, action.start, "INSERT start");
      if (action.text.length === 0) return state;
      const insertText = state.metadata.normalizeInsertedLineEndings
        ? normalizeLineEndings(action.text, state.metadata.lineEnding)
        : action.text;
      return applyEdit(state, {
        kind: "insert",
        position,
        insertText,
        timestamp: action.timestamp,
        selection: action.selection,
      });
    }

    case "DELETE": {
      const { start, end, valid } = validateRange(
        action.start,
        action.end,
        state.pieceTable.totalLength,
      );
      if (!valid) return state;
      if (end - start <= 0) return state;
      validateBoundaryPosition(state, start, "DELETE start");
      validateBoundaryPosition(state, end, "DELETE end");
      return applyEdit(state, {
        kind: "delete",
        position: start,
        deleteEnd: end,
        ...readDeletedRange(state, start, end),
        timestamp: action.timestamp,
        selection: action.selection,
      });
    }

    case "REPLACE": {
      const { start, end, valid } = validateRange(
        action.start,
        action.end,
        state.pieceTable.totalLength,
      );
      if (!valid) return state;
      validateBoundaryPosition(state, start, "REPLACE start");
      validateBoundaryPosition(state, end, "REPLACE end");
      const replaceText = state.metadata.normalizeInsertedLineEndings
        ? normalizeLineEndings(action.text, state.metadata.lineEnding)
        : action.text;
      return applyEdit(state, {
        kind: "replace",
        position: start,
        deleteEnd: end,
        ...readDeletedRange(state, start, end),
        insertText: replaceText,
        timestamp: action.timestamp,
        selection: action.selection,
      });
    }

    case "SET_SELECTION": {
      return withState(setSelection(state, action.ranges), {
        revision: state.revision + 1,
        selectionRevision: state.selectionRevision + 1,
      });
    }

    case "UNDO": {
      const nextRevision = state.revision + 1;
      const newState = historyUndo(state, nextRevision);
      if (newState === state) return state; // No undo available
      return withState(newState, {
        revision: nextRevision,
      });
    }

    case "REDO": {
      const nextRevision = state.revision + 1;
      const newState = historyRedo(state, nextRevision);
      if (newState === state) return state; // No redo available
      return withState(newState, {
        revision: nextRevision,
      });
    }

    case "HISTORY_CLEAR": {
      // Clear both undo and redo stacks while preserving config
      return withState(state, {
        history: Object.freeze({
          undoStack: null,
          redoStack: null,
          limit: state.history.limit,
          coalesceTimeout: state.history.coalesceTimeout,
          evictionPolicy: state.history.evictionPolicy,
        }),
        revision: state.revision + 1,
      });
    }

    case "MARK_SAVED": {
      // Keep state and revision unchanged when the document is already clean.
      if (!state.metadata.isDirty && state.metadata.lastSaved === action.timestamp) {
        return state;
      }
      return withState(state, {
        metadata: Object.freeze({
          ...state.metadata,
          isDirty: false,
          lastSaved: action.timestamp,
        }),
        revision: state.revision + 1,
      });
    }

    case "APPLY_REMOTE": {
      // Apply remote changes from collaboration
      const nextRevision = state.revision + 1;
      let newState = state;
      let didApplyChange = false;
      // Move the local selection past each change, as a local edit does, so it
      // stays on the text it was on. A caret where a change inserts text stays
      // before it (see `moveSelectionPastEdit`).
      const moveSelection = (start: number, end: number, inserted: number) => {
        const selection = moveSelectionPastEdit(
          newState.pieceTable,
          newState.selection,
          start,
          end,
          inserted,
          true,
        );
        if (selection !== newState.selection) newState = withState(newState, { selection });
      };
      for (const change of action.changes) {
        if (change.type === "insert" && change.text.length > 0) {
          // Normalize line endings on remote inserts the same way local inserts are treated,
          // so mixed-origin edits never silently introduce a different line-ending style.
          const insertText = newState.metadata.normalizeInsertedLineEndings
            ? normalizeLineEndings(change.text, newState.metadata.lineEnding)
            : change.text;
          if (insertText.length === 0) continue;
          didApplyChange = true;
          const position = validateBoundaryPosition(
            newState,
            change.start,
            "APPLY_REMOTE insert start",
          );
          // A remote offset cannot say which side of an unloaded chunk it is
          // on. Text inserted at the local cursor goes where the cursor is, as
          // local typing would, which keeps remote text typed into a document
          // with every chunk evicted where the cursor was in the file.
          const afterChunk = insertionKey(newState.pieceTable, newState.selection, position);
          const before = newState.pieceTable.totalLength;
          newState = applyUntrackedEdit(
            newState,
            { kind: "insert", position, insertText, afterChunk },
            nextRevision,
          );
          moveSelection(position, position, newState.pieceTable.totalLength - before);
        } else if (change.type === "delete" && change.length > 0) {
          const { start, end, valid } = validateRange(
            change.start,
            byteOffset(change.start + change.length),
            newState.pieceTable.totalLength,
          );
          if (!valid || end - start <= 0) continue;
          validateBoundaryPosition(newState, start, "APPLY_REMOTE delete start");
          validateBoundaryPosition(newState, end, "APPLY_REMOTE delete end");
          didApplyChange = true;
          const deletedText = getTextRange(newState, start, end);
          newState = applyUntrackedEdit(
            newState,
            { kind: "delete", position: start, deleteEnd: end, deletedText },
            nextRevision,
          );
          moveSelection(start, end, 0);
        }
      }
      if (!didApplyChange) {
        return state;
      }
      // History positions are not rebased against remote operations, so remote
      // edits invalidate both stacks.
      const metadata = newState.metadata.isDirty
        ? newState.metadata
        : Object.freeze({
            ...newState.metadata,
            isDirty: true,
          });
      return withState(newState, {
        revision: nextRevision,
        history: Object.freeze({ ...newState.history, undoStack: null, redoStack: null }),
        metadata,
      });
    }

    case "DECLARE_CHUNK_METADATA":
      return declareChunkMetadata(state, action);

    case "LOAD_CHUNK":
      return loadChunk(state, action);

    case "LOAD_CHUNKS":
      return loadChunks(state, action);

    case "EVICT_CHUNK":
      return evictChunk(state, action);

    case "CREATE_ATTENTION": {
      const root = state.pieceTable.root;
      const startPoint = createPoint(
        root,
        validateBoundaryPosition(state, action.start, "attention start"),
      );
      const endPoint = createPoint(
        root,
        validateBoundaryPosition(state, action.end, "attention end"),
      );
      // Leave state unchanged when the tree cannot anchor a span.
      if (startPoint === null || endPoint === null) return state;
      const [newAttention] = createAttention(state.attention, startPoint, endPoint);
      // Return a new state to notify subscribers. Keep `revision` unchanged
      // because attention changes do not edit content. See docs/invariants.md.
      return withState(state, { attention: newAttention });
    }

    case "DELETE_ATTENTION": {
      const newAttention = deleteAttention(state.attention, action.id);
      if (newAttention === state.attention) return state; // Leave state unchanged for an unknown attention ID.
      return withState(state, { attention: newAttention });
    }

    default: {
      // Reject unhandled action types at compile time.
      const exhaustiveCheck: never = action;
      const unknownAction = exhaustiveCheck as unknown as { readonly type?: unknown };
      throw new TypeError(`Unknown document action type: ${String(unknownAction.type)}`);
    }
  }
}
