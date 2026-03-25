/**
 * Standalone transaction manager for the Reed document editor.
 * Extracted from store.ts for testability, reusability, and composability.
 */

import type { DocumentState } from '../../types/state.ts';

/**
 * Result of a commit operation.
 */
export interface CommitResult {
  readonly kind: 'commit';
  /** Whether this completed the outermost transaction. */
  readonly isOutermost: boolean;
}

/**
 * Result of a rollback operation.
 */
export interface RollbackResult {
  readonly kind: 'rollback';
  /** Whether this completed the outermost transaction. */
  readonly isOutermost: boolean;
  /** The snapshot to restore to. Null when depth was already 0. */
  readonly snapshot: DocumentState | null;
}

/**
 * Discriminated union of commit and rollback results.
 */
export type TransactionResult = CommitResult | RollbackResult;

/**
 * Manages nested transaction state: depth tracking and snapshot stack.
 *
 * This is a stateful coordinator — it does NOT own the document state
 * or know how to apply actions. The store provides state and interprets results.
 */
export interface TransactionManager {
  /** Start a new transaction (or nest within an existing one). */
  begin(currentState: DocumentState): void;

  /** Commit the current transaction level. */
  commit(): CommitResult;

  /**
   * Rollback the current transaction level. Returns the snapshot to restore.
   * @throws {Error} if called when no transaction is active (depth is 0).
   */
  rollback(): RollbackResult;

  /** Current nesting depth (0 = not in transaction). */
  readonly depth: number;

  /** Whether currently inside any transaction. */
  readonly isActive: boolean;

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

  function assertInvariant(op: string): void {
    if (snapshotStack.length !== depth) {
      throw new Error(
        `TransactionManager invariant violated after ${op}: ` +
        `snapshotStack.length=${snapshotStack.length}, depth=${depth}`
      );
    }
  }

  function begin(currentState: DocumentState): void {
    snapshotStack.push(currentState);
    depth++;
    assertInvariant('begin');
  }

  function commit(): CommitResult {
    if (depth <= 0) {
      return { kind: 'commit', isOutermost: false };
    }

    depth--;
    snapshotStack.pop();
    assertInvariant('commit');

    return { kind: 'commit', isOutermost: depth === 0 };
  }

  function rollback(): RollbackResult {
    if (depth <= 0) {
      throw new Error('TransactionManager: rollback() called with no active transaction (depth is already 0)');
    }

    const snapshot = snapshotStack.pop() ?? null;
    depth--;
    assertInvariant('rollback');

    return { kind: 'rollback', isOutermost: depth === 0, snapshot };
  }

  function emergencyReset(): DocumentState | null {
    const earliest = snapshotStack.length > 0 ? snapshotStack[0] : null;
    depth = 0;
    snapshotStack = [];
    return earliest;
  }

  return {
    begin,
    commit,
    rollback,
    get depth() { return depth; },
    get isActive() { return depth > 0; },
    emergencyReset,
  };
}
