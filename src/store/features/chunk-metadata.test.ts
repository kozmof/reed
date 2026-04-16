/**
 * Tests for DECLARE_CHUNK_METADATA and line-index side-cache (issue #009, Part 3).
 * Verifies that pre-declared chunk metadata allows getLineCountFromIndex to return
 * the total expected line count before chunks are loaded, and that the side-cache
 * stays in sync across load/evict cycles.
 */

import { describe, it, expect } from "vitest";
import { documentReducer } from "./reducer.ts";
import { DocumentActions } from "./actions.ts";
import { createInitialState } from "../core/state.ts";
import { getLineCountFromIndex } from "../core/line-index.ts";
import { textEncoder } from "../core/encoding.ts";

describe("DECLARE_CHUNK_METADATA", () => {
  it("is a no-op in non-chunked mode (chunkSize === 0)", () => {
    const state = createInitialState({ content: "hello" });
    const next = documentReducer(
      state,
      DocumentActions.declareChunkMetadata([{ chunkIndex: 0, byteLength: 100, lineCount: 10 }]),
    );
    expect(next).toBe(state);
  });

  it("does not bump state.version", () => {
    const state = createInitialState({ chunkSize: 64 });
    const versionBefore = state.version;
    const next = documentReducer(
      state,
      DocumentActions.declareChunkMetadata([{ chunkIndex: 0, byteLength: 64, lineCount: 5 }]),
    );
    expect(next.version).toBe(versionBefore);
  });

  it("stores metadata in pieceTable.chunkMetadata", () => {
    const state = createInitialState({ chunkSize: 64 });
    const next = documentReducer(
      state,
      DocumentActions.declareChunkMetadata([
        { chunkIndex: 0, byteLength: 64, lineCount: 5 },
        { chunkIndex: 1, byteLength: 32, lineCount: 3 },
      ]),
    );
    expect(next.pieceTable.chunkMetadata.get(0)).toEqual({
      chunkIndex: 0,
      byteLength: 64,
      lineCount: 5,
    });
    expect(next.pieceTable.chunkMetadata.get(1)).toEqual({
      chunkIndex: 1,
      byteLength: 32,
      lineCount: 3,
    });
  });

  it("adds unloaded line counts to the line index side-cache", () => {
    const state = createInitialState({ chunkSize: 64 });
    const next = documentReducer(
      state,
      DocumentActions.declareChunkMetadata([{ chunkIndex: 0, byteLength: 64, lineCount: 10 }]),
    );
    expect(next.lineIndex.unloadedLineCountsByChunk.get(0)).toBe(10);
  });

  it("getLineCountFromIndex includes unloaded chunk line counts", () => {
    const state = createInitialState({ chunkSize: 64 });
    // Empty chunked store has 1 line (the sentinel).
    expect(getLineCountFromIndex(state.lineIndex)).toBe(1);

    const next = documentReducer(
      state,
      DocumentActions.declareChunkMetadata([
        { chunkIndex: 0, byteLength: 64, lineCount: 10 },
        { chunkIndex: 1, byteLength: 32, lineCount: 5 },
      ]),
    );
    // 1 (sentinel) + 10 + 5 = 16
    expect(getLineCountFromIndex(next.lineIndex)).toBe(16);
  });

  it("ignores metadata for already-loaded chunks", () => {
    const state0 = createInitialState({ chunkSize: 64 });
    // Load chunk 0 first
    const bytes = textEncoder.encode("line1\nline2\nline3\n");
    const state1 = documentReducer(state0, DocumentActions.loadChunk(0, bytes));

    // Attempt to declare metadata for the already-loaded chunk
    const state2 = documentReducer(
      state1,
      DocumentActions.declareChunkMetadata([{ chunkIndex: 0, byteLength: 64, lineCount: 999 }]),
    );

    // State must not change (returns same reference since no-op)
    expect(state2).toBe(state1);
    // Side-cache must not have an entry for the loaded chunk
    expect(state2.lineIndex.unloadedLineCountsByChunk.has(0)).toBe(false);
  });

  it("removing unloaded count on LOAD_CHUNK", () => {
    const state0 = createInitialState({ chunkSize: 64 });
    const state1 = documentReducer(
      state0,
      DocumentActions.declareChunkMetadata([{ chunkIndex: 0, byteLength: 64, lineCount: 5 }]),
    );
    // Side-cache has the entry before loading
    expect(state1.lineIndex.unloadedLineCountsByChunk.has(0)).toBe(true);

    const bytes = textEncoder.encode("a\nb\nc\nd\ne\n");
    const state2 = documentReducer(state1, DocumentActions.loadChunk(0, bytes));
    // Side-cache entry must be removed after LOAD_CHUNK
    expect(state2.lineIndex.unloadedLineCountsByChunk.has(0)).toBe(false);
    // Real line count from the tree
    expect(getLineCountFromIndex(state2.lineIndex)).toBeGreaterThanOrEqual(5);
  });

  it("restores unloaded count on EVICT_CHUNK when metadata is known", () => {
    const state0 = createInitialState({ chunkSize: 64 });
    // Declare metadata, then load, then evict
    const state1 = documentReducer(
      state0,
      DocumentActions.declareChunkMetadata([{ chunkIndex: 0, byteLength: 64, lineCount: 5 }]),
    );
    const bytes = textEncoder.encode("a\nb\nc\nd\ne\n");
    const state2 = documentReducer(state1, DocumentActions.loadChunk(0, bytes));
    const state3 = documentReducer(state2, DocumentActions.evictChunk(0));

    // After eviction the side-cache should be restored
    expect(state3.lineIndex.unloadedLineCountsByChunk.get(0)).toBe(5);
    // getLineCountFromIndex should include the restored count
    expect(getLineCountFromIndex(state3.lineIndex)).toBeGreaterThanOrEqual(5);
  });

  it("does NOT restore unloaded count on EVICT_CHUNK when no metadata was declared", () => {
    const state0 = createInitialState({ chunkSize: 64 });
    const bytes = textEncoder.encode("a\nb\nc\n");
    const state1 = documentReducer(state0, DocumentActions.loadChunk(0, bytes));
    const state2 = documentReducer(state1, DocumentActions.evictChunk(0));

    // No metadata was declared, so side-cache stays empty
    expect(state2.lineIndex.unloadedLineCountsByChunk.has(0)).toBe(false);
  });

  it("is a no-op when metadata array is empty", () => {
    const state = createInitialState({ chunkSize: 64 });
    const next = documentReducer(state, DocumentActions.declareChunkMetadata([]));
    expect(next).toBe(state);
  });
});

describe("DocumentStoreConfig.totalFileSize", () => {
  it("defaults to 0 when not provided", () => {
    const state = createInitialState({ chunkSize: 64 });
    expect(state.pieceTable.totalFileSize).toBe(0);
  });

  it("stores provided totalFileSize in pieceTable", () => {
    const state = createInitialState({ chunkSize: 64, totalFileSize: 1024 });
    expect(state.pieceTable.totalFileSize).toBe(1024);
  });

  it("is ignored when content is provided (non-chunked mode)", () => {
    const state = createInitialState({ content: "hello", totalFileSize: 9999 });
    // content mode is not chunked; totalFileSize stored as 0
    expect(state.pieceTable.totalFileSize).toBe(0);
  });
});
