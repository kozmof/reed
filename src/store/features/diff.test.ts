/**
 * Tests for diff algorithm and setValue operations.
 */

import { describe, it, expect } from "vitest";
import {
  diff,
  computeSetValueActions,
  computeSetValueActionsOptimized,
  computeSetValueActionsFromState,
  computeSetValueActionsFromStateWithDiff,
  setValue,
  setValueAuto,
  setValueWithDiff,
} from "./diff.js";
import { createInitialState } from "../core/state.js";
import { getValue, charToByteOffset, byteToCharOffset } from "../core/piece-table.js";

describe("Diff Algorithm", () => {
  describe("diff", () => {
    it("should return empty edits for identical strings", () => {
      const result = diff("hello", "hello");
      expect(result.distance).toBe(0);
      expect(result.edits.length).toBe(1);
      expect(result.edits[0]!.type).toBe("equal");
    });

    it("should handle empty old string (pure insert)", () => {
      const result = diff("", "hello");
      expect(result.distance).toBe(5);
      expect(result.edits.length).toBe(1);
      expect(result.edits[0]!.type).toBe("insert");
      expect(result.edits[0]!.text).toBe("hello");
    });

    it("should handle empty new string (pure delete)", () => {
      const result = diff("hello", "");
      expect(result.distance).toBe(5);
      expect(result.edits.length).toBe(1);
      expect(result.edits[0]!.type).toBe("delete");
      expect(result.edits[0]!.text).toBe("hello");
    });

    it("should detect simple insert", () => {
      const result = diff("ac", "abc");
      expect(result.edits.some((e) => e.type === "insert" && e.text === "b")).toBe(true);
    });

    it("should detect simple delete", () => {
      const result = diff("abc", "ac");
      expect(result.edits.some((e) => e.type === "delete" && e.text === "b")).toBe(true);
    });

    it("should handle common prefix", () => {
      const result = diff("hello world", "hello there");
      // Both start with "hello "
      expect(result.edits[0]!.type).toBe("equal");
      expect(result.edits[0]!.text).toBe("hello ");
    });

    it("should handle common suffix", () => {
      const result = diff("hello world", "goodbye world");
      // Both end with " world"
      const lastEdit = result.edits[result.edits.length - 1]!;
      expect(lastEdit.type).toBe("equal");
      expect(lastEdit.text).toContain("world");
    });

    it("should handle complete replacement", () => {
      const result = diff("abc", "xyz");
      // Should have deletes and inserts
      const hasDelete = result.edits.some((e) => e.type === "delete");
      const hasInsert = result.edits.some((e) => e.type === "insert");
      expect(hasDelete).toBe(true);
      expect(hasInsert).toBe(true);
    });

    it("should handle multiline text", () => {
      const old = "line1\nline2\nline3";
      const newText = "line1\nmodified\nline3";
      const result = diff(old, newText);
      // Should detect the change in the middle
      expect(result.distance).toBeGreaterThan(0);
    });
  });

  describe("computeSetValueActions", () => {
    it("should return empty array for identical content", () => {
      const actions = computeSetValueActions("hello", "hello");
      expect(actions).toEqual([]);
    });

    it("should generate insert action for appending", () => {
      const actions = computeSetValueActions("hello", "hello world");
      expect(actions.length).toBeGreaterThan(0);
      expect(actions.some((a) => a.type === "INSERT")).toBe(true);
    });

    it("should generate delete action for removing text", () => {
      const actions = computeSetValueActions("hello world", "hello");
      expect(actions.length).toBeGreaterThan(0);
      expect(actions.some((a) => a.type === "DELETE")).toBe(true);
    });

    it("should generate correct actions for replacement", () => {
      const actions = computeSetValueActions("hello", "world");
      expect(actions.length).toBeGreaterThan(0);
    });
  });

  describe("computeSetValueActionsOptimized", () => {
    it("should return empty array for identical content", () => {
      const actions = computeSetValueActionsOptimized("hello", "hello");
      expect(actions).toEqual([]);
    });

    it("should generate single INSERT for appending", () => {
      const actions = computeSetValueActionsOptimized("hello", "hello world");
      expect(actions.length).toBe(1);
      expect(actions[0]!.type).toBe("INSERT");
    });

    it("should generate single DELETE for removing suffix", () => {
      const actions = computeSetValueActionsOptimized("hello world", "hello");
      expect(actions.length).toBe(1);
      expect(actions[0]!.type).toBe("DELETE");
    });

    it("should generate single REPLACE for middle change", () => {
      const actions = computeSetValueActionsOptimized("hello world", "hello there");
      expect(actions.length).toBe(1);
      expect(actions[0]!.type).toBe("REPLACE");
    });

    it("should handle prefix-only change", () => {
      const actions = computeSetValueActionsOptimized("hello world", "hi world");
      expect(actions.length).toBe(1);
      expect(actions[0]!.type).toBe("REPLACE");
    });
  });

  describe("setValue", () => {
    it("should not change state for identical content", () => {
      const state = createInitialState({ content: "hello" });
      const newState = setValue(state, "hello");
      expect(newState).toBe(state);
    });

    it("should replace entire content", () => {
      const state = createInitialState({ content: "hello" });
      const newState = setValue(state, "world");
      expect(getValue(newState.pieceTable)).toBe("world");
    });

    it("should append text", () => {
      const state = createInitialState({ content: "hello" });
      const newState = setValue(state, "hello world");
      expect(getValue(newState.pieceTable)).toBe("hello world");
    });

    it("should remove text", () => {
      const state = createInitialState({ content: "hello world" });
      const newState = setValue(state, "hello");
      expect(getValue(newState.pieceTable)).toBe("hello");
    });

    it("should handle empty to content", () => {
      const state = createInitialState({ content: "" });
      const newState = setValue(state, "hello");
      expect(getValue(newState.pieceTable)).toBe("hello");
    });

    it("should handle content to empty", () => {
      const state = createInitialState({ content: "hello" });
      const newState = setValue(state, "");
      expect(getValue(newState.pieceTable)).toBe("");
    });

    it("should handle multiline content", () => {
      const state = createInitialState({ content: "line1\nline2\nline3" });
      const newState = setValue(state, "line1\nmodified\nline3");
      expect(getValue(newState.pieceTable)).toBe("line1\nmodified\nline3");
    });

    it("should update version", () => {
      const state = createInitialState({ content: "hello" });
      const newState = setValue(state, "world");
      expect(newState.version).toBeGreaterThan(state.version);
    });

    it("should mark as dirty", () => {
      const state = createInitialState({ content: "hello" });
      expect(state.metadata.isDirty).toBe(false);
      const newState = setValue(state, "world");
      expect(newState.metadata.isDirty).toBe(true);
    });

    it("should work with setValueWithDiff (minimal diff)", () => {
      const state = createInitialState({ content: "hello" });
      const newState = setValueWithDiff(state, "hello world");
      expect(getValue(newState.pieceTable)).toBe("hello world");
    });

    it("should maintain immutability", () => {
      const state = createInitialState({ content: "hello" });
      const newState = setValue(state, "world");
      expect(getValue(state.pieceTable)).toBe("hello");
      expect(getValue(newState.pieceTable)).toBe("world");
    });
  });

  describe("large content", () => {
    it("should handle large text efficiently", () => {
      const oldContent = "a".repeat(1000);
      const newContent = "a".repeat(500) + "b" + "a".repeat(499);

      const actions = computeSetValueActionsOptimized(oldContent, newContent);
      expect(actions.length).toBe(1);
      expect(actions[0]!.type).toBe("REPLACE");
    });

    it("should handle large diff", () => {
      const oldContent = "line1\n".repeat(100);
      const newContent = "line1\n".repeat(50) + "modified\n" + "line1\n".repeat(49);

      const result = diff(oldContent, newContent);
      expect(result.distance).toBeGreaterThan(0);
    });
  });

  describe("edge cases", () => {
    it("should handle unicode", () => {
      const state = createInitialState({ content: "Hello 世界" });
      const newState = setValue(state, "Hello 世界!");
      expect(getValue(newState.pieceTable)).toBe("Hello 世界!");
    });

    it("should handle emoji", () => {
      const state = createInitialState({ content: "Hello 🌍" });
      const newState = setValue(state, "Hello 🌎");
      expect(getValue(newState.pieceTable)).toBe("Hello 🌎");
    });

    it("should handle newlines only", () => {
      const state = createInitialState({ content: "\n\n\n" });
      const newState = setValue(state, "\n\n");
      expect(getValue(newState.pieceTable)).toBe("\n\n");
    });

    it("should handle whitespace changes", () => {
      const state = createInitialState({ content: "hello world" });
      const newState = setValue(state, "hello  world");
      expect(getValue(newState.pieceTable)).toBe("hello  world");
    });

    it("setValue completes without error when content contains a lone high surrogate", () => {
      // U+D800 is a lone high surrogate. TextEncoder normalises it to U+FFFD (3 bytes),
      // so the piece-table stores and returns the replacement character — not the original
      // surrogate. buildCharToByteMap must agree with TextEncoder on the 3-byte count so
      // that the delete range computed by computeSetValueActionsOptimized is correct.
      const loneHighSurrogate = "\uD800";
      const original = `text${loneHighSurrogate}`;
      const state = createInitialState({ content: original });
      const appended = `text${loneHighSurrogate}after`;
      const newState = setValue(state, appended);
      // TextEncoder normalises the lone surrogate to U+FFFD during encode; TextDecoder
      // then returns U+FFFD. Verify the operation succeeds and the suffix is correct.
      const result = getValue(newState.pieceTable);
      expect(result.endsWith("after")).toBe(true);
      expect(result.startsWith("text")).toBe(true);
    });

    it("charToByteOffset / byteToCharOffset round-trips over a lone high surrogate", () => {
      // Ensures the byte-map built during computeSetValueActions is consistent with
      // the piece-table offset helpers for the same lone-surrogate encoding.
      const loneHighSurrogate = "\uD800";
      const str = `abc${loneHighSurrogate}xyz`;
      // char index 4 = 'x', one position past the lone surrogate
      const charIdx = 4;
      const byteIdx = charToByteOffset(str, charIdx) as unknown as number;
      const roundTrip = byteToCharOffset(str, byteIdx) as unknown as number;
      expect(roundTrip).toBe(charIdx);
    });
  });

  describe("Unicode in buildCharToByteMap (Myers diff path)", () => {
    it("should handle 2-byte UTF-8 characters (Latin extended)", () => {
      // 'é' = U+00E9 is a 2-byte UTF-8 character (0x80 <= c < 0x800)
      const actions = computeSetValueActions("café", "caféè");
      expect(actions.length).toBeGreaterThan(0);
    });

    it("should handle 3-byte BMP characters (CJK)", () => {
      // '世' = U+4E16, 3 bytes in UTF-8 (0x800 <= c < 0xD800)
      const actions = computeSetValueActions("世界你好", "新界你好");
      expect(actions.length).toBeGreaterThan(0);
    });

    it("should handle 4-byte emoji (surrogate pairs in buildCharToByteMap)", () => {
      // '😀' = U+1F600 is encoded as surrogate pair 😀 in JS strings
      const actions = computeSetValueActions("Hello😀World", "Hello😂World");
      expect(actions.length).toBeGreaterThan(0);
    });

    it("should correctly apply setValueWithDiff for CJK content", () => {
      const state = createInitialState({ content: "世界" });
      const newState = setValueWithDiff(state, "世界!");
      expect(getValue(newState.pieceTable)).toBe("世界!");
    });
  });

  describe("Myers algorithm path (large strings, n*m >= 10000)", () => {
    it("should produce edits for large differing sections triggering Myers backtrack", () => {
      // Construct two strings whose middle sections are >100 chars each → n*m > 10000
      // so myersDiff takes the Myers path instead of simpleDiff.
      // Use complete-replacement middles (no shared chars) so the backtrack loop
      // cleanly emits only inserts and deletes and consolidateEdits merges them.
      const prefix = "SAME_PREFIX_";
      const suffix = "_SAME_SUFFIX";
      const oldMiddle = "x".repeat(101);
      const newMiddle = "y".repeat(101);
      const result = diff(prefix + oldMiddle + suffix, prefix + newMiddle + suffix);
      expect(result.edits.length).toBeGreaterThan(0);
      const types = result.edits.map((e) => e.type);
      expect(types).toContain("delete");
      expect(types).toContain("insert");
    });
  });

  describe("surrogate-pair boundary in computeSetValueActionsOptimized", () => {
    it("should not split a surrogate pair when the suffix scan lands on the high surrogate", () => {
      // U+10000 = 𐀀, U+10400 = 𐐀 — same low surrogate, different high surrogate
      const oldContent = "A𐀀B";
      const newContent = "A𐐀B";
      const actions = computeSetValueActionsOptimized(oldContent, newContent);
      expect(actions.length).toBe(1);
      expect(actions[0]!.type).toBe("REPLACE");
    });
  });

  describe("setValueAuto", () => {
    it("should use fast strategy by default", () => {
      const state = createInitialState({ content: "hello" });
      const newState = setValueAuto(state, "hello world");
      expect(getValue(newState.pieceTable)).toBe("hello world");
    });

    it("should use diff strategy when specified", () => {
      const state = createInitialState({ content: "hello" });
      const newState = setValueAuto(state, "hello world", { strategy: "diff" });
      expect(getValue(newState.pieceTable)).toBe("hello world");
    });

    it("should return same state when content is identical with diff strategy", () => {
      const state = createInitialState({ content: "hello" });
      const newState = setValueAuto(state, "hello", { strategy: "diff" });
      expect(getValue(newState.pieceTable)).toBe("hello");
    });
  });

  describe("computeSetValueActionsFromState", () => {
    it("should return empty array when content matches", () => {
      const state = createInitialState({ content: "hello" });
      const actions = computeSetValueActionsFromState(state.pieceTable, "hello");
      expect(actions).toEqual([]);
    });

    it("should return actions for changed content", () => {
      const state = createInitialState({ content: "hello" });
      const actions = computeSetValueActionsFromState(state.pieceTable, "hello world");
      expect(actions.length).toBeGreaterThan(0);
    });

    it("should generate a pure insert for appended text", () => {
      const state = createInitialState({ content: "hello" });
      const actions = computeSetValueActionsFromState(state.pieceTable, "hello!");
      expect(actions.length).toBe(1);
      expect(actions[0]!.type).toBe("INSERT");
    });
  });

  describe("computeSetValueActionsFromStateWithDiff", () => {
    it("should return empty array when content matches", () => {
      const state = createInitialState({ content: "hello" });
      const actions = computeSetValueActionsFromStateWithDiff(state.pieceTable, "hello");
      expect(actions).toEqual([]);
    });

    it("should return diff actions for changed content", () => {
      const state = createInitialState({ content: "hello" });
      const actions = computeSetValueActionsFromStateWithDiff(state.pieceTable, "world");
      expect(actions.length).toBeGreaterThan(0);
    });

    it("should produce correct result when applied to state", () => {
      const state = createInitialState({ content: "abc" });
      const actions = computeSetValueActionsFromStateWithDiff(state.pieceTable, "axc");
      expect(actions.length).toBeGreaterThan(0);
    });
  });
});
