/**
 * Apply document actions as pure state transitions.
 *
 * Route text edits to `edit.ts` and undo/redo to `history.ts`.
 */

import type { DocumentState, HistoryState, SelectionRange } from "../../types/state.js";
import type { DocumentAction } from "../../types/actions.js";
import { byteOffset } from "../../types/branded.js";
import { withState } from "../core/state.js";
import { getText, isUtf8Boundary } from "../core/piece-table.js";
import { validatePosition, validateRange, applyEdit, applyUntrackedEdit } from "./edit.js";
import { getRedoCount, getUndoCount, historyUndo, historyRedo } from "./history.js";
import {
  RemoteBatchSelection,
  selectionFromRanges,
  selectionRangesWithKeys,
} from "./history-anchor.js";
import { createPoint, createAttention, deleteAttention } from "../core/attention.js";
import {
  declareChunkMetadata,
  evictChunk,
  evictChunks,
  loadChunk,
  loadChunks,
} from "./chunk-actions.js";

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
 * Apply SET_SELECTION. Ranges equal to the current selection, stored keys
 * included, return `state` itself, so neither revision moves and no listener
 * or event fires. An editor that echoes back the selection an edit already
 * moved to does not report a second change.
 */
function setSelection(state: DocumentState, ranges: readonly SelectionRange[]): DocumentState {
  if (ranges.length === 0) {
    throw new Error("SET_SELECTION: ranges must be non-empty");
  }
  // Keep the side of an unloaded chunk each unmoved endpoint is on.
  const next = selectionFromRanges(
    state.selection,
    selectionRangesWithKeys(state.pieceTable, state.selection, ranges, (offset, end) =>
      validateBoundaryPosition(state, offset, `selection ${end}`),
    ),
  );
  if (next === state.selection) return state;
  return withState(state, {
    selection: next,
    revision: state.revision + 1,
    selectionRevision: state.selectionRevision + 1,
  });
}

// =============================================================================
// Main Reducer
// =============================================================================

/** Undo and redo entries an action discarded without undoing or redoing them. */
export interface HistoryLoss {
  readonly undo: number;
  readonly redo: number;
}

/**
 * A state transition, and the history it discarded without undoing or
 * redoing it, or null. That is history an eviction discarded with the chunks
 * its entries point into, the stale entries an UNDO or REDO dropped instead of
 * replaying one, and the stacks APPLY_REMOTE and HISTORY_CLEAR cleared. The
 * event layer reports it as `history-drop`, and the store warns of the history
 * an EVICT_CHUNKS discarded. An entry that changes no bytes leaves the
 * document as a drop does, so the outcome comes from the step rather than from
 * the states.
 */
export interface DocumentTransition {
  readonly state: DocumentState;
  readonly historyDropped: HistoryLoss | null;
}

/** The entries `to` lacks that `from` had, or null when it lacks none. */
function historyLoss(from: HistoryState, to: HistoryState): HistoryLoss | null {
  if (from === to) return null;
  const undo = Math.max(0, getUndoCount(from) - getUndoCount(to));
  const redo = Math.max(0, getRedoCount(from) - getRedoCount(to));
  return undo === 0 && redo === 0 ? null : { undo, redo };
}

/**
 * Apply UNDO or REDO. Dropping a stale entry changes only history, but still
 * moves the revision, as HISTORY_CLEAR does, so code keyed on it sees the drop.
 */
function stepHistory(state: DocumentState, type: "UNDO" | "REDO"): DocumentTransition {
  const nextRevision = state.revision + 1;
  const step =
    type === "UNDO" ? historyUndo(state, nextRevision) : historyRedo(state, nextRevision);
  if (step.outcome === "empty") return { state, historyDropped: null };
  return {
    state: withState(step.state, { revision: nextRevision }),
    historyDropped:
      step.outcome === "dropped" ? historyLoss(state.history, step.state.history) : null,
  };
}

/**
 * Apply `action` as `documentReducer` does, and say what history it discarded
 * (see `DocumentTransition`).
 */
export function reduceDocument(state: DocumentState, action: DocumentAction): DocumentTransition {
  switch (action.type) {
    case "UNDO":
    case "REDO":
      return stepHistory(state, action.type);
    case "EVICT_CHUNK":
    case "EVICT_CHUNKS":
    case "APPLY_REMOTE":
    case "HISTORY_CLEAR": {
      const next = documentReducer(state, action);
      return { state: next, historyDropped: historyLoss(state.history, next.history) };
    }
    default:
      // An edit clears redo and can trim the oldest undo entry at the limit:
      // that is how editing works, not history lost to something else.
      return { state: documentReducer(state, action), historyDropped: null };
  }
}

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
        insertText: replaceText,
        timestamp: action.timestamp,
        selection: action.selection,
      });
    }

    case "SET_SELECTION":
      return setSelection(state, action.ranges);

    case "UNDO":
    case "REDO":
      return stepHistory(state, action.type).state;

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
      // before it (see `moveSelectionPastEdit`). The batch carries the
      // selection across its changes, so a change costs only the ranges next
      // to it (see `RemoteBatchSelection`).
      const selection = new RemoteBatchSelection(state.selection);
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
          const afterChunk = selection.insertionKey(newState.pieceTable, position);
          const before = newState.pieceTable.totalLength;
          newState = applyUntrackedEdit(
            newState,
            {
              kind: "insert",
              position,
              insertText,
              placement: { kind: "fitted", key: afterChunk },
            },
            nextRevision,
          );
          selection.applyEdit(
            newState.pieceTable,
            position,
            position,
            newState.pieceTable.totalLength - before,
          );
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
          // Untracked edits keep no history, so only the text is needed. It
          // keeps a leading U+FEFF, which the line index counts.
          const deletedText = getText(newState.pieceTable, start, end);
          newState = applyUntrackedEdit(
            newState,
            { kind: "delete", position: start, deleteEnd: end, deletedText },
            nextRevision,
          );
          selection.applyEdit(newState.pieceTable, start, end, 0);
        }
      }
      if (!didApplyChange) {
        return state;
      }
      const selectionAfter = selection.selection();
      if (selectionAfter !== newState.selection) {
        newState = withState(newState, { selection: selectionAfter });
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

    case "EVICT_CHUNKS":
      return evictChunks(state, action);

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
