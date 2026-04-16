import { describe, it, expect } from "vitest";
import { query } from "./query.ts";
import { createDocumentStore } from "../store/features/store.ts";
import { DocumentActions } from "../store/features/actions.ts";
import { byteOffset } from "../types/branded.ts";

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
