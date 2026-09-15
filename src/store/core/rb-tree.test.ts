import { describe, expect, it } from "vitest";
import type { NodeColor, RBNode } from "../../types/state.js";
import {
  blackHeight,
  ensureBlackRoot,
  fixInsertWithPath,
  fixRedViolations,
  isBlack,
  isRed,
  joinBalanced,
  joinTrees,
  removeMinimum,
  removeNodeWithAtMostOneChild,
  repairLeftBlackDeficit,
  repairRightBlackDeficit,
  rotateLeft,
  rotateRight,
  type InsertionPathEntry,
  type RootToLeafInsertPath,
  type WithNodeFn,
} from "./rb-tree.js";

interface TestNode extends RBNode<TestNode> {
  readonly key: number;
  readonly size: number;
}

function createNode(
  key: number,
  color: NodeColor = "black",
  left: TestNode | null = null,
  right: TestNode | null = null,
): TestNode {
  return Object.freeze({
    key,
    color,
    left,
    right,
    size: 1 + (left?.size ?? 0) + (right?.size ?? 0),
  });
}

const withTestNode: WithNodeFn<TestNode> = (node, updates) => {
  const next = { ...node, ...updates };
  return Object.freeze({
    ...next,
    size: 1 + (next.left?.size ?? 0) + (next.right?.size ?? 0),
  });
};

function inOrderKeys(node: TestNode | null): number[] {
  if (node === null) return [];
  return [...inOrderKeys(node.left), node.key, ...inOrderKeys(node.right)];
}

function assertSizes(node: TestNode | null): number {
  if (node === null) return 0;
  const leftSize = assertSizes(node.left);
  const rightSize = assertSizes(node.right);
  expect(node.size).toBe(1 + leftSize + rightSize);
  return node.size;
}

function assertBSTOrder(node: TestNode | null, min: number, max: number): void {
  if (node === null) return;
  expect(node.key).toBeGreaterThan(min);
  expect(node.key).toBeLessThan(max);
  assertBSTOrder(node.left, min, node.key);
  assertBSTOrder(node.right, node.key, max);
}

function assertNoRedRed(node: TestNode | null): void {
  if (node === null) return;
  if (node.color === "red") {
    expect(node.left?.color ?? "black").toBe("black");
    expect(node.right?.color ?? "black").toBe("black");
  }
  assertNoRedRed(node.left);
  assertNoRedRed(node.right);
}

function assertBlackHeight(node: TestNode | null): number {
  if (node === null) return 1;
  const leftHeight = assertBlackHeight(node.left);
  const rightHeight = assertBlackHeight(node.right);
  expect(leftHeight).toBe(rightHeight);
  return leftHeight + (node.color === "black" ? 1 : 0);
}

function assertRBTree(root: TestNode): void {
  expect(root.color).toBe("black");
  assertBSTOrder(root, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY);
  assertNoRedRed(root);
  assertBlackHeight(root);
  assertSizes(root);
}

function buildInsertPath(root: TestNode, key: number): RootToLeafInsertPath<TestNode> {
  const insertPath: InsertionPathEntry<TestNode>[] = [];
  const newNode = createNode(key, "red");

  function insert(node: TestNode): TestNode {
    if (key < node.key) {
      const newLeft = node.left === null ? newNode : insert(node.left);
      const result = withTestNode(node, { left: newLeft });
      insertPath.push({ node: result, direction: "left" });
      return result;
    }

    const newRight = node.right === null ? newNode : insert(node.right);
    const result = withTestNode(node, { right: newRight });
    insertPath.push({ node: result, direction: "right" });
    return result;
  }

  insert(root);
  insertPath.reverse();
  return insertPath as RootToLeafInsertPath<TestNode>;
}

function insertWithPath(root: TestNode | null, key: number): TestNode {
  if (root === null) return createNode(key, "black");
  const insertPath = buildInsertPath(root, key);
  return fixInsertWithPath(insertPath, withTestNode);
}

