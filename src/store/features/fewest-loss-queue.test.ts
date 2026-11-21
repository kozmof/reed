import { describe, it, expect } from "vitest";
import { createFewestLossQueue } from "./fewest-loss-queue.js";
import type { EvictionHistoryLoss } from "./history-anchor.js";
import { makeDeterministicRng, randomInt } from "../../../test-utils/large-content.js";

/**
 * The order the queue should give: each time the open candidate with the
 * fewest entries left to discard, the earliest on a tie, measuring every loss
 * again after each drop.
 */
function referenceOrder(
  losses: readonly EvictionHistoryLoss[],
  refused: ReadonlySet<number>,
): number[] {
  const current = losses.map((loss) => ({ ...loss }));
  const open = new Set(losses.keys());
  const order: number[] = [];
  while (open.size > 0) {
    let best = -1;
    for (const i of open) {
      const total = current[i]!.undo + current[i]!.redo;
      if (best < 0 || total < current[best]!.undo + current[best]!.redo) best = i;
    }
    open.delete(best);
    order.push(best);
    if (refused.has(best)) continue;
    const dropped = current[best]!;
    for (const i of open) {
      current[i] = {
        undo: Math.max(0, current[i]!.undo - dropped.undo),
        redo: Math.max(0, current[i]!.redo - dropped.redo),
      };
    }
  }
  return order;
}

describe("createFewestLossQueue", () => {
  it("takes the cheapest candidate as the drops change what each costs", () => {
    // Evicting 0 drops 3 undo entries, which leaves 2 costing 2 and 1 costing 4.
    const queue = createFewestLossQueue([
      { undo: 3, redo: 0 },
      { undo: 0, redo: 4 },
      { undo: 3, redo: 2 },
    ]);
    const first = queue.take()!;
    expect(first).toEqual({ index: 0, loss: { undo: 3, redo: 0 } });
    queue.dropped(first.loss);
    expect(queue.take()).toEqual({ index: 2, loss: { undo: 0, redo: 2 } });
  });

  it("matches measuring every loss again after each drop", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const rng = makeDeterministicRng(seed);
      const count = randomInt(rng, 1, 12);
      const losses = Array.from({ length: count }, () => ({
        undo: randomInt(rng, 0, 6),
        redo: randomInt(rng, 0, 6),
      }));
      const refused = new Set([...losses.keys()].filter(() => randomInt(rng, 0, 4) === 0));
      const queue = createFewestLossQueue(losses);
      const order: number[] = [];
      for (let pick = queue.take(); pick !== undefined; pick = queue.take()) {
        order.push(pick.index);
        if (!refused.has(pick.index)) queue.dropped(pick.loss);
      }
      expect(order, `seed ${seed}`).toEqual(referenceOrder(losses, refused));
    }
  });
});
