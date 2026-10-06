import { expect, it } from "vitest";
import { diff, setValueWithDiff } from "./diff.js";
import { createInitialState } from "../core/state.js";
import { getValue } from "../core/piece-table.js";

function checkScript(oldText: string, newText: string): number {
  const result = diff(oldText, newText);
  let oldPosition = 0;
  let newPosition = 0;
  const reconstructed: string[] = [];
  for (const edit of result.edits) {
    expect(edit.oldPos).toBe(oldPosition);
    expect(edit.newPos).toBe(newPosition);
    if (edit.type !== "insert") {
      expect(edit.text).toBe(oldText.slice(oldPosition, oldPosition + edit.text.length));
      oldPosition += edit.text.length;
    }
    if (edit.type !== "delete") {
      reconstructed.push(edit.text);
      newPosition += edit.text.length;
    }
  }
  expect(oldPosition).toBe(oldText.length);
  expect(reconstructed.join("")).toBe(newText);
  return result.distance;
}

it("retains distant small changes when a full-width frontier would exceed the budget", () => {
  const middle = "x".repeat(2_200_000);
  expect(checkScript(`a${middle}b`, `c${middle}d`)).toBe(4);
});

it("keeps equal runs between separated insertions and deletions", () => {
  const oldText = "ab".repeat(100) + "漢".repeat(120) + "cd".repeat(100);
  const newText = "X" + oldText.slice(1, 250) + "Y" + oldText.slice(251) + "Z";
  expect(checkScript(oldText, newText)).toBe(5);
  const result = setValueWithDiff(createInitialState({ content: oldText }), newText);
  expect(getValue(result.pieceTable)).toBe(newText);
});

it("matches an independent LCS distance for Myers-sized inputs", () => {
  let seed = 117;
  const randomText = (): string =>
    Array.from({ length: 120 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return "abc漢"[(seed >>> 16) % 4];
    }).join("");
  for (let round = 0; round < 30; round++) {
    const oldText = randomText();
    const newText = randomText();
    const row = new Uint32Array(newText.length + 1);
    for (const oldChar of oldText) {
      let diagonal = 0;
      for (let j = 1; j <= newText.length; j++) {
        const above = row[j]!;
        row[j] = oldChar === newText[j - 1] ? diagonal + 1 : Math.max(above, row[j - 1]!);
        diagonal = above;
      }
    }
    expect(checkScript(oldText, newText)).toBe(
      oldText.length + newText.length - 2 * row[newText.length]!,
    );
    expect(
      getValue(setValueWithDiff(createInitialState({ content: oldText }), newText).pieceTable),
    ).toBe(newText);
  }
});

it("falls back to a correct replacement when the compact trace exhausts its budget", () => {
  const oldText = "a".repeat(5000);
  const newText = "b".repeat(5000);
  expect(checkScript(oldText, newText)).toBe(10_000);
  expect(diff(oldText, newText).edits.map((edit) => edit.type)).toEqual(["delete", "insert"]);
});