function insertWithFullFix(root: TestNode | null, key: number): TestNode {
  if (root === null) return createNode(key, "black");
  // Use the O(log n) path-based fixer (fixInsert was O(n) and is no longer exported).
  return insertWithPath(root, key);
}

describe("RB Tree Utilities", () => {
  describe("isRed / isBlack", () => {
    it("handles null and undefined as black", () => {
      const red = createNode(1, "red");
      const black = createNode(2, "black");

      expect(isRed(red)).toBe(true);
      expect(isRed(black)).toBe(false);
      expect(isRed(null)).toBe(false);
      expect(isRed(undefined)).toBe(false);

      expect(isBlack(red)).toBe(false);
      expect(isBlack(black)).toBe(true);
      expect(isBlack(null)).toBe(true);
      expect(isBlack(undefined)).toBe(true);
    });
  });

  describe("rotateLeft", () => {
    it("returns the original node when right child is null", () => {
      const node = createNode(10);
      expect(rotateLeft(node, withTestNode)).toBe(node);
    });

    it("rotates left immutably and preserves in-order keys", () => {
      const a = createNode(1);
      const b = createNode(3);
      const c = createNode(5);
      const right = createNode(4, "red", b, c);
      const root = createNode(2, "black", a, right);

      const rotated = rotateLeft(root, withTestNode);

      expect(rotated.key).toBe(4);
      expect(rotated.left?.key).toBe(2);
      expect(rotated.left?.right?.key).toBe(3);
      expect(rotated.right?.key).toBe(5);
      expect(inOrderKeys(rotated)).toEqual([1, 2, 3, 4, 5]);
      expect(rotated).not.toBe(root);
      expect(root.right).toBe(right);
      assertSizes(rotated);
    });
  });

  describe("rotateRight", () => {
    it("returns the original node when left child is null", () => {
      const node = createNode(10);
      expect(rotateRight(node, withTestNode)).toBe(node);
    });

    it("rotates right immutably and preserves in-order keys", () => {
      const a = createNode(1);
      const b = createNode(3);
      const c = createNode(5);
      const left = createNode(2, "red", a, b);
      const root = createNode(4, "black", left, c);

      const rotated = rotateRight(root, withTestNode);

      expect(rotated.key).toBe(2);
      expect(rotated.left?.key).toBe(1);
      expect(rotated.right?.key).toBe(4);
      expect(rotated.right?.left?.key).toBe(3);
      expect(inOrderKeys(rotated)).toEqual([1, 2, 3, 4, 5]);
      expect(rotated).not.toBe(root);
      expect(root.left).toBe(left);
      assertSizes(rotated);
    });
  });

  describe("ensureBlackRoot", () => {
    it("converts a red root to black", () => {
      const root = createNode(10, "red");
      const fixed = ensureBlackRoot(root, withTestNode);

      expect(fixed.color).toBe("black");
      expect(fixed).not.toBe(root);
      expect(root.color).toBe("red");
    });

    it("returns the same node if root is already black", () => {
      const root = createNode(10, "black");
      expect(ensureBlackRoot(root, withTestNode)).toBe(root);
    });
  });

  describe("fixRedViolations", () => {
    it("returns original node when no violation exists", () => {
      const root = createNode(10, "black", createNode(5, "red"), createNode(15, "black"));
      expect(fixRedViolations(root, withTestNode)).toBe(root);
    });

    it("handles left-left violation", () => {
      const root = createNode(
        10,
        "black",
        createNode(5, "red", createNode(2, "red"), null),
        createNode(12, "black"),
      );

      const fixed = fixRedViolations(root, withTestNode);

      expect(fixed.key).toBe(5);
      expect(fixed.color).toBe("black");
      expect(fixed.right?.key).toBe(10);
      expect(fixed.right?.color).toBe("red");
      expect(inOrderKeys(fixed)).toEqual([2, 5, 10, 12]);
      assertNoRedRed(fixed);
      assertSizes(fixed);
    });

    it("handles left-right violation", () => {
      const root = createNode(
        10,
        "black",
        createNode(5, "red", null, createNode(7, "red")),
        createNode(12, "black"),
      );

      const fixed = fixRedViolations(root, withTestNode);

      expect(fixed.key).toBe(7);
      expect(fixed.color).toBe("black");
      expect(fixed.left?.key).toBe(5);
      expect(fixed.right?.key).toBe(10);
      expect(fixed.right?.color).toBe("red");
      expect(inOrderKeys(fixed)).toEqual([5, 7, 10, 12]);
      assertNoRedRed(fixed);
      assertSizes(fixed);
    });

    it("handles right-right violation", () => {
      const root = createNode(
        10,
        "black",
        createNode(8, "black"),
        createNode(15, "red", null, createNode(18, "red")),
      );

      const fixed = fixRedViolations(root, withTestNode);

      expect(fixed.key).toBe(15);
      expect(fixed.color).toBe("black");
      expect(fixed.left?.key).toBe(10);
      expect(fixed.left?.color).toBe("red");
      expect(fixed.right?.key).toBe(18);
      expect(inOrderKeys(fixed)).toEqual([8, 10, 15, 18]);
      assertNoRedRed(fixed);
      assertSizes(fixed);
    });

    it("handles right-left violation", () => {
      const root = createNode(
        10,
        "black",
        createNode(8, "black"),
        createNode(15, "red", createNode(12, "red"), null),
      );

      const fixed = fixRedViolations(root, withTestNode);

      expect(fixed.key).toBe(12);
      expect(fixed.color).toBe("black");
      expect(fixed.left?.key).toBe(10);
      expect(fixed.left?.color).toBe("red");
      expect(fixed.right?.key).toBe(15);
      expect(inOrderKeys(fixed)).toEqual([8, 10, 12, 15]);
      assertNoRedRed(fixed);
      assertSizes(fixed);
    });
  });

  describe("ensureBlackRoot", () => {
    it("ensureBlackRoot enforces a black root on a red node", () => {
      const root = createNode(10, "red", createNode(5, "black"), createNode(15, "black"));
      const fixed = ensureBlackRoot(root, withTestNode);

      expect(fixed.color).toBe("black");
      expect(inOrderKeys(fixed)).toEqual([5, 10, 15]);
      assertSizes(fixed);
    });

    it("insertWithPath keeps sorted order, subtree sizes, and black root through mixed insertions", () => {
      let root: TestNode | null = null;
      const keys = [10, 5, 15, 2, 7, 12, 20, 1, 3, 6, 8, 11, 13];

      for (const key of keys) {
        root = insertWithFullFix(root, key);
      }

      expect(root).not.toBeNull();
      expect((root as TestNode).color).toBe("black");
      assertSizes(root);
      expect(inOrderKeys(root)).toEqual([...keys].sort((a, b) => a - b));
    });
  });

  describe("fixInsertWithPath", () => {
    it("rotates at an ancestor after a lower color-flip propagation", () => {
      const insertedLeaf = createNode(1, "red");
      const leafParent = createNode(5, "red", insertedLeaf, null);
      const uncle = createNode(15, "red");
      const grandparent = createNode(10, "black", leafParent, uncle);

      const parent = createNode(20, "red", grandparent, createNode(30, "black"));
      const root = createNode(40, "black", parent, createNode(60, "black"));

      const path = [
        { node: root, direction: "left" },
        { node: parent, direction: "left" },
        { node: grandparent, direction: "left" },
        { node: leafParent, direction: "left" },
      ] as RootToLeafInsertPath<TestNode>;

      const fixed = fixInsertWithPath(path, withTestNode);

      // The final rotation happens at the former root (40), so 20 becomes root.
      expect(fixed.key).toBe(20);
      expect(fixed.right?.key).toBe(40);
      expect(inOrderKeys(fixed)).toEqual([1, 5, 10, 15, 20, 30, 40, 60]);
      assertRBTree(fixed);
    });

    it("synchronizes parent child references when lower fix rewrites subtree root", () => {
      const root = createNode(
        10,
        "black",
        createNode(
          5,
          "black",
          createNode(2, "red", createNode(1, "red"), null),
          createNode(7, "black"),
        ),
        createNode(15, "black"),
      );

      const path = [
        { node: root, direction: "left" },
        { node: root.left as TestNode, direction: "left" },
        { node: root.left!.left as TestNode, direction: "left" },
      ] as RootToLeafInsertPath<TestNode>;

      const fixed = fixInsertWithPath(path, withTestNode);

      expect(fixed.left?.key).toBe(2);
      expect(fixed.left?.right?.key).toBe(5);
      expect(inOrderKeys(fixed)).toEqual([1, 2, 5, 7, 10, 15]);
      assertSizes(fixed);
    });

    it("handles color-flip case and still returns black root", () => {
      const root = createNode(
        10,
        "black",
        createNode(5, "red", createNode(2, "red"), null),
        createNode(15, "red"),
      );

      const fixed = fixInsertWithPath(
        [{ node: root, direction: "left" }] as RootToLeafInsertPath<TestNode>,
        withTestNode,
      );

      expect(fixed.color).toBe("black");
      expect(fixed.left?.color).toBe("black");
      expect(fixed.right?.color).toBe("black");
      expect(inOrderKeys(fixed)).toEqual([2, 5, 10, 15]);
      assertRBTree(fixed);
    });

    it("maintains RB invariants for adversarial insertion orders", () => {
      const sequences: number[][] = [
        Array.from({ length: 40 }, (_, i) => i + 1),
        Array.from({ length: 40 }, (_, i) => 40 - i),
        [20, 10, 30, 5, 15, 25, 35, 1, 8, 12, 18, 22, 28, 32, 38, 3, 6, 11, 14, 17, 19],
      ];

      for (const keys of sequences) {
        let root: TestNode | null = null;
        for (const key of keys) {
          root = insertWithPath(root, key);
          assertRBTree(root);
        }

        expect(root).not.toBeNull();
        expect(inOrderKeys(root)).toEqual([...keys].sort((a, b) => a - b));
      }
    });
  });
});

