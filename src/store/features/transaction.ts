/**
 * Standalone transaction manager for the Reed document editor.
 * Extracted from store.ts for testability, reusability, and composability.
 */

import type { DocumentState } from '../../types/state.ts';
import type { DocumentAction } from '../../types/actions.ts';

/**
 * Result of a commit or rollback operation.
 */
export interface TransactionResult {
  /** Whether this completed the outermost transaction. */
  readonly isOutermost: boolean;
  /** For rollback: the snapshot to restore to. Null for commit or when no snapshot exists. */
  readonly snapshot: DocumentState | null;
  /** For outermost commit: the accumulated pending actions. Empty otherwise. */
  readonly pendingActions: readonly DocumentAction[];
}

/**
 * Manages nested transaction state: depth tracking, snapshot stack,
 * and pending action accumulation.
 *
 * This is a stateful coordinator — it does NOT own the document state
 * or know how to apply actions. The store provides state and interprets results.
 */
export interface TransactionManager {
  /** Start a new transaction (or nest within an existing one). */
  begin(currentState: DocumentState): void;

  /** Commit the current transaction level. */
  commit(): TransactionResult;

  /** Rollback the current transaction level. Returns the snapshot to restore. */
  rollback(): TransactionResult;

  /** Track an action dispatched during a transaction. */
  trackAction(action: DocumentAction): void;

  /** Current nesting depth (0 = not in transaction). */
  readonly depth: number;

  /** Whether currently inside any transaction. */
  readonly isActive: boolean;

  /** Pending actions accumulated in the current outermost transaction. */
  readonly pendingActions: readonly DocumentAction[];

  /**
   * Emergency reset: clears all transaction state and returns the
   * earliest snapshot (outermost), or null if no snapshots exist.
   * Used when rollback itself fails.
   */
  emergencyReset(): DocumentState | null;
}

/**
 * Factory function to create a TransactionManager.
 * Uses closure-based encapsulation consistent with the codebase pattern.
 */
export function createTransactionManager(): TransactionManager {
  let depth = 0;
  let snapshotStack: DocumentState[] = [];
  let pending: DocumentAction[] = [];

  function begin(currentState: DocumentState): void {
    snapshotStack.push(currentState);
    if (depth === 0) {
      pending = [];
    }
    depth++;
  }

  function commit(): TransactionResult {
    if (depth <= 0) {
      return { isOutermost: false, snapshot: null, pendingActions: [] };
    }

    depth--;
    snapshotStack.pop();

    if (depth === 0) {
      const result = pending;
      pending = [];
      return { isOutermost: true, snapshot: null, pendingActions: result };
    }

    return { isOutermost: false, snapshot: null, pendingActions: [] };
  }

  function rollback(): TransactionResult {
    if (depth <= 0) {
      return { isOutermost: false, snapshot: null, pendingActions: [] };
    }

    const snapshot = snapshotStack.pop() ?? null;
    depth--;

    const isOutermost = depth === 0;
    if (isOutermost) {
      pending = [];
    }

    return {
      isOutermost,
      snapshot,
      pendingActions: [],
    };
  }

  function trackAction(action: DocumentAction): void {
    pending.push(action);
  }

  function emergencyReset(): DocumentState | null {
    const earliest = snapshotStack.length > 0 ? snapshotStack[0] : null;
    depth = 0;
    snapshotStack = [];
    pending = [];
    return earliest;
  }

  return {
    begin,
    commit,
    rollback,
    trackAction,
    get depth() { return depth; },
    get isActive() { return depth > 0; },
    get pendingActions() { return pending; },
    emergencyReset,
  };
}
