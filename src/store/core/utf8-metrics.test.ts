import { afterEach, describe, expect, it, vi } from "vitest";
import * as pieces from "./piece-table.js";
afterEach(() => vi.restoreAllMocks());
import {
  bufferByteAtChar,
  bufferCharPrefix,
  carryBufferMetrics,
  prepareBufferMetrics,
} from "./utf8-metrics.js";
import { lineByteToChar, lineCharToByte } from "./line-offsets.js";
import { createPieceTableState } from "./state.js";
import { pieceTableInsert, pieceTableDelete } from "./piece-table.js";
import { byteOffset } from "../../types/branded.js";

function check(text: string): void {
  const state = createPieceTableState(text);
  const encoder = new TextEncoder();
  let byte = 0,
    char = 0;
  for (const point of text) {
    expect(lineByteToChar(state, 0, state.totalLength, byte)).toBe(char);
    expect(lineCharToByte(state, 0, state.totalLength, char)).toBe(byte);
    if (point.length === 2)
      expect(lineCharToByte(state, 0, state.totalLength, char + 1)).toBe(byte + 4);
    byte += encoder.encode(point).length;
    char += point.length;
  }
  expect(lineCharToByte(state, 0, state.totalLength, char + 100)).toBe(byte);
}

describe("buffer-backed character metrics", () => {
  it("handles sparse-block boundaries and UTF-16 surrogate snapping", () => {
    check("a".repeat(4093) + "漢😀\r\nxyz😀");
    check("😀".repeat(1025) + "漢");
    check("");
  });
  it("bounds byte scans on a cold query after load", () => {
    const bytes = new TextEncoder().encode("漢😀x".repeat(100_000));
    prepareBufferMetrics(bytes);
    let reads = 0;
    const observed = new Proxy(bytes, {
      get(target, key) {
        if (typeof key === "string" && /^\d+$/.test(key)) reads++;
        return Reflect.get(target, key, target);
      },
    });
    expect(bufferCharPrefix(observed, 600_000)).toBe(300_000);
    expect(reads).toBeLessThan(4096);
    reads = 0;
    expect(bufferByteAtChar(observed, 300_000)).toBe(600_000);
    expect(reads).toBeLessThan(8200);
    const copied = new Uint8Array(bytes.length * 2);
    copied.set(bytes);
    carryBufferMetrics(bytes, copied, bytes.length);
    expect(bufferCharPrefix(copied.subarray(0, bytes.length), 600_000)).toBe(300_000);
  });
  it("preserves metrics through add-buffer growth and stale branches", () => {
    const base = createPieceTableState("漢😀");
    const first = pieceTableInsert(base, byteOffset(3), "x".repeat(5000)).state;
    expect(lineByteToChar(first, 0, first.totalLength, first.totalLength)).toBe(5003);
    const second = pieceTableInsert(first, byteOffset(3), "😀".repeat(5000)).state;
    const branch = pieceTableInsert(first, byteOffset(3), "漢".repeat(5000)).state;
    expect(lineByteToChar(second, 0, second.totalLength, second.totalLength)).toBe(15003);
    expect(lineByteToChar(branch, 0, branch.totalLength, branch.totalLength)).toBe(10003);
    expect(lineByteToChar(first, 0, first.totalLength, first.totalLength)).toBe(5003);
    const deleted = pieceTableDelete(second, byteOffset(3), byteOffset(20003));
    expect(lineByteToChar(deleted, 0, deleted.totalLength, deleted.totalLength)).toBe(5003);
  });
});

it("keeps decoder-based offsets correct across loaded chunk seams and edits", async () => {
  const { createInitialState } = await import("./state.js");
  const { documentReducer } = await import("../features/reducer.js");
  const { DocumentActions } = await import("../features/actions.js");
  const text = "漢😀x".repeat(4000);
  const bytes = new TextEncoder().encode(text);
  const size = 4097; // splits UTF-8 sequences
  let state = createInitialState({ chunkSize: size, totalFileSize: bytes.length });
  const chunks = [];
  for (let start = 0; start < bytes.length; start += size) {
    chunks.push({ chunkIndex: start / size, data: bytes.slice(start, start + size) });
  }
  state = documentReducer(state, DocumentActions.loadChunks(chunks));
  for (const column of [12000, 12001, 0, 4000, 16000, 999999, 2]) {
    const snapped = column === 2 ? 3 : Math.min(column, text.length);
    const expected = new TextEncoder().encode(text.slice(0, snapped)).length;
    expect(lineCharToByte(state.pieceTable, 0, bytes.length, column)).toBe(expected);
    expect(lineByteToChar(state.pieceTable, 0, bytes.length, expected)).toBe(snapped);
  }
  state = documentReducer(state, DocumentActions.insert(byteOffset(0), "x"));
  expect(lineCharToByte(state.pieceTable, 0, bytes.length + 1, 12001)).toBe(24001);
});

it("carries chunk checkpoints through shifted lines and preserves snapshot branches", async () => {
  const { createInitialState } = await import("./state.js");
  const { documentReducer } = await import("../features/reducer.js");
  const { DocumentActions } = await import("../features/actions.js");
  const text = "first\n" + "漢😀x".repeat(4000) + "\nlast";
  const bytes = new TextEncoder().encode(text);
  const original = documentReducer(
    createInitialState({ chunkSize: bytes.length }),
    DocumentActions.loadChunk(0, bytes),
  );
  const end = 6 + 32001;
  expect(lineCharToByte(original.pieceTable, 6, end, 12000)).toBe(24006);
  let state = documentReducer(original, DocumentActions.insert(byteOffset(1), "abc"));
  const reads = vi.spyOn(pieces, "getText");
  expect(lineCharToByte(state.pieceTable, 9, end + 3, 12000)).toBe(24009);
  expect(reads.mock.calls.length).toBeLessThanOrEqual(2);
  state = documentReducer(state, DocumentActions.delete(byteOffset(1), byteOffset(4)));
  expect(lineCharToByte(state.pieceTable, 6, end, 12000)).toBe(24006);
  state = documentReducer(state, DocumentActions.insert(byteOffset(24006), "z"));
  expect(lineCharToByte(state.pieceTable, 6, end + 1, 12001)).toBe(24007);
  expect(lineCharToByte(original.pieceTable, 6, end, 12001)).toBe(24009);
  const branch = documentReducer(original, DocumentActions.insert(byteOffset(16006), "漢"));
  expect(lineCharToByte(branch.pieceTable, 6, end + 3, 12001)).toBe(24009);
  const removed = documentReducer(original, DocumentActions.delete(byteOffset(0), byteOffset(9)));
  expect(removed.pieceTable.totalLength).toBe(bytes.length - 9);
});