// =============================================================================
// Persistent deletion and rank-based join
// =============================================================================

/**
 * Assert every structural property a subtree must satisfy. `rootMustBeBlack` is
 * false for join intermediates, which are allowed to hand back a red root.
 */
function assertWellFormed(root: TestNode | null, context: string, rootMustBeBlack = true): void {
  if (root === null) return;
  if (rootMustBeBlack) expect(root.color, `${context}: root colour`).toBe("black");
  assertBSTOrder(root, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY);
  assertNoRedRed(root);
  assertBlackHeight(root);
  assertSizes(root);
  assertFrozen(root, context);
}

function assertFrozen(node: TestNode | null, context: string): void {
  if (node === null) return;
  expect(Object.isFrozen(node), `${context}: node ${node.key} frozen`).toBe(true);
  assertFrozen(node.left, context);
  assertFrozen(node.right, context);
}

function buildTree(keys: readonly number[]): TestNode | null {
  let root: TestNode | null = null;
  for (const key of keys) root = insertWithPath(root, key);
  return root;
}

/** Every permutation of `keys`, so trees of every reachable shape are covered. */
function permutations(keys: readonly number[]): number[][] {
  if (keys.length <= 1) return [[...keys]];
  const result: number[][] = [];
  keys.forEach((key, index) => {
    const rest = [...keys.slice(0, index), ...keys.slice(index + 1)];
    for (const tail of permutations(rest)) result.push([key, ...tail]);
  });
  return result;
}

