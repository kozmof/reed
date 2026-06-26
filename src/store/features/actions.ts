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

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_DECODE_TABLE = (() => {
  const table = new Uint8Array(256);
  table.fill(255);
  for (let i = 0; i < BASE64_ALPHABET.length; i++) {
    table[BASE64_ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

function encodeBase64(bytes: Uint8Array): string {
  let output = "";
  let i = 0;

  for (; i + 2 < bytes.length; i += 3) {
    const triplet = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    output +=
      BASE64_ALPHABET[(triplet >> 18) & 0x3f]! +
      BASE64_ALPHABET[(triplet >> 12) & 0x3f]! +
      BASE64_ALPHABET[(triplet >> 6) & 0x3f]! +
      BASE64_ALPHABET[triplet & 0x3f]!;
  }

  const remaining = bytes.length - i;
  if (remaining === 1) {
    const triplet = bytes[i]! << 16;
    output +=
      BASE64_ALPHABET[(triplet >> 18) & 0x3f]! + BASE64_ALPHABET[(triplet >> 12) & 0x3f]! + "==";
  } else if (remaining === 2) {
    const triplet = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    output +=
      BASE64_ALPHABET[(triplet >> 18) & 0x3f]! +
      BASE64_ALPHABET[(triplet >> 12) & 0x3f]! +
      BASE64_ALPHABET[(triplet >> 6) & 0x3f]! +
      "=";
  }

  return output;
}

function decodeBase64Char(base64: string, index: number): number {
  const code = base64.charCodeAt(index);
  return code <= 0xff ? BASE64_DECODE_TABLE[code]! : 255;
}

function decodeBase64(base64: string): Uint8Array {
  if (base64.length % 4 !== 0) {
    throw new Error("Invalid base64 payload length");
  }

  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const output = new Uint8Array((base64.length / 4) * 3 - padding);
  let offset = 0;

  for (let i = 0; i < base64.length; i += 4) {
    const c0 = decodeBase64Char(base64, i);
    const c1 = decodeBase64Char(base64, i + 1);
    const ch2 = base64[i + 2];
    const ch3 = base64[i + 3];

    if (c0 === 255 || c1 === 255) {
      throw new Error("Invalid base64 payload");
    }
    if (i < base64.length - 4 && (ch2 === "=" || ch3 === "=")) {
      throw new Error("Invalid base64 payload");
    }
    if (ch2 === "=" && ch3 !== "=") {
      throw new Error("Invalid base64 payload");
    }

    const c2 = ch2 === "=" ? 0 : decodeBase64Char(base64, i + 2);
    const c3 = ch3 === "=" ? 0 : decodeBase64Char(base64, i + 3);
    if ((ch2 !== "=" && c2 === 255) || (ch3 !== "=" && c3 === 255)) {
      throw new Error("Invalid base64 payload");
    }

    const triplet = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    output[offset++] = (triplet >> 16) & 0xff;
    if (ch2 !== "=") {
      output[offset++] = (triplet >> 8) & 0xff;
    }
    if (ch3 !== "=") {
      output[offset++] = triplet & 0xff;
    }
  }

  return output;
}

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
  insert(start: ByteOffset, text: string, selection?: readonly SelectionRange[]): InsertAction {
    const frozenSelection = freezeSelection(selection);
    return Object.freeze({
      type: "INSERT",
      start,
      text,
      ...(frozenSelection && { selection: frozenSelection }),
    });
  },

  /**
   * Create a delete action.
   * @param start - Start position of deletion (inclusive, byte offset)
   * @param end - End position of deletion (exclusive, byte offset)
   */
  delete(start: ByteOffset, end: ByteOffset, selection?: readonly SelectionRange[]): DeleteAction {
    const frozenSelection = freezeSelection(selection);
    return Object.freeze({
      type: "DELETE",
      start,
      end,
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
  ): ReplaceAction {
    const frozenSelection = freezeSelection(selection);
    return Object.freeze({
      type: "REPLACE",
      start,
      end,
      text,
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
   * Does not bump state.version and does not emit a content-change event.
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
