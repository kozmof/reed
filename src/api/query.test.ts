import { describe, it, expect } from "vitest";
import { query } from "./query.js";
import { createDocumentStore } from "../store/features/store.js";
import { DocumentActions } from "../store/features/actions.js";
import { byteOffset } from "../types/branded.js";
import { createInitialState } from "../store/core/state.js";

describe("query selectors", () => {
  it("findLineAtPosition should locate the line containing a byte offset", () => {
    const state = createInitialState({ content: "Hello\nWorld" });
    const result = query.findLineAtPosition(state, byteOffset(7));
    expect(result).not.toBeNull();
    expect(result!.lineNumber).toBe(1);
  });

  it("findLineByNumber should return the line node for a 0-based line number", () => {
    const state = createInitialState({ content: "A\nB\nC" });
    const result = query.findLineByNumber(state, 2);
    expect(result).not.toBeNull();
    expect(result!.documentOffset).toBe(4);
  });

  it("getLineStartOffset should return the byte offset of a line's start", () => {
    const state = createInitialState({ content: "ABC\nDEF" });
    const offset = query.getLineStartOffset(state, 1);
    expect(offset).not.toBeNull();
  });

  it("getLineCount should return total line count", () => {
    const state = createInitialState({ content: "line1\nline2\nline3" });
    expect(query.getLineCount(state)).toBe(3);
  });

  it("getCharStartOffset should return char prefix sum for a line", () => {
    const state = createInitialState({ content: "Hello\nWorld" });
    const offset = query.getCharStartOffset(state, 1);
    expect(offset).not.toBeNull();
  });

  it("findLineAtCharPosition should locate line by character offset", () => {
    const state = createInitialState({ content: "Hello\nWorld" });
    const result = query.findLineAtCharPosition(state, 7);
    expect(result).not.toBeNull();
    expect(result!.lineNumber).toBe(1);
  });

  it("getSelectionHead should return the head of the primary selection", () => {
    const store = createDocumentStore({ content: "hello" });
    const state = store.getSnapshot();
    expect(query.getSelectionHead(state)).toBe(0);
  });

  it("getSelectionHead should return undefined when there are no selection ranges", () => {
    const state = createInitialState({ content: "hello" });
    // Manipulate selection to be empty
    const stateWithEmptySelection = {
      ...state,
      selection: { ranges: [] as unknown as typeof state.selection.ranges, primaryIndex: 0 },
    };
    expect(query.getSelectionHead(stateWithEmptySelection)).toBeUndefined();
  });
});

describe("query mode contracts", () => {
  it("should expose reconciled state guards for mode-sensitive selectors", () => {
    const store = createDocumentStore({ content: "line-0" });
    const initial = store.getSnapshot();

    expect(query.isReconciledState(initial)).toBe(true);

    store.dispatch(DocumentActions.insert(byteOffset(0), "A\nB\n"));
    const dirty = store.getSnapshot();

    expect(query.isReconciledState(dirty)).toBe(false);
  });

  it("should separate precise (lazy-safe) and eager-only line range lookups", () => {
    const store = createDocumentStore({ content: "" });
    store.dispatch(DocumentActions.insert(byteOffset(0), "A\nB"));
    const dirty = store.getSnapshot();

    const precise = query.getLineRangePrecise(dirty, 1);
    expect(precise).not.toBeNull();
    expect(() => query.getLineRangeChecked(dirty, 1)).toThrow();

    const eager = store.reconcileNow();
    const strict = query.getLineRange(eager, 1);
    const checked = query.getLineRangeChecked(eager, 1);
    const lowLevel = query.lineIndex.getLineRange(eager.lineIndex, 1);

    expect(strict).not.toBeNull();
    expect(checked).toEqual(strict);
    expect(lowLevel).toEqual(strict);
  });
});
