/**
 * Tests for getValueStream and streaming operations.
 */

import { describe, it, expect } from 'vitest';
import { createInitialState } from './state.ts';
import { getValueStream } from './piece-table.ts';

describe('getValueStream', () => {
  describe('basic functionality', () => {
    it('should yield nothing for empty document', () => {
      const state = createInitialState();
      const chunks = [...getValueStream(state.pieceTable)];
      expect(chunks).toHaveLength(0);
    });

    it('should yield single chunk for small document', () => {
      const state = createInitialState({ content: 'Hello, World!' });
      const chunks = [...getValueStream(state.pieceTable)];

      expect(chunks).toHaveLength(1);
      expect(chunks[0].content).toBe('Hello, World!');
      expect(chunks[0].byteOffset).toBe(0);
      expect(chunks[0].isLast).toBe(true);
    });

    it('should reconstruct full content from chunks', () => {
      const content = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
      const state = createInitialState({ content });

      const chunks = [...getValueStream(state.pieceTable, { chunkSize: 10 })];
      const reconstructed = chunks.map(c => c.content).join('');

      expect(reconstructed).toBe(content);
    });

    it('should yield correct byte offsets', () => {
      const content = 'AAAAAAAAAA' + 'BBBBBBBBBB' + 'CCCCCCCCCC';
      const state = createInitialState({ content });

      const chunks = [...getValueStream(state.pieceTable, { chunkSize: 10 })];

      expect(chunks.length).toBe(3);
      expect(chunks[0].byteOffset).toBe(0);
      expect(chunks[1].byteOffset).toBe(10);
      expect(chunks[2].byteOffset).toBe(20);
    });

    it('should mark last chunk correctly', () => {
      const content = 'A'.repeat(25);
      const state = createInitialState({ content });

      const chunks = [...getValueStream(state.pieceTable, { chunkSize: 10 })];

      expect(chunks.length).toBe(3);
      expect(chunks[0].isLast).toBe(false);
      expect(chunks[1].isLast).toBe(false);
      expect(chunks[2].isLast).toBe(true);
    });
  });

  describe('chunk size', () => {
    it('should respect chunkSize option', () => {
      const content = 'A'.repeat(100);
      const state = createInitialState({ content });

      const chunks = [...getValueStream(state.pieceTable, { chunkSize: 20 })];

      expect(chunks.length).toBe(5);
      for (let i = 0; i < 4; i++) {
        expect(chunks[i].byteLength).toBe(20);
      }
      expect(chunks[4].byteLength).toBe(20);
    });

    it('should handle chunk size larger than document', () => {
      const content = 'Small';
      const state = createInitialState({ content });

      const chunks = [...getValueStream(state.pieceTable, { chunkSize: 1000 })];

      expect(chunks.length).toBe(1);
      expect(chunks[0].content).toBe('Small');
    });

    it('should use default 64KB chunk size', () => {
      const content = 'Test';
      const state = createInitialState({ content });

      const chunks = [...getValueStream(state.pieceTable)];

      expect(chunks.length).toBe(1);
      expect(chunks[0].content).toBe('Test');
    });
  });

  describe('range options', () => {
    it('should respect start option', () => {
      const content = 'Hello, World!';
      const state = createInitialState({ content });

      const chunks = [...getValueStream(state.pieceTable, { start: 7 })];

      expect(chunks.length).toBe(1);
      expect(chunks[0].content).toBe('World!');
      expect(chunks[0].byteOffset).toBe(7);
    });

    it('should respect end option', () => {
      const content = 'Hello, World!';
      const state = createInitialState({ content });

      const chunks = [...getValueStream(state.pieceTable, { end: 5 })];

      expect(chunks.length).toBe(1);
      expect(chunks[0].content).toBe('Hello');
    });

    it('should respect both start and end', () => {
      const content = 'Hello, World!';
      const state = createInitialState({ content });

      const chunks = [...getValueStream(state.pieceTable, { start: 7, end: 12 })];

      expect(chunks.length).toBe(1);
      expect(chunks[0].content).toBe('World');
    });

    it('should yield nothing for invalid range', () => {
      const content = 'Hello';
      const state = createInitialState({ content });

      expect([...getValueStream(state.pieceTable, { start: 10, end: 5 })]).toHaveLength(0);
      expect([...getValueStream(state.pieceTable, { start: -1 })]).toHaveLength(0);
      expect([...getValueStream(state.pieceTable, { start: 100 })]).toHaveLength(0);
    });
  });

  describe('unicode handling', () => {
    it('should handle unicode content', () => {
      const content = 'Hello 世界!';
      const state = createInitialState({ content });

      const chunks = [...getValueStream(state.pieceTable)];
      const reconstructed = chunks.map(c => c.content).join('');

      expect(reconstructed).toBe(content);
    });

    it('should handle emoji content', () => {
      const content = '🎉 Party 🎊 Time 🎈';
      const state = createInitialState({ content });

      const chunks = [...getValueStream(state.pieceTable)];
      const reconstructed = chunks.map(c => c.content).join('');

      expect(reconstructed).toBe(content);
    });

    it('should correctly report byte lengths for unicode', () => {
      const content = '世界'; // 6 bytes in UTF-8
      const state = createInitialState({ content });

      const chunks = [...getValueStream(state.pieceTable)];

      expect(chunks[0].byteLength).toBe(6);
    });
  });

  describe('large documents', () => {
    it('should handle large documents efficiently', () => {
      const lines = Array.from({ length: 1000 }, (_, i) => `Line ${i + 1}`);
      const content = lines.join('\n');
      const state = createInitialState({ content });

      const chunks = [...getValueStream(state.pieceTable, { chunkSize: 1024 })];
      const reconstructed = chunks.map(c => c.content).join('');

      expect(reconstructed).toBe(content);
      expect(chunks.length).toBeGreaterThan(1);
    });

    it('should process chunks incrementally', () => {
      const content = 'A'.repeat(10000);
      const state = createInitialState({ content });

      let processedBytes = 0;
      for (const chunk of getValueStream(state.pieceTable, { chunkSize: 100 })) {
        processedBytes += chunk.byteLength;
        expect(chunk.byteOffset).toBe(processedBytes - chunk.byteLength);
      }

      expect(processedBytes).toBe(10000);
    });
  });
});
