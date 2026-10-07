import { createInitialState, createPieceTableState } from "./state.js";
import { pieceTableInsert } from "./piece-table.js";
import { byteOffset } from "../../types/branded.js";
import type { PieceNode } from "../../types/state.js";
import { documentReducer } from "../features/reducer.js";
import { DocumentActions } from "../features/actions.js";
import { describe, expect, it } from "vitest";
import {
  decodedCharLength,
  summarizeBytes,
  joinDecoded,
  scanPieceLines,
} from "./decoded-metrics.js";
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

describe("composable decoding counts", () => {
  it("matches replacement decoding for malformed and split UTF-8", () => {
    let seed = 9173;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed >>> 24;
    };
    const fixtures = [
      new TextEncoder().encode("漢😀\uFEFF\r\nx".repeat(1000)),
      Uint8Array.of(0xf0, 0x90, 0x80, 0x80),
      Uint8Array.of(0xed, 0xa0, 0x80),
      Uint8Array.of(0xe0, 0x80, 0x80),
      Uint8Array.of(0xf4, 0x90, 0x80, 0x80),
    ];
    for (let i = 0; i < 100; i++) fixtures.push(Uint8Array.from({ length: 100 }, random));
    for (const bytes of fixtures) {
      expect(decodedCharLength(bytes)).toBe(decoder.decode(bytes).length);
      for (
        let split = 0;
        split <= bytes.length;
        split += Math.max(1, Math.floor(bytes.length / 50))
      ) {
        const left = summarizeBytes(bytes, 0, split),
          right = summarizeBytes(bytes, split);
        expect(joinDecoded(left, right).chars).toBe(decoder.decode(bytes).length);
      }
      for (
        let start = 0;
        start < bytes.length;
        start += Math.max(1, Math.floor(bytes.length / 20))
      ) {
        const end = Math.min(bytes.length, start + 4099);
        expect(summarizeBytes(bytes, start, end).chars).toBe(
          decoder.decode(bytes.subarray(start, end)).length,
        );
      }
    }
  });
});

it("scans fragmented lines with one tree traversal and preserves decoder seams", () => {
  let table = createPieceTableState("");
  for (let i = 0; i < 1024; i++)
    table = pieceTableInsert(table, byteOffset(table.totalLength), "漢😀\r\nx\r").state;
  let reads = 0;
  function observe(node: PieceNode | null): PieceNode | null {
    if (!node) return null;
    const target = { ...node, left: observe(node.left), right: observe(node.right) };
    return new Proxy(target, {
      get(target, key, receiver) {
        if (key === "left" || key === "right") reads++;
        return Reflect.get(target, key, receiver);
      },
    });
  }
  const lines = scanPieceLines({ ...table, root: observe(table.root) }, 0, table.totalLength);
  expect(lines).toEqual([
    ...Array.from({ length: 1024 }, () => [
      { length: 9, charLength: 5 },
      { length: 2, charLength: 2 },
    ]).flat(),
    { length: 0, charLength: 0 },
  ]);
  expect(reads).toBeLessThan(1024 * 5);
});

it("matches independent line decoding for arbitrary bytes split across pieces", () => {
  let seed = 119;
  for (let round = 0; round < 40; round++) {
    const bytes = Uint8Array.from({ length: 80 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed >>> 24;
    });
    bytes.set([0xf0, 0x9f, 0x98, 0x80, 13, 10, 0xe0, 0xa0, 13, 0xff, 10], 5);
    let state = createInitialState({ chunkSize: 3 });
    for (let start = 0; start < bytes.length; start += 3)
      state = documentReducer(
        state,
        DocumentActions.loadChunk(start / 3, bytes.slice(start, start + 3)),
      );
    for (const start of [0, 6, 7]) {
      const expected: Array<{ length: number; charLength: number }> = [];
      let previous = start;
      for (let i = start; i < bytes.length; i++) {
        if (bytes[i] !== 10 && bytes[i] !== 13) continue;
        if (bytes[i] === 13 && bytes[i + 1] === 10) i++;
        expected.push({
          length: i + 1 - previous,
          charLength: decoder.decode(bytes.subarray(previous, i + 1)).length,
        });
        previous = i + 1;
      }
      expected.push({
        length: bytes.length - previous,
        charLength: decoder.decode(bytes.subarray(previous)).length,
      });
      expect(scanPieceLines(state.pieceTable, start, bytes.length)).toEqual(expected);
    }
  }
});
