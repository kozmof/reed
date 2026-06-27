/**
 * Document action types for the Reed document editor.
 * All document mutations are expressed as serializable actions.
 * Actions are serializable for debugging, time-travel, and collaboration.
 */

import type { SelectionRange, ChunkMetadata } from "./state.js";
import type { ByteOffset, ByteLength, ReadonlyUint8Array, AttentionID } from "./branded.js";
import type { NonEmptyReadonlyArray } from "./utils.js";
import { strEnum } from "./str-enum.js";

// =============================================================================
// Text Editing Actions
// =============================================================================

/**
 * Insert text at a position.
 */
export interface InsertAction {
  readonly type: "INSERT";
  /** Start position to insert at (0-based byte offset) */
  readonly start: ByteOffset;
  /** Text to insert */
  readonly text: string;
  /** Optional timestamp for deterministic history coalescing (defaults to Date.now()) */
  readonly timestamp?: number;
  /**
   * When provided, replaces state.selection before historyPush records selectionBefore.
   * Use this to pass the logical cursor position inline, eliminating the need for a
   * separate setSelection dispatch before every edit.
   */
  readonly selection?: readonly SelectionRange[];
}

/**
 * Delete a range of text.
 */
export interface DeleteAction {
  readonly type: "DELETE";
  /** Start position of deletion (inclusive, byte offset) */
  readonly start: ByteOffset;
  /** End position of deletion (exclusive, byte offset) */
  readonly end: ByteOffset;
  /** Optional timestamp for deterministic history coalescing (defaults to Date.now()) */
  readonly timestamp?: number;
  /**
   * When provided, replaces state.selection before historyPush records selectionBefore.
   * Use this to pass the logical cursor position inline, eliminating the need for a
   * separate setSelection dispatch before every edit.
   */
  readonly selection?: readonly SelectionRange[];
}

/**
 * Replace a range of text with new text.
 */
export interface ReplaceAction {
  readonly type: "REPLACE";
  /** Start position of replacement (inclusive, byte offset) */
  readonly start: ByteOffset;
  /** End position of replacement (exclusive, byte offset) */
  readonly end: ByteOffset;
  /** New text to insert */
  readonly text: string;
  /** Optional timestamp for deterministic history coalescing (defaults to Date.now()) */
  readonly timestamp?: number;
  /**
   * When provided, replaces state.selection before historyPush records selectionBefore.
   * Use this to pass the logical cursor position inline, eliminating the need for a
   * separate setSelection dispatch before every edit.
   */
  readonly selection?: readonly SelectionRange[];
}

// =============================================================================
// Selection Actions
// =============================================================================

/**
 * Set the selection state.
 */
export interface SetSelectionAction {
  readonly type: "SET_SELECTION";
  /** New selection ranges */
  readonly ranges: NonEmptyReadonlyArray<SelectionRange>;
}

// =============================================================================
// History Actions
// =============================================================================

/**
 * Undo the last change.
 */
export interface UndoAction {
  readonly type: "UNDO";
}

/**
 * Redo a previously undone change.
 */
export interface RedoAction {
  readonly type: "REDO";
}

/**
 * Clear all history (both undo and redo stacks).
 */
export interface HistoryClearAction {
  readonly type: "HISTORY_CLEAR";
}

// =============================================================================
// Collaboration Actions
// =============================================================================

/**
 * Remote change from collaboration (e.g., from Yjs).
 * Discriminated union on `type` — `text` is required for inserts, `length` for deletes.
 */
export type RemoteChange =
  | { readonly type: "insert"; readonly start: ByteOffset; readonly text: string }
  | { readonly type: "delete"; readonly start: ByteOffset; readonly length: ByteLength };

/**
 * Apply remote changes from collaboration.
 */
export interface ApplyRemoteAction {
  readonly type: "APPLY_REMOTE";
  /** Remote changes to apply */
  readonly changes: readonly RemoteChange[];
}

// =============================================================================
// Attention Actions
// =============================================================================

/**
 * Create an attention spanning [start, end) and add it to the layer.
 * Both bounds are document byte offsets — the reducer anchors them to piece
 * boundaries against the current tree (offsets are serializable; piece IDs are
 * process-scoped and must never appear in an action). Clamped to document
 * bounds; a span that cannot be anchored (empty tree) is a no-op.
 *
 * The minted `AttentionID` is deterministic (`a{attention.nextID}` of the
 * pre-dispatch state); read it from the post-dispatch snapshot's attention layer.
 */
export interface CreateAttentionAction {
  readonly type: "CREATE_ATTENTION";
  /** Start of the span (inclusive, byte offset) */
  readonly start: ByteOffset;
  /** End of the span (exclusive, byte offset) */
  readonly end: ByteOffset;
}