describe("blackHeight", () => {
  it("counts the null terminator as one black level", () => {
    expect(blackHeight<TestNode>(null)).toBe(1);
    expect(blackHeight(createNode(1, "black"))).toBe(2);
    expect(blackHeight(createNode(1, "red"))).toBe(1);
  });

  it("agrees with the height measured down every spine of a built tree", () => {
    for (const size of [1, 2, 3, 7, 15, 31]) {
      const root = buildTree(Array.from({ length: size }, (_, i) => i + 1))!;
      // assertBlackHeight walks every path and fails unless they all agree.
      expect(assertBlackHeight(root)).toBe(blackHeight(root));
    }
  });
});

describe("black-deficit repair", () => {
  // Each fixture builds a parent whose LEFT subtree is one black level short of
  // its right, which is exactly the state a black removal leaves behind.
  it("rotates a red sibling and repairs beneath it", () => {
    const sibling = createNode(5, "red", createNode(4, "black"), createNode(6, "black"));
    const parent = createNode(3, "black", null, sibling);

    const repaired = repairLeftBlackDeficit(parent, withTestNode);

    expect(inOrderKeys(repaired.node)).toEqual([3, 4, 5, 6]);
    assertWellFormed(repaired.node, "red sibling", false);
  });

  it("absorbs the deficit into a red parent", () => {
    const parent = createNode(3, "red", null, createNode(5, "black"));

    const repaired = repairLeftBlackDeficit(parent, withTestNode);

    expect(repaired.blackHeightDecreased, "red parent absorbs the deficit").toBe(false);
    expect(inOrderKeys(repaired.node)).toEqual([3, 5]);
    assertWellFormed(repaired.node, "red parent", false);
  });

  it("propagates the deficit past a black parent with a black sibling", () => {
    const parent = createNode(3, "black", null, createNode(5, "black"));

    const repaired = repairLeftBlackDeficit(parent, withTestNode);

    expect(repaired.blackHeightDecreased, "deficit must propagate upward").toBe(true);
    expect(inOrderKeys(repaired.node)).toEqual([3, 5]);
    assertNoRedRed(repaired.node);
  });

  it("normalises a near-red nephew into the far-red case", () => {
    const sibling = createNode(6, "black", createNode(5, "red"), null);
    const parent = createNode(3, "black", null, sibling);

    const repaired = repairLeftBlackDeficit(parent, withTestNode);

    expect(repaired.blackHeightDecreased, "near-red nephew terminates the repair").toBe(false);
    expect(inOrderKeys(repaired.node)).toEqual([3, 5, 6]);
    assertWellFormed(repaired.node, "near-red nephew", false);
  });

  it("terminates on a far-red nephew with a single rotation", () => {
    const sibling = createNode(5, "black", null, createNode(6, "red"));
    const parent = createNode(3, "black", null, sibling);

    const repaired = repairLeftBlackDeficit(parent, withTestNode);

    expect(repaired.blackHeightDecreased, "far-red nephew terminates the repair").toBe(false);
    expect(inOrderKeys(repaired.node)).toEqual([3, 5, 6]);
    assertWellFormed(repaired.node, "far-red nephew", false);
  });

  it("mirrors every case for a right-side deficit", () => {
    const cases: Array<[string, TestNode, boolean]> = [
      [
        "red sibling",
        createNode(
          7,
          "black",
          createNode(5, "red", createNode(4, "black"), createNode(6, "black")),
          null,
        ),
        false,
      ],
      ["red parent", createNode(7, "red", createNode(5, "black"), null), false],
      ["black parent", createNode(7, "black", createNode(5, "black"), null), true],
      [
        "near-red nephew",
        createNode(7, "black", createNode(5, "black", null, createNode(6, "red")), null),
        false,
      ],
      [
        "far-red nephew",
        createNode(7, "black", createNode(6, "black", createNode(5, "red"), null), null),
        false,
      ],
    ];

    for (const [name, parent, expectPropagation] of cases) {
      const repaired = repairRightBlackDeficit(parent, withTestNode);
      const keys = inOrderKeys(repaired.node);
      expect(keys, `${name}: order`).toEqual([...keys].sort((a, b) => a - b));
      expect(repaired.blackHeightDecreased, `${name}: propagation`).toBe(expectPropagation);
      assertNoRedRed(repaired.node);
      if (!expectPropagation) assertWellFormed(repaired.node, name, false);
    }
  });
});

