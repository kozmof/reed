import { afterEach, describe, expect, it, vi } from "vitest";
import { byteOffset, pieceID } from "../../types/branded.js";
import { createPieceTableState } from "./state.js";
import { inOrderPieces, pieceTableInsert, pieceTableDelete } from "./piece-table.js";
import { resolvePieceIdentity } from "./piece-identity-index.js";
import { PersistentMap } from "./persistent-map.js";

afterEach(() => vi.restoreAllMocks());
describe("piece identity index", () => {
  it("resolves offsets after rotations, splits, range deletions and branches", () => {
    let table = createPieceTableState("x".repeat(1000));
    const snapshots = [table];
    let seed = 4;
    for (let i = 0; i < 200; i++) {
      for (const { piece, docOffset } of inOrderPieces(table.root))
        expect(resolvePieceIdentity(table.root!, piece.id)).toEqual({
          offset: docOffset,
          length: piece.length,
        });
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const offset = seed % table.totalLength;
      if (i % 4 === 0) {
        const before = [...inOrderPieces(table.root)];
        table = pieceTableDelete(
          table,
          byteOffset(offset),
          byteOffset(Math.min(offset + 13, table.totalLength)),
        );
        const live = new Set([...inOrderPieces(table.root)].map(({ piece }) => piece.id));
        for (const { piece } of before)
          if (!live.has(piece.id)) expect(resolvePieceIdentity(table.root!, piece.id)).toBeNull();
      } else table = pieceTableInsert(table, byteOffset(offset), "abc").state;
      if (i % 20 === 0) snapshots.push(table);
    }
    for (const old of snapshots) {
      const branch = pieceTableInsert(old, byteOffset(0), "branch").state;
      for (const current of [old, branch])
        for (const { piece, docOffset } of inOrderPieces(current.root))
          expect(resolvePieceIdentity(current.root!, piece.id)?.offset).toBe(docOffset);
    }
    expect(resolvePieceIdentity(table.root!, pieceID("missing"))).toBeNull();
  });
  it("updates only tree paths in a fragmented document after a warm lookup", () => {
    let table = createPieceTableState("ab".repeat(4000));
    for (let i = 0; i < 3000; i++)
      table = pieceTableInsert(table, byteOffset(i * 3 + 1), "x").state;
    const id = table.root!.id;
    resolvePieceIdentity(table.root!, id);
    const writes = vi.spyOn(PersistentMap.prototype, "with");
    for (let i = 0; i < 20; i++) {
      writes.mockClear();
      table = pieceTableInsert(table, byteOffset(100 + i), "y").state;
      resolvePieceIdentity(table.root!, id);
      expect(writes.mock.calls.length).toBeLessThan(100);
    }
  });
});
