/**
 * Tests for the event system.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createEventEmitter,
  createContentChangeEvent,
  createSelectionChangeEvent,
  createHistoryChangeEvent,
  createSaveEvent,
  createDirtyChangeEvent,
  getAffectedRange,
} from './events.ts';
import { createInitialState } from './state.ts';
import { DocumentActions } from './actions.ts';
import { byteOffset } from '../types/branded.ts';

describe('Event Emitter', () => {
  describe('addEventListener', () => {
    it('should add and call event handlers', () => {
      const emitter = createEventEmitter();
      const handler = vi.fn();

      emitter.addEventListener('save', handler);

      const state = createInitialState();
      const event = createSaveEvent(state);
      emitter.emit('save', event);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(event);
    });

    it('should support multiple handlers for same event', () => {
      const emitter = createEventEmitter();
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      emitter.addEventListener('save', handler1);
      emitter.addEventListener('save', handler2);

      const state = createInitialState();
      emitter.emit('save', createSaveEvent(state));

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it('should return unsubscribe function', () => {
      const emitter = createEventEmitter();
      const handler = vi.fn();

      const unsubscribe = emitter.addEventListener('save', handler);

      const state = createInitialState();
      emitter.emit('save', createSaveEvent(state));
      expect(handler).toHaveBeenCalledTimes(1);

      unsubscribe();
      emitter.emit('save', createSaveEvent(state));
      expect(handler).toHaveBeenCalledTimes(1); // Still 1, not called again
    });
  });

  describe('removeEventListener', () => {
    it('should remove specific handler', () => {
      const emitter = createEventEmitter();
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      emitter.addEventListener('save', handler1);
      emitter.addEventListener('save', handler2);

      emitter.removeEventListener('save', handler1);

      const state = createInitialState();
      emitter.emit('save', createSaveEvent(state));

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it('should handle removing non-existent handler', () => {
      const emitter = createEventEmitter();
      const handler = vi.fn();

      // Should not throw
      expect(() => {
        emitter.removeEventListener('save', handler);
      }).not.toThrow();
    });
  });

  describe('removeAllListeners', () => {
    it('should remove all handlers for all events', () => {
      const emitter = createEventEmitter();
      const saveHandler = vi.fn();
      const dirtyHandler = vi.fn();

      emitter.addEventListener('save', saveHandler);
      emitter.addEventListener('dirty-change', dirtyHandler);

      emitter.removeAllListeners();

      const state = createInitialState();
      emitter.emit('save', createSaveEvent(state));
      emitter.emit('dirty-change', createDirtyChangeEvent(true, state));

      expect(saveHandler).not.toHaveBeenCalled();
      expect(dirtyHandler).not.toHaveBeenCalled();
    });
  });

  describe('emit', () => {
    it('should handle errors in handlers gracefully', () => {
      const emitter = createEventEmitter();
      const errorHandler = vi.fn(() => {
        throw new Error('Handler error');
      });
      const goodHandler = vi.fn();

      emitter.addEventListener('save', errorHandler);
      emitter.addEventListener('save', goodHandler);

      const state = createInitialState();

      // Should not throw, error is caught internally
      expect(() => {
        emitter.emit('save', createSaveEvent(state));
      }).not.toThrow();

      // Good handler should still be called
      expect(goodHandler).toHaveBeenCalledTimes(1);
    });

    it('should not call handlers for other event types', () => {
      const emitter = createEventEmitter();
      const saveHandler = vi.fn();
      const dirtyHandler = vi.fn();

      emitter.addEventListener('save', saveHandler);
      emitter.addEventListener('dirty-change', dirtyHandler);

      const state = createInitialState();
      emitter.emit('save', createSaveEvent(state));

      expect(saveHandler).toHaveBeenCalledTimes(1);
      expect(dirtyHandler).not.toHaveBeenCalled();
    });
  });
});

describe('Event Creators', () => {
  describe('createContentChangeEvent', () => {
    it('should create frozen content change event', () => {
      const prevState = createInitialState({ content: 'Hello' });
      const nextState = createInitialState({ content: 'Hello World' });
      const action = DocumentActions.insert(byteOffset(5), ' World');

      const event = createContentChangeEvent(action, prevState, nextState, [5, 11]);

      expect(event.type).toBe('content-change');
      expect(event.action).toBe(action);
      expect(event.prevState).toBe(prevState);
      expect(event.nextState).toBe(nextState);
      expect(event.affectedRange).toEqual([5, 11]);
      expect(event.timestamp).toBeLessThanOrEqual(Date.now());
      expect(Object.isFrozen(event)).toBe(true);
    });
  });

  describe('createSelectionChangeEvent', () => {
    it('should create frozen selection change event', () => {
      const prevState = createInitialState();
      const nextState = createInitialState();

      const event = createSelectionChangeEvent(prevState, nextState);

      expect(event.type).toBe('selection-change');
      expect(event.prevState).toBe(prevState);
      expect(event.nextState).toBe(nextState);
      expect(event.timestamp).toBeLessThanOrEqual(Date.now());
      expect(Object.isFrozen(event)).toBe(true);
    });
  });

  describe('createHistoryChangeEvent', () => {
    it('should create undo event', () => {
      const prevState = createInitialState();
      const nextState = createInitialState();

      const event = createHistoryChangeEvent('undo', prevState, nextState);

      expect(event.type).toBe('history-change');
      expect(event.direction).toBe('undo');
      expect(Object.isFrozen(event)).toBe(true);
    });

    it('should create redo event', () => {
      const prevState = createInitialState();
      const nextState = createInitialState();

      const event = createHistoryChangeEvent('redo', prevState, nextState);

      expect(event.type).toBe('history-change');
      expect(event.direction).toBe('redo');
      expect(Object.isFrozen(event)).toBe(true);
    });
  });

  describe('createSaveEvent', () => {
    it('should create frozen save event', () => {
      const state = createInitialState();

      const event = createSaveEvent(state);

      expect(event.type).toBe('save');
      expect(event.state).toBe(state);
      expect(event.timestamp).toBeLessThanOrEqual(Date.now());
      expect(Object.isFrozen(event)).toBe(true);
    });
  });

  describe('createDirtyChangeEvent', () => {
    it('should create dirty=true event', () => {
      const state = createInitialState();

      const event = createDirtyChangeEvent(true, state);

      expect(event.type).toBe('dirty-change');
      expect(event.isDirty).toBe(true);
      expect(event.state).toBe(state);
      expect(Object.isFrozen(event)).toBe(true);
    });

    it('should create dirty=false event', () => {
      const state = createInitialState();

      const event = createDirtyChangeEvent(false, state);

      expect(event.type).toBe('dirty-change');
      expect(event.isDirty).toBe(false);
      expect(Object.isFrozen(event)).toBe(true);
    });
  });
});

describe('getAffectedRange', () => {
  it('should calculate range for INSERT', () => {
    const action = DocumentActions.insert(byteOffset(10), 'Hello');
    const range = getAffectedRange(action);

    expect(range[0]).toBe(10);
    expect(range[1]).toBe(15); // 10 + 5 bytes
  });

  it('should calculate range for DELETE', () => {
    const action = DocumentActions.delete(byteOffset(5), byteOffset(15)); // start=5, end=15
    const range = getAffectedRange(action);

    expect(range[0]).toBe(5);
    expect(range[1]).toBe(15);
  });

  it('should calculate range for REPLACE using new content length', () => {
    const action = DocumentActions.replace(byteOffset(5), byteOffset(15), 'Hi'); // start=5, end=15, text='Hi' (2 bytes)
    const range = getAffectedRange(action);

    expect(range[0]).toBe(5);
    expect(range[1]).toBe(7); // 5 + 2 (insertLength), not max(deleteLength, insertLength)
  });

  it('should calculate range for REPLACE when insert is longer than delete', () => {
    const action = DocumentActions.replace(byteOffset(0), byteOffset(2), 'Hello World'); // delete 2 bytes, insert 11
    const range = getAffectedRange(action);

    expect(range[0]).toBe(0);
    expect(range[1]).toBe(11); // 0 + 11 (insertLength)
  });

  it('should handle unicode in INSERT', () => {
    const action = DocumentActions.insert(byteOffset(0), '世界'); // 6 bytes in UTF-8
    const range = getAffectedRange(action);

    expect(range[0]).toBe(0);
    expect(range[1]).toBe(6);
  });

  it('should return [0, 0] for non-edit actions', () => {
    const action = DocumentActions.undo();
    const range = getAffectedRange(action);

    expect(range).toEqual([0, 0]);
  });
});
