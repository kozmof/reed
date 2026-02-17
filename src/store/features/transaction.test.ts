/**
 * Tests for the standalone TransactionManager.
 * Verifies depth tracking, snapshot stack, pending actions, and emergency reset
 * in isolation — without any store, reducer, or listener involvement.
 */

import { describe, it, expect } from 'vitest';
import { createTransactionManager } from './transaction.ts';
import { createInitialState } from './../core/state.ts';
import { documentReducer } from './reducer.ts';
import { DocumentActions } from './actions.ts';
import { byteOffset } from '../../types/branded.ts';
import type { DocumentState } from '../../types/state.ts';

// Helper: create distinct states for snapshot testing
function makeState(content: string = ''): DocumentState {
  return createInitialState({ content });
}

function applyInsert(state: DocumentState, pos: number, text: string): DocumentState {
  return documentReducer(state, DocumentActions.insert(byteOffset(pos), text));
}

// =============================================================================
// Basic Lifecycle
// =============================================================================

describe('TransactionManager', () => {
  describe('basic lifecycle', () => {
    it('should start with depth 0 and isActive false', () => {
      const tm = createTransactionManager();
      expect(tm.depth).toBe(0);
      expect(tm.isActive).toBe(false);
      expect(tm.pendingActions).toEqual([]);
    });

    it('begin() should increment depth and set isActive true', () => {
      const tm = createTransactionManager();
      const state = makeState();
      tm.begin(state);
      expect(tm.depth).toBe(1);
      expect(tm.isActive).toBe(true);
    });

    it('commit() after begin() should return isOutermost true and decrement depth', () => {
      const tm = createTransactionManager();
      tm.begin(makeState());
      const result = tm.commit();
      expect(result.isOutermost).toBe(true);
      expect(result.snapshot).toBeNull();
      expect(tm.depth).toBe(0);
      expect(tm.isActive).toBe(false);
    });

    it('commit() when depth is 0 should be a no-op', () => {
      const tm = createTransactionManager();
      const result = tm.commit();
      expect(result.isOutermost).toBe(false);
      expect(result.snapshot).toBeNull();
      expect(result.pendingActions).toEqual([]);
      expect(tm.depth).toBe(0);
    });

    it('rollback() after begin() should return the snapshot passed to begin()', () => {
      const tm = createTransactionManager();
      const state = makeState('hello');
      tm.begin(state);
      const result = tm.rollback();
      expect(result.snapshot).toBe(state);
      expect(tm.depth).toBe(0);
      expect(tm.isActive).toBe(false);
    });

    it('rollback() when depth is 0 should be a no-op', () => {
      const tm = createTransactionManager();
      const result = tm.rollback();
      expect(result.isOutermost).toBe(false);
      expect(result.snapshot).toBeNull();
      expect(result.pendingActions).toEqual([]);
      expect(tm.depth).toBe(0);
    });
  });

  // =============================================================================
  // Nested Transactions
  // =============================================================================

  describe('nested transactions', () => {
    it('inner commit should return isOutermost false', () => {
      const tm = createTransactionManager();
      const outerState = makeState('outer');
      const innerState = applyInsert(outerState, 5, '!');

      tm.begin(outerState);  // depth 1
      tm.begin(innerState);  // depth 2
      const result = tm.commit(); // inner commit
      expect(result.isOutermost).toBe(false);
      expect(tm.depth).toBe(1);
      expect(tm.isActive).toBe(true);
    });

    it('inner rollback should return the inner snapshot only', () => {
      const tm = createTransactionManager();
      const outerState = makeState('outer');
      const innerState = applyInsert(outerState, 5, '!');

      tm.begin(outerState);  // depth 1
      tm.begin(innerState);  // depth 2
      const result = tm.rollback(); // inner rollback
      expect(result.snapshot).toBe(innerState);
      expect(result.isOutermost).toBe(false);
      expect(tm.depth).toBe(1);
    });

    it('outer commit after inner commit should return isOutermost true', () => {
      const tm = createTransactionManager();
      tm.begin(makeState('a'));
      tm.begin(makeState('b'));
      tm.commit(); // inner
      const result = tm.commit(); // outer
      expect(result.isOutermost).toBe(true);
      expect(tm.depth).toBe(0);
    });

    it('outer rollback should return the outermost snapshot', () => {
      const tm = createTransactionManager();
      const outerState = makeState('outer');
      const innerState = makeState('inner');

      tm.begin(outerState);
      tm.begin(innerState);
      tm.commit(); // inner commit, discards inner snapshot
      const result = tm.rollback(); // outer rollback
      expect(result.snapshot).toBe(outerState);
      expect(result.isOutermost).toBe(true);
      expect(tm.depth).toBe(0);
    });

    it('depth should track nesting correctly through begin/commit/rollback', () => {
      const tm = createTransactionManager();
      const s = makeState();

      expect(tm.depth).toBe(0);
      tm.begin(s); expect(tm.depth).toBe(1);
      tm.begin(s); expect(tm.depth).toBe(2);
      tm.begin(s); expect(tm.depth).toBe(3);
      tm.commit(); expect(tm.depth).toBe(2);
      tm.rollback(); expect(tm.depth).toBe(1);
      tm.commit(); expect(tm.depth).toBe(0);
    });
  });

  // =============================================================================
  // Pending Actions
  // =============================================================================

  describe('pending actions', () => {
    it('trackAction() should accumulate actions during active transaction', () => {
      const tm = createTransactionManager();
      tm.begin(makeState());

      const action1 = DocumentActions.insert(byteOffset(0), 'a');
      const action2 = DocumentActions.insert(byteOffset(1), 'b');
      tm.trackAction(action1);
      tm.trackAction(action2);

      expect(tm.pendingActions).toEqual([action1, action2]);
    });

    it('commit() at outermost level should return pendingActions and clear them', () => {
      const tm = createTransactionManager();
      tm.begin(makeState());

      const action = DocumentActions.insert(byteOffset(0), 'x');
      tm.trackAction(action);

      const result = tm.commit();
      expect(result.pendingActions).toEqual([action]);
      expect(tm.pendingActions).toEqual([]);
    });

    it('rollback() at outermost level should clear pending actions', () => {
      const tm = createTransactionManager();
      tm.begin(makeState());

      tm.trackAction(DocumentActions.insert(byteOffset(0), 'x'));
      tm.rollback();

      expect(tm.pendingActions).toEqual([]);
    });

    it('begin() at depth 0 should clear pending actions from prior state', () => {
      const tm = createTransactionManager();
      const s = makeState();

      // First transaction with some actions
      tm.begin(s);
      tm.trackAction(DocumentActions.insert(byteOffset(0), 'a'));
      tm.commit();

      // Second transaction should start with clean pending
      tm.begin(s);
      expect(tm.pendingActions).toEqual([]);
    });

    it('inner commit should not return pending actions', () => {
      const tm = createTransactionManager();
      tm.begin(makeState());
      tm.trackAction(DocumentActions.insert(byteOffset(0), 'outer'));

      tm.begin(makeState());
      tm.trackAction(DocumentActions.insert(byteOffset(0), 'inner'));

      const innerResult = tm.commit();
      expect(innerResult.pendingActions).toEqual([]);

      // But outermost commit returns all accumulated actions
      const outerResult = tm.commit();
      expect(outerResult.pendingActions).toHaveLength(2);
    });
  });

  // =============================================================================
  // Emergency Reset
  // =============================================================================

  describe('emergencyReset', () => {
    it('should return the earliest snapshot (outermost)', () => {
      const tm = createTransactionManager();
      const first = makeState('first');
      const second = makeState('second');

      tm.begin(first);
      tm.begin(second);

      const earliest = tm.emergencyReset();
      expect(earliest).toBe(first);
    });

    it('should reset depth to 0', () => {
      const tm = createTransactionManager();
      tm.begin(makeState());
      tm.begin(makeState());
      tm.emergencyReset();
      expect(tm.depth).toBe(0);
      expect(tm.isActive).toBe(false);
    });

    it('should clear pending actions', () => {
      const tm = createTransactionManager();
      tm.begin(makeState());
      tm.trackAction(DocumentActions.insert(byteOffset(0), 'x'));
      tm.emergencyReset();
      expect(tm.pendingActions).toEqual([]);
    });

    it('should return null when no snapshots exist', () => {
      const tm = createTransactionManager();
      const result = tm.emergencyReset();
      expect(result).toBeNull();
    });
  });

  // =============================================================================
  // Edge Cases
  // =============================================================================

  describe('edge cases', () => {
    it('double commit at depth 0 should be safe', () => {
      const tm = createTransactionManager();
      tm.begin(makeState());
      tm.commit();
      const result = tm.commit();
      expect(result.isOutermost).toBe(false);
      expect(tm.depth).toBe(0);
    });

    it('double rollback at depth 0 should be safe', () => {
      const tm = createTransactionManager();
      tm.begin(makeState());
      tm.rollback();
      const result = tm.rollback();
      expect(result.isOutermost).toBe(false);
      expect(result.snapshot).toBeNull();
      expect(tm.depth).toBe(0);
    });

    it('begin-rollback-begin should work correctly (reentrant)', () => {
      const tm = createTransactionManager();
      const s1 = makeState('first');
      const s2 = makeState('second');

      tm.begin(s1);
      const r1 = tm.rollback();
      expect(r1.snapshot).toBe(s1);
      expect(tm.depth).toBe(0);

      tm.begin(s2);
      expect(tm.depth).toBe(1);
      const r2 = tm.commit();
      expect(r2.isOutermost).toBe(true);
      expect(tm.depth).toBe(0);
    });

    it('emergencyReset followed by normal use should work', () => {
      const tm = createTransactionManager();
      tm.begin(makeState('old'));
      tm.emergencyReset();

      const fresh = makeState('fresh');
      tm.begin(fresh);
      expect(tm.depth).toBe(1);
      const result = tm.rollback();
      expect(result.snapshot).toBe(fresh);
      expect(tm.depth).toBe(0);
    });
  });
});
