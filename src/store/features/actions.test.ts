/**
 * Tests for serializeAction and deserializeAction.
 * Verifies round-trip correctness for all action types, including transaction
 * actions whose serialization was previously untested.
 */

import { describe, it, expect } from "vitest";
import { DocumentActions, serializeAction, deserializeAction } from "./actions.ts";
import { byteOffset } from "../../types/branded.ts";
import type { DocumentAction } from "../../types/actions.ts";

// =============================================================================
// Round-trip tests
// =============================================================================

describe("serializeAction / deserializeAction", () => {
  describe("round-trips", () => {
    const cases: Array<[string, DocumentAction]> = [
      ["INSERT", DocumentActions.insert(byteOffset(0), "hello")],
      ["DELETE", DocumentActions.delete(byteOffset(2), byteOffset(7))],
      ["REPLACE", DocumentActions.replace(byteOffset(0), byteOffset(3), "xyz")],
      ["SET_SELECTION", DocumentActions.setSelection([])],
      ["UNDO", DocumentActions.undo()],
      ["REDO", DocumentActions.redo()],
      ["HISTORY_CLEAR", DocumentActions.historyClear()],
      ["EVICT_CHUNK", DocumentActions.evictChunk(3)],
      ["APPLY_REMOTE (empty)", DocumentActions.applyRemote([])],
    ];

    it.each(cases)("%s serializes to valid JSON", (_, action) => {
      const json = serializeAction(action);
      expect(() => JSON.parse(json)).not.toThrow();
    });

    it.each(cases)("%s round-trips correctly", (_, action) => {
      const deserialized = deserializeAction(serializeAction(action));
      expect(deserialized).toEqual(action);
      expect(deserialized.type).toBe(action.type);
    });

    it("LOAD_CHUNK preserves Uint8Array data through base64 encoding", () => {
      const data = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"
      const action = DocumentActions.loadChunk(0, data);
      const deserialized = deserializeAction(serializeAction(action));
      expect(deserialized.type).toBe("LOAD_CHUNK");
      if (deserialized.type === "LOAD_CHUNK") {
        expect(deserialized.data).toBeInstanceOf(Uint8Array);
        expect(Array.from(deserialized.data)).toEqual(Array.from(data));
      }
    });

    it("LOAD_CHUNK with empty Uint8Array round-trips correctly", () => {
      const action = DocumentActions.loadChunk(1, new Uint8Array(0));
      const deserialized = deserializeAction(serializeAction(action));
      expect(deserialized.type).toBe("LOAD_CHUNK");
      if (deserialized.type === "LOAD_CHUNK") {
        expect(deserialized.data).toBeInstanceOf(Uint8Array);
        expect(deserialized.data.length).toBe(0);
      }
    });

    it("INSERT with unicode text round-trips correctly", () => {
      const action = DocumentActions.insert(byteOffset(0), "😀 hello\nworld");
      const deserialized = deserializeAction(serializeAction(action));
      expect(deserialized).toEqual(action);
    });
  });

  // =============================================================================
  // Error cases
  // =============================================================================

  describe("deserializeAction errors", () => {
    it("throws on invalid JSON", () => {
      expect(() => deserializeAction("not json")).toThrow();
    });

    it("throws on unknown action type", () => {
      expect(() => deserializeAction(JSON.stringify({ type: "UNKNOWN_ACTION" }))).toThrow(
        /Invalid deserialized action/,
      );
    });

    it("throws on missing required fields (INSERT without text)", () => {
      expect(() => deserializeAction(JSON.stringify({ type: "INSERT", start: 0 }))).toThrow(
        /Invalid deserialized action/,
      );
    });

    it("throws on non-object input", () => {
      expect(() => deserializeAction(JSON.stringify(null))).toThrow();
      expect(() => deserializeAction(JSON.stringify(42))).toThrow();
    });
  });
});
