/**
 * Action creator functions for the Reed document editor.
 * Provides type-safe factory functions for creating document actions.
 */

import type { SelectionRange } from '../types/state.ts';
import type { ByteOffset } from '../types/branded.ts';
import type {
  DocumentAction,
  InsertAction,
  DeleteAction,
  ReplaceAction,
  SetSelectionAction,
  UndoAction,
  RedoAction,
  HistoryClearAction,
  TransactionStartAction,
  TransactionCommitAction,
  TransactionRollbackAction,
  ApplyRemoteAction,
  RemoteChange,
  LoadChunkAction,
  EvictChunkAction,
} from '../types/actions.ts';

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
  insert(start: ByteOffset, text: string): InsertAction {
    return Object.freeze({ type: 'INSERT', start, text } as const);
  },

  /**
   * Create a delete action.
   * @param start - Start position of deletion (inclusive, byte offset)
   * @param end - End position of deletion (exclusive, byte offset)
   */
  delete(start: ByteOffset, end: ByteOffset): DeleteAction {
    return Object.freeze({ type: 'DELETE', start, end } as const);
  },

  /**
   * Create a replace action.
   * @param start - Start position of replacement (inclusive, byte offset)
   * @param end - End position of replacement (exclusive, byte offset)
   * @param text - New text to insert
   */
  replace(start: ByteOffset, end: ByteOffset, text: string): ReplaceAction {
    return Object.freeze({ type: 'REPLACE', start, end, text } as const);
  },

  /**
   * Create a set selection action.
   * @param ranges - New selection ranges
   */
  setSelection(ranges: readonly SelectionRange[]): SetSelectionAction {
    return Object.freeze({ type: 'SET_SELECTION', ranges } as const);
  },

  /**
   * Create an undo action.
   */
  undo(): UndoAction {
    return Object.freeze({ type: 'UNDO' } as const);
  },

  /**
   * Create a redo action.
   */
  redo(): RedoAction {
    return Object.freeze({ type: 'REDO' } as const);
  },

  /**
   * Clear all history (both undo and redo stacks).
   */
  historyClear(): HistoryClearAction {
    return Object.freeze({ type: 'HISTORY_CLEAR' } as const);
  },

  /**
   * Create a transaction start action.
   */
  transactionStart(): TransactionStartAction {
    return Object.freeze({ type: 'TRANSACTION_START' } as const);
  },

  /**
   * Create a transaction commit action.
   */
  transactionCommit(): TransactionCommitAction {
    return Object.freeze({ type: 'TRANSACTION_COMMIT' } as const);
  },

  /**
   * Create a transaction rollback action.
   */
  transactionRollback(): TransactionRollbackAction {
    return Object.freeze({ type: 'TRANSACTION_ROLLBACK' } as const);
  },

  /**
   * Create an apply remote changes action.
   * @param changes - Remote changes from collaboration
   */
  applyRemote(changes: readonly RemoteChange[]): ApplyRemoteAction {
    return Object.freeze({ type: 'APPLY_REMOTE', changes } as const);
  },

  /**
   * Create a load chunk action.
   * @param chunkIndex - Index of the chunk
   * @param data - Chunk data
   */
  loadChunk(chunkIndex: number, data: Uint8Array): LoadChunkAction {
    return Object.freeze({ type: 'LOAD_CHUNK', chunkIndex, data } as const);
  },

  /**
   * Create an evict chunk action.
   * @param chunkIndex - Index of the chunk to evict
   */
  evictChunk(chunkIndex: number): EvictChunkAction {
    return Object.freeze({ type: 'EVICT_CHUNK', chunkIndex } as const);
  },
} as const;

/**
 * Serialize an action to JSON string.
 * Useful for debugging and time-travel.
 * Note: Uint8Array in LoadChunkAction is converted to base64.
 */
export function serializeAction(action: DocumentAction): string {
  if (action.type === 'LOAD_CHUNK') {
    const base64 = btoa(
      String.fromCharCode(...new Uint8Array(action.data))
    );
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
  const parsed = JSON.parse(json) as DocumentAction & { data?: string };
  if (parsed.type === 'LOAD_CHUNK' && typeof parsed.data === 'string') {
    const binary = atob(parsed.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return { ...parsed, data: bytes } as LoadChunkAction;
  }
  return parsed as DocumentAction;
}