describe("removeNodeWithAtMostOneChild", () => {
  it("removes a red leaf without a deficit", () => {
    const result = removeNodeWithAtMostOneChild(createNode(1, "red"), withTestNode);
    expect(result).toEqual({ node: null, blackHeightDecreased: false });
  });

  it("repaints a red child black in place of a black parent", () => {
    const node = createNode(2, "black", createNode(1, "red"), null);
    const result = removeNodeWithAtMostOneChild(node, withTestNode);
    expect(result.blackHeightDecreased, "red child covers the black level").toBe(false);
    expect(result.node?.key).toBe(1);
    expect(result.node?.color).toBe("black");
  });

  it("reports a deficit when a black leaf is removed", () => {
    const result = removeNodeWithAtMostOneChild(createNode(1, "black"), withTestNode);
    expect(result).toEqual({ node: null, blackHeightDecreased: true });
  });
});

describe("removeMinimum", () => {
  it("drains every tree shape from the left while staying well formed", () => {
    for (const permutation of permutations([1, 2, 3, 4, 5])) {
      let root = buildTree(permutation);
      const drained: number[] = [];

      while (root !== null) {
        const context = `keys=${permutation.join(",")} remaining=${inOrderKeys(root).join(",")}`;
        const extracted = removeMinimum(root, withTestNode);
        drained.push(extracted.minimum.key);

        root = extracted.node === null ? null : ensureBlackRoot(extracted.node, withTestNode);
        assertWellFormed(root, context);
      }

      expect(drained, `keys=${permutation.join(",")}`).toEqual([1, 2, 3, 4, 5]);
    }
  });

  it("keeps larger trees balanced as they drain", () => {
    let root = buildTree(Array.from({ length: 200 }, (_, i) => i + 1));
    for (let expected = 1; expected <= 200; expected++) {
      const extracted = removeMinimum(root!, withTestNode);
      expect(extracted.minimum.key).toBe(expected);
      root = extracted.node === null ? null : ensureBlackRoot(extracted.node, withTestNode);
      assertWellFormed(root, `drain at ${expected}`);
    }
    expect(root).toBeNull();
  });
});

