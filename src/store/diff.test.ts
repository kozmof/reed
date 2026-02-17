/**
 * Tests for diff algorithm and setValue operations.
 */

import { describe, it, expect } from 'vitest';
import {
  diff,
  computeSetValueActions,
  computeSetValueActionsOptimized,
  setValue,
} from './features/diff.ts';
import { createInitialState } from './core/state.ts';
import { getValue } from './core/piece-table.ts';

describe('Diff Algorithm', () => {
  describe('diff', () => {
    it('should return empty edits for identical strings', () => {
      const result = diff('hello', 'hello');
      expect(result.distance).toBe(0);
      expect(result.edits.length).toBe(1);
      expect(result.edits[0].type).toBe('equal');
    });

    it('should handle empty old string (pure insert)', () => {
      const result = diff('', 'hello');
      expect(result.distance).toBe(5);
      expect(result.edits.length).toBe(1);
      expect(result.edits[0].type).toBe('insert');
      expect(result.edits[0].text).toBe('hello');
    });

    it('should handle empty new string (pure delete)', () => {
      const result = diff('hello', '');
      expect(result.distance).toBe(5);
      expect(result.edits.length).toBe(1);
      expect(result.edits[0].type).toBe('delete');
      expect(result.edits[0].text).toBe('hello');
    });

    it('should detect simple insert', () => {
      const result = diff('ac', 'abc');
      expect(result.edits.some(e => e.type === 'insert' && e.text === 'b')).toBe(true);
    });

    it('should detect simple delete', () => {
      const result = diff('abc', 'ac');
      expect(result.edits.some(e => e.type === 'delete' && e.text === 'b')).toBe(true);
    });

    it('should handle common prefix', () => {
      const result = diff('hello world', 'hello there');
      // Both start with "hello "
      expect(result.edits[0].type).toBe('equal');
      expect(result.edits[0].text).toBe('hello ');
    });

    it('should handle common suffix', () => {
      const result = diff('hello world', 'goodbye world');
      // Both end with " world"
      const lastEdit = result.edits[result.edits.length - 1];
      expect(lastEdit.type).toBe('equal');
      expect(lastEdit.text).toContain('world');
    });

    it('should handle complete replacement', () => {
      const result = diff('abc', 'xyz');
      // Should have deletes and inserts
      const hasDelete = result.edits.some(e => e.type === 'delete');
      const hasInsert = result.edits.some(e => e.type === 'insert');
      expect(hasDelete).toBe(true);
      expect(hasInsert).toBe(true);
    });

    it('should handle multiline text', () => {
      const old = 'line1\nline2\nline3';
      const newText = 'line1\nmodified\nline3';
      const result = diff(old, newText);
      // Should detect the change in the middle
      expect(result.distance).toBeGreaterThan(0);
    });
  });

  describe('computeSetValueActions', () => {
    it('should return empty array for identical content', () => {
      const actions = computeSetValueActions('hello', 'hello');
      expect(actions).toEqual([]);
    });

    it('should generate insert action for appending', () => {
      const actions = computeSetValueActions('hello', 'hello world');
      expect(actions.length).toBeGreaterThan(0);
      expect(actions.some(a => a.type === 'INSERT')).toBe(true);
    });

    it('should generate delete action for removing text', () => {
      const actions = computeSetValueActions('hello world', 'hello');
      expect(actions.length).toBeGreaterThan(0);
      expect(actions.some(a => a.type === 'DELETE')).toBe(true);
    });

    it('should generate correct actions for replacement', () => {
      const actions = computeSetValueActions('hello', 'world');
      expect(actions.length).toBeGreaterThan(0);
    });
  });

  describe('computeSetValueActionsOptimized', () => {
    it('should return empty array for identical content', () => {
      const actions = computeSetValueActionsOptimized('hello', 'hello');
      expect(actions).toEqual([]);
    });

    it('should generate single INSERT for appending', () => {
      const actions = computeSetValueActionsOptimized('hello', 'hello world');
      expect(actions.length).toBe(1);
      expect(actions[0].type).toBe('INSERT');
    });

    it('should generate single DELETE for removing suffix', () => {
      const actions = computeSetValueActionsOptimized('hello world', 'hello');
      expect(actions.length).toBe(1);
      expect(actions[0].type).toBe('DELETE');
    });

    it('should generate single REPLACE for middle change', () => {
      const actions = computeSetValueActionsOptimized('hello world', 'hello there');
      expect(actions.length).toBe(1);
      expect(actions[0].type).toBe('REPLACE');
    });

    it('should handle prefix-only change', () => {
      const actions = computeSetValueActionsOptimized('hello world', 'hi world');
      expect(actions.length).toBe(1);
      expect(actions[0].type).toBe('REPLACE');
    });
  });

  describe('setValue', () => {
    it('should not change state for identical content', () => {
      const state = createInitialState({ content: 'hello' });
      const newState = setValue(state, 'hello');
      expect(newState).toBe(state);
    });

    it('should replace entire content', () => {
      const state = createInitialState({ content: 'hello' });
      const newState = setValue(state, 'world');
      expect(getValue(newState.pieceTable)).toBe('world');
    });

    it('should append text', () => {
      const state = createInitialState({ content: 'hello' });
      const newState = setValue(state, 'hello world');
      expect(getValue(newState.pieceTable)).toBe('hello world');
    });

    it('should remove text', () => {
      const state = createInitialState({ content: 'hello world' });
      const newState = setValue(state, 'hello');
      expect(getValue(newState.pieceTable)).toBe('hello');
    });

    it('should handle empty to content', () => {
      const state = createInitialState({ content: '' });
      const newState = setValue(state, 'hello');
      expect(getValue(newState.pieceTable)).toBe('hello');
    });

    it('should handle content to empty', () => {
      const state = createInitialState({ content: 'hello' });
      const newState = setValue(state, '');
      expect(getValue(newState.pieceTable)).toBe('');
    });

    it('should handle multiline content', () => {
      const state = createInitialState({ content: 'line1\nline2\nline3' });
      const newState = setValue(state, 'line1\nmodified\nline3');
      expect(getValue(newState.pieceTable)).toBe('line1\nmodified\nline3');
    });

    it('should update version', () => {
      const state = createInitialState({ content: 'hello' });
      const newState = setValue(state, 'world');
      expect(newState.version).toBeGreaterThan(state.version);
    });

    it('should mark as dirty', () => {
      const state = createInitialState({ content: 'hello' });
      expect(state.metadata.isDirty).toBe(false);
      const newState = setValue(state, 'world');
      expect(newState.metadata.isDirty).toBe(true);
    });

    it('should work with useReplace=false (minimal diff)', () => {
      const state = createInitialState({ content: 'hello' });
      const newState = setValue(state, 'hello world', { useReplace: false });
      expect(getValue(newState.pieceTable)).toBe('hello world');
    });

    it('should maintain immutability', () => {
      const state = createInitialState({ content: 'hello' });
      const newState = setValue(state, 'world');
      expect(getValue(state.pieceTable)).toBe('hello');
      expect(getValue(newState.pieceTable)).toBe('world');
    });
  });

  describe('large content', () => {
    it('should handle large text efficiently', () => {
      const oldContent = 'a'.repeat(1000);
      const newContent = 'a'.repeat(500) + 'b' + 'a'.repeat(499);

      const actions = computeSetValueActionsOptimized(oldContent, newContent);
      expect(actions.length).toBe(1);
      expect(actions[0].type).toBe('REPLACE');
    });

    it('should handle large diff', () => {
      const oldContent = 'line1\n'.repeat(100);
      const newContent = 'line1\n'.repeat(50) + 'modified\n' + 'line1\n'.repeat(49);

      const result = diff(oldContent, newContent);
      expect(result.distance).toBeGreaterThan(0);
    });
  });

  describe('edge cases', () => {
    it('should handle unicode', () => {
      const state = createInitialState({ content: 'Hello 世界' });
      const newState = setValue(state, 'Hello 世界!');
      expect(getValue(newState.pieceTable)).toBe('Hello 世界!');
    });

    it('should handle emoji', () => {
      const state = createInitialState({ content: 'Hello 🌍' });
      const newState = setValue(state, 'Hello 🌎');
      expect(getValue(newState.pieceTable)).toBe('Hello 🌎');
    });

    it('should handle newlines only', () => {
      const state = createInitialState({ content: '\n\n\n' });
      const newState = setValue(state, '\n\n');
      expect(getValue(newState.pieceTable)).toBe('\n\n');
    });

    it('should handle whitespace changes', () => {
      const state = createInitialState({ content: 'hello world' });
      const newState = setValue(state, 'hello  world');
      expect(getValue(newState.pieceTable)).toBe('hello  world');
    });
  });
});
