/**
 * Action creator functions for the Reed document editor.
 * Provides type-safe factory functions for creating document actions.
 */

import type { SelectionRange } from "../../types/state.js";
import type { ByteOffset, ReadonlyUint8Array } from "../../types/branded.js";
import type { NonEmptyReadonlyArray } from "../../types/utils.js";
import type {
  DocumentAction,
  InsertAction,
  DeleteAction,
  ReplaceAction,
  SetSelectionAction,
  UndoAction,
  RedoAction,
  HistoryClearAction,
  ApplyRemoteAction,
  RemoteChange,
  CreateAttentionAction,
  DeleteAttentionAction,
  LoadChunkAction,
  EvictChunkAction,
  DeclareChunkMetadataAction,
} from "../../types/actions.js";
import type { AttentionID } from "../../types/branded.js";
import type { ChunkMetadata } from "../../types/state.js";
import { isDocumentAction } from "../../types/actions.js";
import { asReadonlyUint8Array } from "../core/runtime-readonly.js";
import { encodeBase64, decodeBase64 } from "../core/base64.js";

function freezeSelection(
  selection: readonly SelectionRange[] | undefined,
): readonly SelectionRange[] | undefined {
  if (selection === undefined) return undefined;
  return Object.freeze(selection.map((range) => Object.freeze({ ...range })));
}

function freezeRemoteChanges(changes: readonly RemoteChange[]): readonly RemoteChange[] {
  return Object.freeze(changes.map((change) => Object.freeze({ ...change })));
}

function freezeChunkMetadata(metadata: readonly ChunkMetadata[]): readonly ChunkMetadata[] {
  return Object.freeze(metadata.map((entry) => Object.freeze({ ...entry })));
}

function withOptionalTimestamp<T extends InsertAction | DeleteAction | ReplaceAction>(
  action: T,
  timestamp: number | undefined,
): T {
  return timestamp === undefined
    ? action
    : (Object.freeze({ ...action, timestamp }) as unknown as T);
}

function normalizeDeserializedAction(action: DocumentAction): DocumentAction {
  switch (action.type) {
    case "INSERT":
      return withOptionalTimestamp(
        DocumentActions.insert(action.start, action.text, action.selection),
        action.timestamp,
      );
    case "DELETE":
      return withOptionalTimestamp(
        DocumentActions.delete(action.start, action.end, action.selection),
        action.timestamp,
      );
    case "REPLACE":
      return withOptionalTimestamp(
        DocumentActions.replace(action.start, action.end, action.text, action.selection),
        action.timestamp,
      );
    case "SET_SELECTION":
      return DocumentActions.setSelection(action.ranges);
    case "UNDO":
      return DocumentActions.undo();
    case "REDO":
      return DocumentActions.redo();
    case "HISTORY_CLEAR":
      return DocumentActions.historyClear();
    case "APPLY_REMOTE":
      return DocumentActions.applyRemote(action.changes);
    case "CREATE_ATTENTION":
      return DocumentActions.createAttention(action.start, action.end);
    case "DELETE_ATTENTION":
      return DocumentActions.deleteAttention(action.id);
    case "LOAD_CHUNK":
      return DocumentActions.loadChunk(action.chunkIndex, action.data);
    case "EVICT_CHUNK":
      return DocumentActions.evictChunk(action.chunkIndex);
    case "DECLARE_CHUNK_METADATA":
      return DocumentActions.declareChunkMetadata(action.metadata);
  }
}

/**
 * Action creators for document mutations.
 * All functions return serializable action objects.
 */
