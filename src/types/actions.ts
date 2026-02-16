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
  /** Start position to insert at (0-based byte offset) */
  readonly start: ByteOffset;
  /** Text to insert */
  readonly text: string;
  /** Optional timestamp for deterministic history coalescing (defaults to Date.now()) */
  readonly timestamp?: number;
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
  /** Optional timestamp for deterministic history coalescing (defaults to Date.now()) */
  readonly timestamp?: number;
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
  /** Optional timestamp for deterministic history coalescing (defaults to Date.now()) */
  readonly timestamp?: number;
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
  readonly start: ByteOffset;
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
        typeof (action as InsertAction).start === 'number' &&
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
export function validateAction(
  value: unknown,
  documentLength?: number
): ActionValidationResult {
  const errors: string[] = [];

  // Basic type check
  if (typeof value !== 'object' || value === null) {
    errors.push('Action must be a non-null object');
    return { valid: false, errors };
  }

  const action = value as { type?: unknown };

  if (typeof action.type !== 'string') {
    errors.push('Action must have a string "type" property');
    return { valid: false, errors };
  }

  // Validate action structure
  switch (action.type) {
    case 'INSERT': {
      const insertAction = action as Partial<InsertAction>;
      if (typeof insertAction.start !== 'number') {
        errors.push('INSERT action requires a numeric "start" property');
      } else if (insertAction.start < 0) {
        errors.push(`INSERT start cannot be negative: ${insertAction.start}`);
      } else if (documentLength !== undefined && insertAction.start > documentLength) {
        errors.push(
          `INSERT start ${insertAction.start} exceeds document length ${documentLength}`
        );
      }
      if (typeof insertAction.text !== 'string') {
        errors.push('INSERT action requires a string "text" property');
      }
      break;
    }

    case 'DELETE': {
      const deleteAction = action as Partial<DeleteAction>;
      if (typeof deleteAction.start !== 'number') {
        errors.push('DELETE action requires a numeric "start" property');
      } else if (deleteAction.start < 0) {
        errors.push(`DELETE start cannot be negative: ${deleteAction.start}`);
      }
      if (typeof deleteAction.end !== 'number') {
        errors.push('DELETE action requires a numeric "end" property');
      } else if (deleteAction.end < 0) {
        errors.push(`DELETE end cannot be negative: ${deleteAction.end}`);
      }
      if (
        typeof deleteAction.start === 'number' &&
        typeof deleteAction.end === 'number'
      ) {
        if (deleteAction.start > deleteAction.end) {
          errors.push(
            `DELETE start (${deleteAction.start}) cannot be greater than end (${deleteAction.end})`
          );
        }
        if (documentLength !== undefined) {
          if (deleteAction.start > documentLength) {
            errors.push(
              `DELETE start ${deleteAction.start} exceeds document length ${documentLength}`
            );
          }
          if (deleteAction.end > documentLength) {
            errors.push(
              `DELETE end ${deleteAction.end} exceeds document length ${documentLength}`
            );
          }
        }
      }
      break;
    }

    case 'REPLACE': {
      const replaceAction = action as Partial<ReplaceAction>;
      if (typeof replaceAction.start !== 'number') {
        errors.push('REPLACE action requires a numeric "start" property');
      } else if (replaceAction.start < 0) {
        errors.push(`REPLACE start cannot be negative: ${replaceAction.start}`);
      }
      if (typeof replaceAction.end !== 'number') {
        errors.push('REPLACE action requires a numeric "end" property');
      } else if (replaceAction.end < 0) {
        errors.push(`REPLACE end cannot be negative: ${replaceAction.end}`);
      }
      if (typeof replaceAction.text !== 'string') {
        errors.push('REPLACE action requires a string "text" property');
      }
      if (
        typeof replaceAction.start === 'number' &&
        typeof replaceAction.end === 'number'
      ) {
        if (replaceAction.start > replaceAction.end) {
          errors.push(
            `REPLACE start (${replaceAction.start}) cannot be greater than end (${replaceAction.end})`
          );
        }
        if (documentLength !== undefined) {
          if (replaceAction.start > documentLength) {
            errors.push(
              `REPLACE start ${replaceAction.start} exceeds document length ${documentLength}`
            );
          }
          if (replaceAction.end > documentLength) {
            errors.push(
              `REPLACE end ${replaceAction.end} exceeds document length ${documentLength}`
            );
          }
        }
      }
      break;
    }

    case 'SET_SELECTION': {
      const selectionAction = action as Partial<SetSelectionAction>;
      if (!Array.isArray(selectionAction.ranges)) {
        errors.push('SET_SELECTION action requires an array "ranges" property');
      }
      break;
    }

    case 'UNDO':
    case 'REDO':
    case 'HISTORY_CLEAR':
    case 'TRANSACTION_START':
    case 'TRANSACTION_COMMIT':
    case 'TRANSACTION_ROLLBACK':
      // These actions have no additional properties to validate
      break;

    case 'APPLY_REMOTE': {
      const remoteAction = action as Partial<ApplyRemoteAction>;
      if (!Array.isArray(remoteAction.changes)) {
        errors.push('APPLY_REMOTE action requires an array "changes" property');
      }
      break;
    }

    case 'LOAD_CHUNK': {
      const loadAction = action as Partial<LoadChunkAction>;
      if (typeof loadAction.chunkIndex !== 'number') {
        errors.push('LOAD_CHUNK action requires a numeric "chunkIndex" property');
      }
      if (!(loadAction.data instanceof Uint8Array)) {
        errors.push('LOAD_CHUNK action requires a Uint8Array "data" property');
      }
      break;
    }

    case 'EVICT_CHUNK': {
      const evictAction = action as Partial<EvictChunkAction>;
      if (typeof evictAction.chunkIndex !== 'number') {
        errors.push('EVICT_CHUNK action requires a numeric "chunkIndex" property');
      }
      break;
    }

    default:
      errors.push(`Unknown action type: "${action.type}"`);
  }

  return { valid: errors.length === 0, errors };
}
