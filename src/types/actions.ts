/**
 * Document action types for the Reed document editor.
 * All document mutations are expressed as serializable actions.
 * Actions are serializable for debugging, time-travel, and collaboration.
 */

import type { SelectionRange } from './state.ts';
import type { ByteOffset } from './branded.ts';

// =============================================================================
// Text Editing Actions
// =============================================================================

/**
 * Insert text at a position.
 */
export interface InsertAction {
  readonly type: 'INSERT';
  /** Position to insert at (0-based byte offset) */
  readonly position: ByteOffset;
  /** Text to insert */
  readonly text: string;
}

/**
 * Delete a range of text.
 */
export interface DeleteAction {
  readonly type: 'DELETE';
  /** Start position of deletion (inclusive, byte offset) */
  readonly start: ByteOffset;
  /** End position of deletion (exclusive, byte offset) */
  readonly end: ByteOffset;
}

/**
 * Replace a range of text with new text.
 */
export interface ReplaceAction {
  readonly type: 'REPLACE';
  /** Start position of replacement (inclusive, byte offset) */
  readonly start: ByteOffset;
  /** End position of replacement (exclusive, byte offset) */
  readonly end: ByteOffset;
  /** New text to insert */
  readonly text: string;
}

// =============================================================================
// Selection Actions
// =============================================================================

/**
 * Set the selection state.
 */
export interface SetSelectionAction {
  readonly type: 'SET_SELECTION';
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
  readonly type: 'UNDO';
}

/**
 * Redo a previously undone change.
 */
export interface RedoAction {
  readonly type: 'REDO';
}

/**
 * Clear all history (both undo and redo stacks).
 */
export interface HistoryClearAction {
  readonly type: 'HISTORY_CLEAR';
}

// =============================================================================
// Transaction Actions
// =============================================================================

/**
 * Start a transaction (batched changes).
 * Changes within a transaction form a single undo unit.
 */
export interface TransactionStartAction {
  readonly type: 'TRANSACTION_START';
}

/**
 * Commit a transaction.
 * Notifies listeners and finalizes the undo entry.
 */
export interface TransactionCommitAction {
  readonly type: 'TRANSACTION_COMMIT';
}

/**
 * Rollback a transaction.
 * Discards all changes since TRANSACTION_START.
 */
export interface TransactionRollbackAction {
  readonly type: 'TRANSACTION_ROLLBACK';
}

// =============================================================================
// Collaboration Actions
// =============================================================================

/**
 * Remote change from collaboration (e.g., from Yjs).
 */
export interface RemoteChange {
  readonly type: 'insert' | 'delete';
  readonly position: ByteOffset;
  readonly text?: string;
  readonly length?: number;
}

/**
 * Apply remote changes from collaboration.
 */
export interface ApplyRemoteAction {
  readonly type: 'APPLY_REMOTE';
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
  readonly type: 'LOAD_CHUNK';
  /** Index of the chunk */
  readonly chunkIndex: number;
  /** Chunk data */
  readonly data: Uint8Array;
}

/**
 * Evict a chunk from memory.
 */
export interface EvictChunkAction {
  readonly type: 'EVICT_CHUNK';
  /** Index of the chunk to evict */
  readonly chunkIndex: number;
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
  | EvictChunkAction;

/**
 * Extract the action type string from an action.
 */
export type DocumentActionType = DocumentAction['type'];

// =============================================================================
// Action Type Guards
// =============================================================================

/**
 * Check if an action is a text editing action.
 */
export function isTextEditAction(
  action: DocumentAction
): action is InsertAction | DeleteAction | ReplaceAction {
  return (
    action.type === 'INSERT' ||
    action.type === 'DELETE' ||
    action.type === 'REPLACE'
  );
}

/**
 * Check if an action is a history action.
 */
export function isHistoryAction(
  action: DocumentAction
): action is UndoAction | RedoAction | HistoryClearAction {
  return action.type === 'UNDO' || action.type === 'REDO' || action.type === 'HISTORY_CLEAR';
}

/**
 * Check if an action is a transaction action.
 */
export function isTransactionAction(
  action: DocumentAction
): action is
  | TransactionStartAction
  | TransactionCommitAction
  | TransactionRollbackAction {
  return (
    action.type === 'TRANSACTION_START' ||
    action.type === 'TRANSACTION_COMMIT' ||
    action.type === 'TRANSACTION_ROLLBACK'
  );
}

/**
 * Check if an unknown value is a valid DocumentAction.
 * Useful for validating actions from external sources.
 */
export function isDocumentAction(value: unknown): value is DocumentAction {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const action = value as { type?: unknown };

  switch (action.type) {
    case 'INSERT':
      return (
        typeof (action as InsertAction).position === 'number' &&
        typeof (action as InsertAction).text === 'string'
      );
    case 'DELETE':
      return (
        typeof (action as DeleteAction).start === 'number' &&
        typeof (action as DeleteAction).end === 'number'
      );
    case 'REPLACE':
      return (
        typeof (action as ReplaceAction).start === 'number' &&
        typeof (action as ReplaceAction).end === 'number' &&
        typeof (action as ReplaceAction).text === 'string'
      );
    case 'SET_SELECTION':
      return Array.isArray((action as SetSelectionAction).ranges);
    case 'UNDO':
    case 'REDO':
    case 'TRANSACTION_START':
    case 'TRANSACTION_COMMIT':
    case 'TRANSACTION_ROLLBACK':
      return true;
    case 'APPLY_REMOTE':
      return Array.isArray((action as ApplyRemoteAction).changes);
    case 'LOAD_CHUNK':
      return (
        typeof (action as LoadChunkAction).chunkIndex === 'number' &&
        (action as LoadChunkAction).data instanceof Uint8Array
      );
    case 'EVICT_CHUNK':
      return typeof (action as EvictChunkAction).chunkIndex === 'number';
    default:
      return false;
  }
}
