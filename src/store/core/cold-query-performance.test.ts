import { afterEach, expect, it, vi } from "vitest";
import { byteOffset } from "../../types/branded.js";
import type { PieceNode } from "../../types/state.js";
import { createPieceTableState, createInitialState } from "./state.js";
import { pieceTableInsert, pieceTableDelete, compactAddBuffer } from "./piece-table.js";
import { compactIncrementally } from "./incremental-maintenance.js";
import { lineCharToByte } from "./line-offsets.js";
import * as metrics from "./utf8-metrics.js";
import { createCheckpoint, restoreCheckpoint } from "../features/checkpoint.js";

afterEach(() => vi.restoreAllMocks());
it("does not prepare the whole backing buffer for a cold early-column seek", () => {
  const bytes = new TextEncoder().encode("漢😀x".repeat(300_000));
  let reads = 0;
  function observed(raw: Uint8Array): Uint8Array {
    return new Proxy(raw, {
      get(target, key) {
        if (typeof key === "string" && /^\d+$/.test(key)) reads++;
        if (key === "subarray")
          return (start?: number, end?: number) => observed(target.subarray(start, end));
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  expect(metrics.bufferByteAtChar(observed(bytes), 1)).toBe(3);
  expect(reads).toBeLessThan(32);
  reads = 0;
  expect(metrics.bufferByteAtCharInRange(observed(bytes), 800_000, bytes.length, 1)).toBe(800_003);
  expect(reads).toBeLessThan(32);
});
it("descends only the leading path of a cold fragmented line", () => {
  let state = createPieceTableState("a".repeat(30_000));
  for (let i = 0; i < 5000; i++) state = pieceTableInsert(state, byteOffset(i * 3 + 1), "x").state;
  const visited = new Set<PieceNode>();
  const proxies = new WeakMap<PieceNode, PieceNode>();
  function observe(node: PieceNode | null): PieceNode | null {
    if (!node) return null;
    let proxy = proxies.get(node);
    if (!proxy) {
      proxy = new Proxy(
        { ...node },
        {
          get(target, key, receiver) {
            visited.add(node);
            if (key === "left" || key === "right") return observe(target[key]);
            return Reflect.get(target, key, receiver);
          },
        },
      );
      proxies.set(node, proxy);
    }
    return proxy;
  }
  state = { ...state, root: observe(state.root) };
  expect(lineCharToByte(state, 0, state.totalLength, 1)).toBe(1);
  expect(visited.size).toBeLessThan(60);
});
it("keeps first queries local after paste, either compaction path, and checkpoint restore", () => {
  let pasted = pieceTableInsert(
    createPieceTableState(""),
    byteOffset(0),
    "漢😀x".repeat(100_000),
  ).state;
  pasted = pieceTableDelete(pasted, byteOffset(400_000), byteOffset(800_000));
  const sync = compactAddBuffer(pasted, 0);
  const job = compactIncrementally(pasted);
  let result = job.next();
  while (!result.done) result = job.next();
  const initial = createInitialState({ content: "漢😀x".repeat(100_000) });
  const restored = restoreCheckpoint(createCheckpoint(initial)).pieceTable;
  const counts = vi.spyOn(metrics, "bufferCharLength");
  for (const state of [pasted, sync, result.value, restored]) {
    counts.mockClear();
    expect(lineCharToByte(state, 0, state.totalLength, 1)).toBe(3);
    expect(
      Math.max(0, ...counts.mock.calls.map(([, start, end]) => end - start)),
    ).toBeLessThanOrEqual(4);
  }
});

it("keeps reads, Unicode metrics, and compaction local after branching a large add buffer", async () => {
  const { getText, getValue, getValueStream } = await import("./piece-table.js");
  const { GrowableBuffer } = await import("./growable-buffer.js");
  const { lineByteToChar } = await import("./line-offsets.js");
  const content = "漢😀x".repeat(100000);
  const original = pieceTableInsert(createPieceTableState(""), byteOffset(0), content).state;
  const mainline = pieceTableInsert(original, byteOffset(original.totalLength), "main").state;
  const branch = pieceTableInsert(original, byteOffset(original.totalLength), "branch😀").state;
  const flattened = vi.spyOn(GrowableBuffer.prototype, "bytes", "get");
  const copies = vi.spyOn(Uint8Array.prototype, "set");
  expect(getText(branch, byteOffset(0), byteOffset(8))).toBe("漢😀x");
  expect(lineCharToByte(branch, 0, branch.totalLength, 1)).toBe(3);
  expect(lineByteToChar(branch, 0, branch.totalLength, 8)).toBe(4);
  expect(
    [...getValueStream(branch, { start: original.totalLength, chunkSize: 3 })]
      .map((c) => c.content)
      .join(""),
  ).toBe("branch😀");
  const job = compactIncrementally(branch);
  let next = job.next();
  while (!next.done) next = job.next();
  expect(flattened).not.toHaveBeenCalled();
  expect(Math.max(0, ...copies.mock.calls.map(([source]) => source.length))).toBeLessThanOrEqual(
    65536,
  );
  copies.mockRestore();
  expect(getValue(next.value)).toBe(content + "branch😀");
  expect(getValue(mainline)).toBe(content + "main");
  expect(getValue(original)).toBe(content);
});

it("retains column checkpoints across more than 64 chunk-backed long lines", async () => {
  const { documentReducer } = await import("../features/reducer.js");
  const { DocumentActions } = await import("../features/actions.js");
  const pieces = await import("./piece-table.js");
  const line = "漢😀x".repeat(2048) + "\n";
  const bytes = new TextEncoder().encode(line.repeat(80));
  const state = documentReducer(
    createInitialState({ chunkSize: bytes.length }),
    DocumentActions.loadChunk(0, bytes),
  );
  const width = new TextEncoder().encode(line).length;
  const column = 6000;
  for (let i = 0; i < 80; i++)
    expect(lineCharToByte(state.pieceTable, i * width, (i + 1) * width, column)).toBe(
      i * width + 12000,
    );
  const reads = vi.spyOn(pieces, "getText");
  for (let i = 0; i < 80; i++)
    expect(lineCharToByte(state.pieceTable, i * width, (i + 1) * width, column)).toBe(
      i * width + 12000,
    );
  expect(
    reads.mock.calls.reduce((total, [, start, end]) => total + end - start, 0),
  ).toBeLessThanOrEqual(80 * 4096);
});

it("evicts the least recently queried lines when the checkpoint budget fills", async () => {
  const { documentReducer } = await import("../features/reducer.js");
  const { DocumentActions } = await import("../features/actions.js");
  const pieces = await import("./piece-table.js");
  const bytes = new TextEncoder().encode("abc\n".repeat(8200));
  const state = documentReducer(
    createInitialState({ chunkSize: bytes.length }),
    DocumentActions.loadChunk(0, bytes),
  );
  function query(line: number): void {
    expect(lineCharToByte(state.pieceTable, line * 4, line * 4 + 4, 4)).toBe(line * 4 + 4);
  }
  for (let line = 0; line < 8192; line++) query(line);
  query(0); // Keep the oldest line hot before creating another checkpoint.
  query(8192);
  const reads = vi.spyOn(pieces, "getText");
  query(0);
  expect(reads).not.toHaveBeenCalled();
  query(1);
  expect(reads).toHaveBeenCalled();
});
