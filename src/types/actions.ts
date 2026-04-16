/**
 * Document action types for the Reed document editor.
 * All document mutations are expressed as serializable actions.
 * Actions are serializable for debugging, time-travel, and collaboration.
 */

import type { SelectionRange, ChunkMetadata } from "./state.ts";
import type { ByteOffset, ByteLength, ReadonlyUint8Array } from "./branded.ts";
import { strEnum } from "./str-enum.ts";

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
  readonly ranges: readonly SelectionRange[];
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
// Transaction Actions
// =============================================================================

/**
 * Start a transaction (batched notification boundary).
 * Actions still apply immediately and record history per action.
 */
export interface TransactionStartAction {
  readonly type: "TRANSACTION_START";
}

/**
 * Commit a transaction.
 * Notifies listeners when the outermost transaction completes.
 */
export interface TransactionCommitAction {
  readonly type: "TRANSACTION_COMMIT";
}

/**
 * Rollback a transaction.
 * Discards all changes since TRANSACTION_START.
 */
export interface TransactionRollbackAction {
  readonly type: "TRANSACTION_ROLLBACK";
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
 * Evict a chunk from memory, freeing its text from the piece-table add-buffer.
 *
 * ### Eviction contract
 *
 * After dispatching `EVICT_CHUNK`, the evicted chunk's text is no longer accessible:
 * - Calling `getBuffer()` for any piece that references the evicted chunk will throw
 *   `'Chunk N is not loaded'` at runtime.
 * - Read operations that span the evicted byte range (e.g. `getText`, `getLineText`)
 *   will also throw.
 *
 * **Safe operations after eviction:**
 * - Structural queries that rely only on the line index or piece-table metadata
 *   (`getLineCount`, `getLineStart`, `getByteLength`, `getSelection`).
 * - Inserting or deleting text that does not touch the evicted range.
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
 * Does NOT bump state.version and does NOT emit a content-change event.
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
  | TransactionStartAction
  | TransactionCommitAction
  | TransactionRollbackAction
  | ApplyRemoteAction
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
  "TRANSACTION_START",
  "TRANSACTION_COMMIT",
  "TRANSACTION_ROLLBACK",
  "APPLY_REMOTE",
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
 * Check if an action is a transaction action.
 */
export function isTransactionAction(
  action: DocumentAction,
): action is TransactionStartAction | TransactionCommitAction | TransactionRollbackAction {
  return (
    action.type === "TRANSACTION_START" ||
    action.type === "TRANSACTION_COMMIT" ||
    action.type === "TRANSACTION_ROLLBACK"
  );
}

/**
 * Check if an unknown value is a valid DocumentAction.
 * Useful for validating actions from external sources.
 */
export function isDocumentAction(value: unknown): value is DocumentAction {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const action = value as { type?: unknown };

  if (typeof action.type !== "string" || !(action.type in DocumentActionTypes)) {
    return false;
  }

  const type = action.type as DocumentActionType;

  switch (type) {
    case "INSERT":
      return (
        typeof (action as InsertAction).start === "number" &&
        typeof (action as InsertAction).text === "string"
      );
    case "DELETE":
      return (
        typeof (action as DeleteAction).start === "number" &&
        typeof (action as DeleteAction).end === "number"
      );
    case "REPLACE":
      return (
        typeof (action as ReplaceAction).start === "number" &&
        typeof (action as ReplaceAction).end === "number" &&
        typeof (action as ReplaceAction).text === "string"
      );
    case "SET_SELECTION":
      return Array.isArray((action as SetSelectionAction).ranges);
    case "UNDO":
    case "REDO":
    case "HISTORY_CLEAR":
    case "TRANSACTION_START":
    case "TRANSACTION_COMMIT":
    case "TRANSACTION_ROLLBACK":
      return true;
    case "APPLY_REMOTE": {
      const remote = action as ApplyRemoteAction;
      if (!Array.isArray(remote.changes)) return false;
      return remote.changes.every(
        (c) =>
          (c.type === "insert" || c.type === "delete") &&
          typeof c.start === "number" &&
          (c.type !== "insert" || typeof c.text === "string") &&
          (c.type !== "delete" || typeof c.length === "number"),
      );
    }
    case "LOAD_CHUNK":
      return (
        typeof (action as LoadChunkAction).chunkIndex === "number" &&
        (action as LoadChunkAction).data instanceof Uint8Array
      );
    case "EVICT_CHUNK":
      return typeof (action as EvictChunkAction).chunkIndex === "number";
    case "DECLARE_CHUNK_METADATA": {
      const decl = action as DeclareChunkMetadataAction;
      if (!Array.isArray(decl.metadata)) return false;
      return decl.metadata.every(
        (m) =>
          typeof m.chunkIndex === "number" &&
          typeof m.byteLength === "number" &&
          typeof m.lineCount === "number",
      );
    }
    default:
      return ((_: never) => false)(type);
  }
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
 * Optionally validates position bounds against document length.
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
 * @param documentLength - Optional document length for bounds checking
 * @returns Validation result with errors array
 */
export function validateAction(value: unknown, documentLength?: number): ActionValidationResult {
  const errors: string[] = [];

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
      if (typeof insertAction.start !== "number") {
        errors.push('INSERT action requires a numeric "start" property');
      } else if (insertAction.start < 0) {
        errors.push(`INSERT start cannot be negative: ${insertAction.start}`);
      } else if (documentLength !== undefined && insertAction.start > documentLength) {
        errors.push(`INSERT start ${insertAction.start} exceeds document length ${documentLength}`);
      }
      if (typeof insertAction.text !== "string") {
        errors.push('INSERT action requires a string "text" property');
      }
      break;
    }

    case "DELETE": {
      const deleteAction = action as Partial<DeleteAction>;
      if (typeof deleteAction.start !== "number") {
        errors.push('DELETE action requires a numeric "start" property');
      } else if (deleteAction.start < 0) {
        errors.push(`DELETE start cannot be negative: ${deleteAction.start}`);
      }
      if (typeof deleteAction.end !== "number") {
        errors.push('DELETE action requires a numeric "end" property');
      } else if (deleteAction.end < 0) {
        errors.push(`DELETE end cannot be negative: ${deleteAction.end}`);
      }
      if (typeof deleteAction.start === "number" && typeof deleteAction.end === "number") {
        if (deleteAction.start > deleteAction.end) {
          errors.push(
            `DELETE start (${deleteAction.start}) cannot be greater than end (${deleteAction.end})`,
          );
        }
        if (documentLength !== undefined) {
          if (deleteAction.start > documentLength) {
            errors.push(
              `DELETE start ${deleteAction.start} exceeds document length ${documentLength}`,
            );
          }
          if (deleteAction.end > documentLength) {
            errors.push(`DELETE end ${deleteAction.end} exceeds document length ${documentLength}`);
          }
        }
      }
      break;
    }

    case "REPLACE": {
      const replaceAction = action as Partial<ReplaceAction>;
      if (typeof replaceAction.start !== "number") {
        errors.push('REPLACE action requires a numeric "start" property');
      } else if (replaceAction.start < 0) {
        errors.push(`REPLACE start cannot be negative: ${replaceAction.start}`);
      }
      if (typeof replaceAction.end !== "number") {
        errors.push('REPLACE action requires a numeric "end" property');
      } else if (replaceAction.end < 0) {
        errors.push(`REPLACE end cannot be negative: ${replaceAction.end}`);
      }
      if (typeof replaceAction.text !== "string") {
        errors.push('REPLACE action requires a string "text" property');
      }
      if (typeof replaceAction.start === "number" && typeof replaceAction.end === "number") {
        if (replaceAction.start > replaceAction.end) {
          errors.push(
            `REPLACE start (${replaceAction.start}) cannot be greater than end (${replaceAction.end})`,
          );
        }
        if (documentLength !== undefined) {
          if (replaceAction.start > documentLength) {
            errors.push(
              `REPLACE start ${replaceAction.start} exceeds document length ${documentLength}`,
            );
          }
          if (replaceAction.end > documentLength) {
            errors.push(
              `REPLACE end ${replaceAction.end} exceeds document length ${documentLength}`,
            );
          }
        }
      }
      break;
    }

    case "SET_SELECTION": {
      const selectionAction = action as Partial<SetSelectionAction>;
      if (!Array.isArray(selectionAction.ranges)) {
        errors.push('SET_SELECTION action requires an array "ranges" property');
      }
      break;
    }

    case "UNDO":
    case "REDO":
    case "HISTORY_CLEAR":
    case "TRANSACTION_START":
    case "TRANSACTION_COMMIT":
    case "TRANSACTION_ROLLBACK":
      // These actions have no additional properties to validate
      break;

    case "APPLY_REMOTE": {
      const remoteAction = action as Partial<ApplyRemoteAction>;
      if (!Array.isArray(remoteAction.changes)) {
        errors.push('APPLY_REMOTE action requires an array "changes" property');
      } else {
        for (let i = 0; i < remoteAction.changes.length; i++) {
          const c = remoteAction.changes[i] as Partial<RemoteChange>;
          if (c.type !== "insert" && c.type !== "delete") {
            errors.push(`APPLY_REMOTE changes[${i}].type must be 'insert' or 'delete'`);
          }
          if (typeof c.start !== "number") {
            errors.push(`APPLY_REMOTE changes[${i}].start must be a number`);
          }
          if (c.type === "insert" && typeof c.text !== "string") {
            errors.push(`APPLY_REMOTE changes[${i}].text must be a string for insert changes`);
          }
          if (c.type === "delete" && typeof c.length !== "number") {
            errors.push(`APPLY_REMOTE changes[${i}].length must be a number for delete changes`);
          }
        }
      }
      break;
    }

    case "LOAD_CHUNK": {
      const loadAction = action as Partial<LoadChunkAction>;
      if (typeof loadAction.chunkIndex !== "number") {
        errors.push('LOAD_CHUNK action requires a numeric "chunkIndex" property');
      }
      if (!(loadAction.data instanceof Uint8Array)) {
        errors.push('LOAD_CHUNK action requires a Uint8Array "data" property');
      }
      break;
    }

    case "EVICT_CHUNK": {
      const evictAction = action as Partial<EvictChunkAction>;
      if (typeof evictAction.chunkIndex !== "number") {
        errors.push('EVICT_CHUNK action requires a numeric "chunkIndex" property');
      }
      break;
    }

    case "DECLARE_CHUNK_METADATA": {
      const declAction = action as Partial<DeclareChunkMetadataAction>;
      if (!Array.isArray(declAction.metadata)) {
        errors.push('DECLARE_CHUNK_METADATA action requires an array "metadata" property');
      } else {
        for (let i = 0; i < declAction.metadata.length; i++) {
          const m = declAction.metadata[i] as Partial<ChunkMetadata>;
          if (typeof m.chunkIndex !== "number") {
            errors.push(`DECLARE_CHUNK_METADATA metadata[${i}].chunkIndex must be a number`);
          }
          if (typeof m.byteLength !== "number") {
            errors.push(`DECLARE_CHUNK_METADATA metadata[${i}].byteLength must be a number`);
          }
          if (typeof m.lineCount !== "number") {
            errors.push(`DECLARE_CHUNK_METADATA metadata[${i}].lineCount must be a number`);
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