describe("joinBalanced", () => {
  // Cover every black-height relation: taller left, taller right, and equal.
  it("joins trees of every size combination", () => {
    for (let leftSize = 0; leftSize <= 20; leftSize++) {
      for (let rightSize = 0; rightSize <= 20; rightSize++) {
        const left = buildTree(Array.from({ length: leftSize }, (_, i) => i + 1));
        const key = createNode(leftSize + 1, "black");
        const right = buildTree(Array.from({ length: rightSize }, (_, i) => leftSize + 2 + i));

        const context = `join ${leftSize}+1+${rightSize}`;
        const joined = ensureBlackRoot(joinBalanced(left, key, right, withTestNode), withTestNode);

        assertWellFormed(joined, context);
        expect(inOrderKeys(joined), context).toEqual(
          Array.from({ length: leftSize + 1 + rightSize }, (_, i) => i + 1),
        );
      }
    }
  });

  it("does not inflate height when joining a tall tree to a short one", () => {
    const left = buildTree(Array.from({ length: 1000 }, (_, i) => i + 1))!;
    const key = createNode(1001, "black");
    const right = buildTree([1002, 1003]);

    const joined = ensureBlackRoot(joinBalanced(left, key, right, withTestNode), withTestNode);

    assertWellFormed(joined, "tall + short");
    expect(joined.size).toBe(1003);
    // A red-black tree of 1003 nodes is at most 2*log2(1004) deep.
    const height = (function measure(node: TestNode | null): number {
      return node === null ? 0 : 1 + Math.max(measure(node.left), measure(node.right));
    })(joined);
    expect(height).toBeLessThanOrEqual(Math.floor(2 * Math.log2(1004)));
  });
});