/**
 * Remove an attention from the layer. No-op if the ID is unknown.
 */
export interface DeleteAttentionAction {
  readonly type: "DELETE_ATTENTION";
  /** ID of the attention to remove */
  readonly id: AttentionID;
}

// =============================================================================
// Chunk Management Actions (for large files)
// =============================================================================

/**
 * Load a chunk of data for large files.
 */
export interface LoadChunkAction {
  readonly type: "LOAD_CHUNK";
  /** Index of the chunk */
  readonly chunkIndex: number;
  /** Chunk data (readonly — callers must not mutate the buffer after dispatch) */
  readonly data: ReadonlyUint8Array;
}

/**
 * Evict a chunk from the in-memory document, freeing its pieces and backing bytes.
 *
 * ### Eviction contract
 *
 * After a successful `EVICT_CHUNK`, the chunk's pieces and bytes are removed from
 * the current in-memory document. Offsets after the removed range shift left by the
 * chunk's byte length. Loading the chunk again reinserts it in chunk-index order.
 *
 * **Safe operations after eviction:**
 * - Reading and editing the remaining resident document.
 * - Structural queries that include pre-declared metadata for unloaded chunks.
 * - Loading the chunk again via `LOAD_CHUNK` to restore text access.
 *
 * **What callers must do before evicting:**
 * - Ensure no in-progress edit (open transaction) spans the chunk's byte range.
 * - If the document has unsaved changes in the chunk, persist them first — eviction
 *   does not write back to any backing store.
 * - Use `ChunkManager.setActiveChunks()` (from `createChunkManager`) to pin chunks
 *   that must remain resident rather than evicting them manually.
 */
export interface EvictChunkAction {
  readonly type: "EVICT_CHUNK";
  /** Index of the chunk to evict */
  readonly chunkIndex: number;
}

/**
 * Pre-declare metadata for one or more chunks before their content is loaded.
 * This lets the line index answer line-count queries for unloaded ranges.
 * Does NOT increment state.revision and does NOT emit a content-change event.
 */
export interface DeclareChunkMetadataAction {
  readonly type: "DECLARE_CHUNK_METADATA";
  /** Metadata entries to register. One entry per chunk; duplicates for already-loaded chunks are ignored. */
  readonly metadata: readonly ChunkMetadata[];
}

// =============================================================================
// Union Type
// =============================================================================

/**
 * All possible document actions.
 * This union type ensures type safety when dispatching actions.
 */
export type DocumentAction =
  | InsertAction
  | DeleteAction
  | ReplaceAction
  | SetSelectionAction
  | UndoAction
  | RedoAction
  | HistoryClearAction
  | ApplyRemoteAction
  | CreateAttentionAction
  | DeleteAttentionAction
  | LoadChunkAction
  | EvictChunkAction
  | DeclareChunkMetadataAction;

/**
 * Single source of truth for all valid action type strings.
 * `DocumentActionType` is derived from this object's keys.
 * Adding a key here automatically expands the type; both `isDocumentAction`
 * and `validateAction` switch on `DocumentActionType`, so TypeScript's
 * exhaustiveness check (never-typed default) will error at those sites if a
 * new key is added here but its case is not yet handled.
 */
export const DocumentActionTypes = strEnum([
  "INSERT",
  "DELETE",
  "REPLACE",
  "SET_SELECTION",
  "UNDO",
  "REDO",
  "HISTORY_CLEAR",
  "APPLY_REMOTE",
  "CREATE_ATTENTION",
  "DELETE_ATTENTION",
  "LOAD_CHUNK",
  "EVICT_CHUNK",
  "DECLARE_CHUNK_METADATA",
]);

/** Union of all valid action type strings, derived from DocumentActionTypes. */
export type DocumentActionType = keyof typeof DocumentActionTypes;

/**
 * The subset of actions that can produce a content-change event.
 * ContentChangeEvent.action is narrowed to this type so listeners
 * never receive a non-content action in that payload.
 */
export type ContentChangeAction = InsertAction | DeleteAction | ReplaceAction | ApplyRemoteAction;

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return isInteger(value) && value >= 0;
}

function isValidEditPosition(value: unknown): value is number {
  // Local edit positions may be outside document bounds; the reducer clamps them.
  // They still must be integral and finite so branded offset construction is safe.
  return isInteger(value);
}