export const DocumentActions = {
  /**
   * Create an insert action.
   * @param start - Start position to insert at (0-based byte offset)
   * @param text - Text to insert
   */
  insert(
    start: ByteOffset,
    text: string,
    selection?: readonly SelectionRange[],
    timestamp: number = Date.now(),
  ): InsertAction {
    const frozenSelection = freezeSelection(selection);
    return Object.freeze({
      type: "INSERT",
      start,
      text,
      timestamp,
      ...(frozenSelection && { selection: frozenSelection }),
    });
  },

  /**
   * Create a delete action.
   * @param start - Start position of deletion (inclusive, byte offset)
   * @param end - End position of deletion (exclusive, byte offset)
   */
  delete(
    start: ByteOffset,
    end: ByteOffset,
    selection?: readonly SelectionRange[],
    timestamp: number = Date.now(),
  ): DeleteAction {
    const frozenSelection = freezeSelection(selection);
    return Object.freeze({
      type: "DELETE",
      start,
      end,
      timestamp,
      ...(frozenSelection && { selection: frozenSelection }),
    });
  },

  /**
   * Create a replace action.
   * @param start - Start position of replacement (inclusive, byte offset)
   * @param end - End position of replacement (exclusive, byte offset)
   * @param text - New text to insert
   */
  replace(
    start: ByteOffset,
    end: ByteOffset,
    text: string,
    selection?: readonly SelectionRange[],
    timestamp: number = Date.now(),
  ): ReplaceAction {
    const frozenSelection = freezeSelection(selection);
    return Object.freeze({
      type: "REPLACE",
      start,
      end,
      text,
      timestamp,
      ...(frozenSelection && { selection: frozenSelection }),
    });
  },

  /**
   * Create a set selection action.
   * @param ranges - New selection ranges
   */
  setSelection(ranges: NonEmptyReadonlyArray<SelectionRange>): SetSelectionAction {
    return Object.freeze({
      type: "SET_SELECTION",
      ranges: freezeSelection(ranges) as NonEmptyReadonlyArray<SelectionRange>,
    });
  },

  /**
   * Create an undo action.
   */
  undo(): UndoAction {
    return Object.freeze({ type: "UNDO" });
  },

  /**
   * Create a redo action.
   */
  redo(): RedoAction {
    return Object.freeze({ type: "REDO" });
  },

  /**
   * Clear all history (both undo and redo stacks).
   */
  historyClear(): HistoryClearAction {
    return Object.freeze({ type: "HISTORY_CLEAR" });
  },

  /**
   * Create a replace action for an IME composition session.
   *
   * Use this in `compositionend` when a keydown character was already inserted
   * speculatively and must be rolled back before the composed text is committed.
   * Dispatching this single action creates one history entry (type `replace`),
   * so one `u` press undoes the entire composition session.
   *
   * Typical flow:
   * ```
   * keydown('n')         → insert 'n'; record { rollbackStart, rollbackEnd }
   * compositionstart     → set isComposing = true; save rollback info; do NOT dispatch delete
   * compositionend       → dispatch insertComposed(rollbackStart, rollbackEnd, '日本語', selection)
   * ```
   *
   * If the user cancels composition (composedText is empty), this is equivalent
   * to a delete of the speculative character — still one history entry.
   *
   * @param rollbackStart - Start of the speculatively inserted character(s)
   * @param rollbackEnd   - End of the speculatively inserted character(s) (exclusive)
   * @param composedText  - Full composed text from compositionend
   * @param selection     - Optional cursor position to record as selectionBefore in history
   */
  insertComposed(
    rollbackStart: ByteOffset,
    rollbackEnd: ByteOffset,
    composedText: string,
    selection?: readonly SelectionRange[],
  ): ReplaceAction {
    return DocumentActions.replace(rollbackStart, rollbackEnd, composedText, selection);
  },

  /**
   * Create an apply remote changes action.
   * @param changes - Remote changes from collaboration
   */
  applyRemote(changes: readonly RemoteChange[]): ApplyRemoteAction {
    return Object.freeze({ type: "APPLY_REMOTE", changes: freezeRemoteChanges(changes) });
  },

  /**
   * Create an attention spanning [start, end).
   *
   * Both bounds are document byte offsets; the reducer anchors them to piece
   * boundaries against the current tree. The minted `AttentionID` is
   * deterministic (`a{attention.nextID}` of the pre-dispatch state) — read it
   * from the post-dispatch snapshot's `attention` layer.
   *
   * @param start - Start of the span (inclusive, byte offset)
   * @param end - End of the span (exclusive, byte offset)
   */
  createAttention(start: ByteOffset, end: ByteOffset): CreateAttentionAction {
    return Object.freeze({ type: "CREATE_ATTENTION", start, end });
  },

  /**
   * Remove an attention from the layer. No-op if the ID is unknown.
   * @param id - ID of the attention to remove
   */
  deleteAttention(id: AttentionID): DeleteAttentionAction {
    return Object.freeze({ type: "DELETE_ATTENTION", id });
  },

  /**
   * Create a load chunk action.
   * @param chunkIndex - Index of the chunk
   * @param data - Chunk data
   */
  loadChunk(chunkIndex: number, data: ReadonlyUint8Array): LoadChunkAction {
    return Object.freeze({
      type: "LOAD_CHUNK",
      chunkIndex,
      data: asReadonlyUint8Array(new Uint8Array(data)),
    });
  },

  /**
   * Create an evict-chunk action.
   *
   * Dispatching this action removes the chunk's pieces and backing bytes from the
   * current in-memory document. Loading it again restores the chunk in index order.
   * See {@link EvictChunkAction} for the full eviction contract.
   *
   * @param chunkIndex - Zero-based index of the chunk to evict
   */
  evictChunk(chunkIndex: number): EvictChunkAction {
    return Object.freeze({ type: "EVICT_CHUNK", chunkIndex });
  },

  /**
   * Pre-declare metadata for one or more chunks before their content is loaded.
   * Allows getLineCountFromIndex to include unloaded chunk line counts.
   * Does not increment state.revision and does not emit a content-change event.
   * @param metadata - Array of chunk metadata entries
   */
  declareChunkMetadata(metadata: readonly ChunkMetadata[]): DeclareChunkMetadataAction {
    return Object.freeze({
      type: "DECLARE_CHUNK_METADATA",
      metadata: freezeChunkMetadata(metadata),
    });
  },
};

/**
 * Serialize an action to JSON string.
 * Useful for debugging and time-travel.
 * Note: Uint8Array in LoadChunkAction is converted to base64.
 */
export function serializeAction(action: DocumentAction): string {
  if (action.type === "LOAD_CHUNK") {
    const base64 = encodeBase64(new Uint8Array(action.data));
    return JSON.stringify({ ...action, data: base64 });
  }
  return JSON.stringify(action);
}

/**
 * Deserialize an action from JSON string.
 * Useful for replaying actions from logs.
 * Note: base64 data in LOAD_CHUNK is converted back to Uint8Array.
 */
export function deserializeAction(json: string): DocumentAction {
  const parsed = JSON.parse(json);
  const decoded =
    parsed &&
    typeof parsed === "object" &&
    parsed.type === "LOAD_CHUNK" &&
    typeof parsed.data === "string"
      ? { ...parsed, data: decodeBase64(parsed.data) }
      : parsed;
  if (!isDocumentAction(decoded)) {
    throw new Error(`Invalid deserialized action: ${JSON.stringify(decoded)}`);
  }
  return normalizeDeserializedAction(decoded);
}