describe("joinTrees", () => {
  it("concatenates every size combination without a middle key", () => {
    for (let leftSize = 0; leftSize <= 16; leftSize++) {
      for (let rightSize = 0; rightSize <= 16; rightSize++) {
        const left = buildTree(Array.from({ length: leftSize }, (_, i) => i + 1));
        const right = buildTree(Array.from({ length: rightSize }, (_, i) => leftSize + 1 + i));

        const context = `concat ${leftSize}+${rightSize}`;
        const raw = joinTrees(left, right, withTestNode);
        const joined = raw === null ? null : ensureBlackRoot(raw, withTestNode);

        assertWellFormed(joined, context);
        expect(inOrderKeys(joined), context).toEqual(
          Array.from({ length: leftSize + rightSize }, (_, i) => i + 1),
        );
      }
    }
  });

  it("survives repeated split-free concatenation", () => {
    // Repeatedly peel the minimum off and re-attach it, which exercises
    // removeMinimum and joinBalanced against each other many times over.
    let root = buildTree(Array.from({ length: 120 }, (_, i) => i + 1));
    for (let round = 0; round < 120; round++) {
      const extracted = removeMinimum(root!, withTestNode);
      const rest = extracted.node;
      const rebuilt = joinBalanced(null, extracted.minimum, rest, withTestNode);
      root = ensureBlackRoot(rebuilt, withTestNode);
      assertWellFormed(root, `round ${round}`);
      expect(inOrderKeys(root).length).toBe(120);
    }
  });
});

describe("structural sharing", () => {
  /** Count nodes reachable from `root` that are not present in `original`. */
  function countFreshNodes(root: TestNode | null, original: TestNode | null): number {
    const seen = new Set<TestNode>();
    (function collect(node: TestNode | null): void {
      if (node === null) return;
      seen.add(node);
      collect(node.left);
      collect(node.right);
    })(original);

    let fresh = 0;
    (function walk(node: TestNode | null): void {
      if (node === null) return;
      if (!seen.has(node)) fresh++;
      walk(node.left);
      walk(node.right);
    })(root);
    return fresh;
  }

  it("copies only the path a join touches", () => {
    const left = buildTree(Array.from({ length: 1000 }, (_, i) => i + 1))!;
    const key = createNode(1001, "black");
    const right = buildTree([1002]);

    const joined = ensureBlackRoot(joinBalanced(left, key, right, withTestNode), withTestNode);

    // A join that rebuilt the tree would create ~1000 nodes; a path copy creates
    // a number bounded by the tree's height.
    const fresh = countFreshNodes(joined, left);
    expect(fresh, `join copied ${fresh} nodes from a 1000-node tree`).toBeLessThanOrEqual(
      2 * Math.floor(2 * Math.log2(1001)),
    );
  });

  it("copies only the left spine when removing the minimum", () => {
    const root = buildTree(Array.from({ length: 1000 }, (_, i) => i + 1))!;

    const extracted = removeMinimum(root, withTestNode);
    const rest = ensureBlackRoot(extracted.node!, withTestNode);

    const fresh = countFreshNodes(rest, root);
    expect(fresh, `removeMinimum copied ${fresh} nodes from a 1000-node tree`).toBeLessThanOrEqual(
      2 * Math.floor(2 * Math.log2(1001)),
    );
  });

  it("leaves the original tree untouched", () => {
    const original = buildTree(Array.from({ length: 63 }, (_, i) => i + 1))!;
    const before = inOrderKeys(original);

    removeMinimum(original, withTestNode);
    joinBalanced(original, createNode(64, "black"), null, withTestNode);

    expect(inOrderKeys(original), "snapshot is immutable").toEqual(before);
    assertWellFormed(original, "original after derived operations");
  });
});