function isValidTimestamp(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function isSelectionRange(value: unknown): value is SelectionRange {
  if (typeof value !== "object" || value === null) return false;
  const range = value as Partial<SelectionRange>;
  return isNonNegativeInteger(range.anchor) && isNonNegativeInteger(range.head);
}

function isSelectionRangeArray(value: unknown): value is readonly SelectionRange[] {
  return Array.isArray(value) && value.length > 0 && value.every(isSelectionRange);
}

function isOptionalSelection(value: unknown): value is readonly SelectionRange[] | undefined {
  return value === undefined || isSelectionRangeArray(value);
}

function isChunkMetadata(value: unknown): value is ChunkMetadata {
  if (typeof value !== "object" || value === null) return false;
  const metadata = value as Partial<ChunkMetadata>;
  return (
    isNonNegativeInteger(metadata.chunkIndex) &&
    isNonNegativeInteger(metadata.byteLength) &&
    isNonNegativeInteger(metadata.lineCount)
  );
}

// =============================================================================
// Action Type Guards
// =============================================================================

/**
 * Check if an action is a text editing action.
 */
export function isTextEditAction(
  action: DocumentAction,
): action is InsertAction | DeleteAction | ReplaceAction {
  return action.type === "INSERT" || action.type === "DELETE" || action.type === "REPLACE";
}

/**
 * Check if an action is a history action.
 */
export function isHistoryAction(
  action: DocumentAction,
): action is UndoAction | RedoAction | HistoryClearAction {
  return action.type === "UNDO" || action.type === "REDO" || action.type === "HISTORY_CLEAR";
}

/**
 * Check if an unknown value is a valid DocumentAction.
 * Useful for validating actions from external sources.
 */
export function isDocumentAction(value: unknown): value is DocumentAction {
  return validateAction(value).valid;
}

// =============================================================================
// Action Validation
// =============================================================================

/**
 * Result of validating an action.
 */
export interface ActionValidationResult {
  /** Whether the action is valid */
  readonly valid: boolean;
  /** Error messages if validation failed */
  readonly errors: readonly string[];
}

/**
 * Validate an action with detailed error messages.
 * Validates action shape and invariants that the reducer does not normalize away.
 *
 * Numeric edit positions may be outside `documentLength`: the reducer clamps
 * them to document bounds as part of its fail-soft input handling. The validator
 * still rejects non-integral, NaN, and infinite positions because those cannot
 * be safely converted to branded offsets.
 *
 * @example
 * ```typescript
 * const result = validateAction(action, 100); // documentLength = 100
 * if (!result.valid) {
 *   console.error('Invalid action:', result.errors);
 * }
 * ```
 *
 * @param value - Value to validate as an action
 * @param documentLength - Optional current document length; validated when provided
 * @returns Validation result with errors array
 */
export function validateAction(value: unknown, documentLength?: number): ActionValidationResult {
  const errors: string[] = [];

  if (documentLength !== undefined && !isNonNegativeInteger(documentLength)) {
    errors.push("documentLength must be a non-negative integer when provided");
  }

  // Basic type check
  if (typeof value !== "object" || value === null) {
    errors.push("Action must be a non-null object");
    return { valid: false, errors };
  }

  const action = value as { type?: unknown };

  if (typeof action.type !== "string") {
    errors.push('Action must have a string "type" property');
    return { valid: false, errors };
  }

  if (!(action.type in DocumentActionTypes)) {
    errors.push(`Unknown action type: "${action.type}"`);
    return { valid: false, errors };
  }

  const type = action.type as DocumentActionType;

  // Validate action structure
  switch (type) {
    case "INSERT": {
      const insertAction = action as Partial<InsertAction>;
      if (!isValidEditPosition(insertAction.start)) {
        errors.push('INSERT action requires an integer "start" property');
      }
      if (typeof insertAction.text !== "string") {
        errors.push('INSERT action requires a string "text" property');
      }
      if (!isValidTimestamp(insertAction.timestamp)) {
        errors.push('INSERT action "timestamp" must be a finite number when provided');
      }
      if (!isOptionalSelection(insertAction.selection)) {
        errors.push('INSERT action "selection" must be a non-empty array of selection ranges');
      }
      break;
    }

    case "DELETE": {
      const deleteAction = action as Partial<DeleteAction>;
      if (!isValidEditPosition(deleteAction.start)) {
        errors.push('DELETE action requires an integer "start" property');
      }
      if (!isValidEditPosition(deleteAction.end)) {
        errors.push('DELETE action requires an integer "end" property');
      }
      if (isValidEditPosition(deleteAction.start) && isValidEditPosition(deleteAction.end)) {
        if (deleteAction.start > deleteAction.end) {
          errors.push(
            `DELETE start (${deleteAction.start}) cannot be greater than end (${deleteAction.end})`,
          );
        }
      }
      if (!isValidTimestamp(deleteAction.timestamp)) {
        errors.push('DELETE action "timestamp" must be a finite number when provided');
      }
      if (!isOptionalSelection(deleteAction.selection)) {
        errors.push('DELETE action "selection" must be a non-empty array of selection ranges');
      }
      break;
    }

    case "REPLACE": {
      const replaceAction = action as Partial<ReplaceAction>;
      if (!isValidEditPosition(replaceAction.start)) {
        errors.push('REPLACE action requires an integer "start" property');
      }
      if (!isValidEditPosition(replaceAction.end)) {
        errors.push('REPLACE action requires an integer "end" property');
      }
      if (typeof replaceAction.text !== "string") {
        errors.push('REPLACE action requires a string "text" property');
      }
      if (isValidEditPosition(replaceAction.start) && isValidEditPosition(replaceAction.end)) {
        if (replaceAction.start > replaceAction.end) {
          errors.push(
            `REPLACE start (${replaceAction.start}) cannot be greater than end (${replaceAction.end})`,
          );
        }
      }
      if (!isValidTimestamp(replaceAction.timestamp)) {
        errors.push('REPLACE action "timestamp" must be a finite number when provided');
      }
      if (!isOptionalSelection(replaceAction.selection)) {
        errors.push('REPLACE action "selection" must be a non-empty array of selection ranges');
      }
      break;
    }

    case "SET_SELECTION": {
      const selectionAction = action as Partial<SetSelectionAction>;
      if (!isSelectionRangeArray(selectionAction.ranges)) {
        errors.push(
          'SET_SELECTION action requires a non-empty array "ranges" property with valid selection ranges',
        );
      }
      break;
    }

    case "UNDO":
    case "REDO":
    case "HISTORY_CLEAR":
      break;

    case "APPLY_REMOTE": {
      const remoteAction = action as Partial<ApplyRemoteAction>;
      if (!Array.isArray(remoteAction.changes)) {
        errors.push('APPLY_REMOTE action requires an array "changes" property');
      } else {
        for (let i = 0; i < remoteAction.changes.length; i++) {
          const c = remoteAction.changes[i] as unknown;
          if (typeof c !== "object" || c === null) {
            errors.push(`APPLY_REMOTE changes[${i}] must be an object`);
            continue;
          }
          const change = c as Partial<RemoteChange>;
          if (change.type !== "insert" && change.type !== "delete") {
            errors.push(`APPLY_REMOTE changes[${i}].type must be 'insert' or 'delete'`);
          }
          if (!isNonNegativeInteger(change.start)) {
            errors.push(`APPLY_REMOTE changes[${i}].start must be a non-negative integer`);
          }
          if (change.type === "insert" && typeof change.text !== "string") {
            errors.push(`APPLY_REMOTE changes[${i}].text must be a string for insert changes`);
          }
          if (change.type === "delete" && !isNonNegativeInteger(change.length)) {
            errors.push(
              `APPLY_REMOTE changes[${i}].length must be a non-negative integer for delete changes`,
            );
          }
        }
      }
      break;
    }

    case "CREATE_ATTENTION": {
      const createAction = action as Partial<CreateAttentionAction>;
      if (!isValidEditPosition(createAction.start)) {
        errors.push('CREATE_ATTENTION action requires an integer "start" property');
      }
      if (!isValidEditPosition(createAction.end)) {
        errors.push('CREATE_ATTENTION action requires an integer "end" property');
      }
      break;
    }

    case "DELETE_ATTENTION": {
      const deleteAction = action as Partial<DeleteAttentionAction>;
      if (typeof deleteAction.id !== "string") {
        errors.push('DELETE_ATTENTION action requires a string "id" property');
      }
      break;
    }

    case "LOAD_CHUNK": {
      const loadAction = action as Partial<LoadChunkAction>;
      if (!isNonNegativeInteger(loadAction.chunkIndex)) {
        errors.push('LOAD_CHUNK action requires a non-negative integer "chunkIndex" property');
      }
      if (!(loadAction.data instanceof Uint8Array)) {
        errors.push('LOAD_CHUNK action requires a Uint8Array "data" property');
      }
      break;
    }

    case "EVICT_CHUNK": {
      const evictAction = action as Partial<EvictChunkAction>;
      if (!isNonNegativeInteger(evictAction.chunkIndex)) {
        errors.push('EVICT_CHUNK action requires a non-negative integer "chunkIndex" property');
      }
      break;
    }

    case "DECLARE_CHUNK_METADATA": {
      const declAction = action as Partial<DeclareChunkMetadataAction>;
      if (!Array.isArray(declAction.metadata)) {
        errors.push('DECLARE_CHUNK_METADATA action requires an array "metadata" property');
      } else {
        for (let i = 0; i < declAction.metadata.length; i++) {
          const m = declAction.metadata[i] as unknown;
          if (!isChunkMetadata(m)) {
            errors.push(
              `DECLARE_CHUNK_METADATA metadata[${i}] must include non-negative integer chunkIndex, byteLength, and lineCount`,
            );
          }
        }
      }
      break;
    }

    default:
      ((_: never) => {})(type);
  }

  return { valid: errors.length === 0, errors };
}
