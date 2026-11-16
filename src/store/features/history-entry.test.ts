import { describe, it, expect } from "vitest";
import type { HistoryChange, HistoryEntry } from "../../types/state.js";
import { makeInsertChange } from "./edit.js";
import { coalescedTails, someHistoryChange, someHistoryChangeBackward } from "./history-entry.js";

const selection = Object.freeze({
  ranges: [{ anchor: 0, head: 0, anchorAfterChunk: -1, headAfterChunk: -1 }] as const,
  primaryIndex: 0,
});

function entry(changes: readonly HistoryChange[]): HistoryEntry {
  return { changes, selectionBefore: selection, selectionAfter: selection, timestamp: 0 };
}

function order(
  e: HistoryEntry,
  some: (e: HistoryEntry, p: (c: HistoryChange) => boolean) => boolean,
) {
  const seen: string[] = [];
  some(e, (change) => {
    seen.push(change.text);
    return false;
  });
  return seen;
}

describe("someHistoryChangeBackward", () => {
  const changes = ["a", "b", "c"].map((text, i) => makeInsertChange(i, text));

  it("visits a plain entry last to first and stops at the first match", () => {
    const e = entry(changes);
    expect(order(e, someHistoryChangeBackward)).toEqual(["c", "b", "a"]);
    const seen: string[] = [];
    expect(
      someHistoryChangeBackward(e, (change) => {
        seen.push(change.text);
        return change.text === "b";
      }),
    ).toBe(true);
    expect(seen).toEqual(["c", "b"]);
  });

  it("visits a coalesced entry's tail first, then the base without its last change", () => {
    const tail = makeInsertChange(2, "cd");
    const e = entry([]);
    coalescedTails.set(e, { base: changes, tail });
    expect(order(e, someHistoryChange)).toEqual(["a", "b", "cd"]);
    expect(order(e, someHistoryChangeBackward)).toEqual(["cd", "b", "a"]);
  });
});
