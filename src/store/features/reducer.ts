/**
 * Document reducer for the Reed document editor.
 * Pure reducer function for document state transitions.
 * No side effects - produces new state from old state + action.
 *
 * The heavy lifting (edit pipeline, history push, undo/redo application) is
 * delegated to `edit.ts` and `history.ts`. This file is an orchestrator that
 * maps DocumentActions to the correct pipeline function.
 */

import type { DocumentState, SelectionRange, NonEmptyReadonlyArray } from "../../types/state.js";
import type { DocumentAction } from "../../types/actions.js";
import { byteOffset } from "../../types/branded.js";
import { withState } from "../core/state.js";
import {
  validatePosition,
  validateRange,
  getTextRange,
  applyEdit,
  applyUntrackedEdit,
} from "./edit.js";
import { historyUndo, historyRedo } from "./history.js";
import { createPoint, createAttention, deleteAttention } from "../core/attention.js";
import { declareChunkMetadata, evictChunk, loadChunk } from "./chunk-actions.js";

/**
 * Normalize line endings in `text` to match `lineEnding`.
 * Returns the original string unchanged if it contains no CR or LF characters
 * (fast path — avoids regex overhead for typical short inserts without newlines).
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

// =============================================================================
// Selection Operations
// =============================================================================

/**
 * Update selection state.
 */
function setSelection(state: DocumentState, ranges: readonly SelectionRange[]): DocumentState {
  if (ranges.length === 0) {
    throw new Error("SET_SELECTION: ranges must be non-empty");
  }
  return withState(state, {
    selection: Object.freeze({
      ranges: Object.freeze(
        ranges.map((r) =>
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
      const position = validatePosition(action.start, state.pieceTable.totalLength);
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
      const deletedText = getTextRange(state, start, end);
      return applyEdit(state, {
        kind: "delete",
        position: start,
        deleteEnd: end,
        deletedText,
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
      const oldText = getTextRange(state, start, end);
      const replaceText = state.metadata.normalizeInsertedLineEndings
        ? normalizeLineEndings(action.text, state.metadata.lineEnding)
        : action.text;
      return applyEdit(state, {
        kind: "replace",
        position: start,
        deleteEnd: end,
        deletedText: oldText,
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
        }),
        revision: state.revision + 1,
      });
    }

    case "APPLY_REMOTE": {
      // Apply remote changes from collaboration
      const nextRevision = state.revision + 1;
      let newState = state;
      let didApplyChange = false;
      for (const change of action.changes) {
        if (change.type === "insert" && change.text.length > 0) {
          // Normalize line endings on remote inserts the same way local inserts are treated,
          // so mixed-origin edits never silently introduce a different line-ending style.
          const insertText = newState.metadata.normalizeInsertedLineEndings
            ? normalizeLineEndings(change.text, newState.metadata.lineEnding)
            : change.text;
          if (insertText.length === 0) continue;
          didApplyChange = true;
          const position = validatePosition(change.start, newState.pieceTable.totalLength);
          newState = applyUntrackedEdit(
            newState,
            { kind: "insert", position, insertText },
            nextRevision,
          );
        } else if (change.type === "delete" && change.length > 0) {
          const { start, end, valid } = validateRange(
            change.start,
            byteOffset(change.start + change.length),
            newState.pieceTable.totalLength,
          );
          if (!valid || end - start <= 0) continue;
          didApplyChange = true;
          const deletedText = getTextRange(newState, start, end);
          newState = applyUntrackedEdit(
            newState,
            { kind: "delete", position: start, deleteEnd: end, deletedText },
            nextRevision,
          );
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
        revision: nextRevision,
        metadata,
      });
    }

    case "DECLARE_CHUNK_METADATA":
      return declareChunkMetadata(state, action);

    case "LOAD_CHUNK":
      return loadChunk(state, action);

    case "EVICT_CHUNK":
      return evictChunk(state, action);

    case "CREATE_ATTENTION": {
      const total = state.pieceTable.totalLength;
      const root = state.pieceTable.root;
      const startPoint = createPoint(root, validatePosition(action.start, total));
      const endPoint = createPoint(root, validatePosition(action.end, total));
      // Cannot anchor against an empty tree (or otherwise) — no-op.
      if (startPoint === null || endPoint === null) return state;
      const [newAttention] = createAttention(state.attention, startPoint, endPoint);
      // Attention changes are content-neutral: a new state reference (so
      // subscribers fire) but MUST NOT increment `revision`, so they are never
      // misread as content edits (mirrors reconciliation). See docs/invariants.md.
      return withState(state, { attention: newAttention });
    }

    case "DELETE_ATTENTION": {
      const newAttention = deleteAttention(state.attention, action.id);
      if (newAttention === state.attention) return state; // unknown ID — no-op
      return withState(state, { attention: newAttention });
    }

    default: {
      // Exhaustive check - TypeScript will error if we miss an action type
      const exhaustiveCheck: never = action;
      const unknownAction = exhaustiveCheck as unknown as { readonly type?: unknown };
      throw new TypeError(`Unknown document action type: ${String(unknownAction.type)}`);
    }
  }
}
