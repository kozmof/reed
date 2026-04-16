import { describe, expect, it } from 'vitest';
import type { NodeColor, RBNode } from '../../types/state.ts';
import {
  ensureBlackRoot,
  fixInsertWithPath,
  fixRedViolations,
  isBlack,
  isRed,
  rebalanceAfterInsert,
  rotateLeft,
  rotateRight,
  type InsertionPathEntry,
  type RootToLeafInsertPath,
  type WithNodeFn,
} from './rb-tree.ts';

interface TestNode extends RBNode<TestNode> {
  readonly key: number;
  readonly size: number;
}

function createNode(
  key: number,
  color: NodeColor = 'black',
  left: TestNode | null = null,
  right: TestNode | null = null
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
  if (node.color === 'red') {
    expect(node.left?.color ?? 'black').toBe('black');
    expect(node.right?.color ?? 'black').toBe('black');
  }
  assertNoRedRed(node.left);
  assertNoRedRed(node.right);
}

function assertBlackHeight(node: TestNode | null): number {
  if (node === null) return 1;
  const leftHeight = assertBlackHeight(node.left);
  const rightHeight = assertBlackHeight(node.right);
  expect(leftHeight).toBe(rightHeight);
  return leftHeight + (node.color === 'black' ? 1 : 0);
}

function assertRBTree(root: TestNode): void {
  expect(root.color).toBe('black');
  assertBSTOrder(root, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY);
  assertNoRedRed(root);
  assertBlackHeight(root);
  assertSizes(root);
}

function buildInsertPath(root: TestNode, key: number): RootToLeafInsertPath<TestNode> {
  const insertPath: InsertionPathEntry<TestNode>[] = [];
  const newNode = createNode(key, 'red');

  function insert(node: TestNode): TestNode {
    if (key < node.key) {
      const newLeft = node.left === null ? newNode : insert(node.left);
      const result = withTestNode(node, { left: newLeft });
      insertPath.push({ node: result, direction: 'left' });
      return result;
    }

    const newRight = node.right === null ? newNode : insert(node.right);
    const result = withTestNode(node, { right: newRight });
    insertPath.push({ node: result, direction: 'right' });
    return result;
  }

  insert(root);
  insertPath.reverse();
  return insertPath as RootToLeafInsertPath<TestNode>;
}

function insertWithPath(root: TestNode | null, key: number): TestNode {
  if (root === null) return createNode(key, 'black');
  const insertPath = buildInsertPath(root, key);
  return fixInsertWithPath(insertPath, withTestNode);
}

function insertWithFullFix(root: TestNode | null, key: number): TestNode {
  if (root === null) return createNode(key, 'black');
  // Use the O(log n) path-based fixer (fixInsert was O(n) and is no longer exported).
  return insertWithPath(root, key);
}

describe('RB Tree Utilities', () => {
  describe('isRed / isBlack', () => {
    it('handles null and undefined as black', () => {
      const red = createNode(1, 'red');
      const black = createNode(2, 'black');

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

  describe('rotateLeft', () => {
    it('returns the original node when right child is null', () => {
      const node = createNode(10);
      expect(rotateLeft(node, withTestNode)).toBe(node);
    });

    it('rotates left immutably and preserves in-order keys', () => {
      const a = createNode(1);
      const b = createNode(3);
      const c = createNode(5);
      const right = createNode(4, 'red', b, c);
      const root = createNode(2, 'black', a, right);

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

  describe('rotateRight', () => {
    it('returns the original node when left child is null', () => {
      const node = createNode(10);
      expect(rotateRight(node, withTestNode)).toBe(node);
    });

    it('rotates right immutably and preserves in-order keys', () => {
      const a = createNode(1);
      const b = createNode(3);
      const c = createNode(5);
      const left = createNode(2, 'red', a, b);
      const root = createNode(4, 'black', left, c);

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

  describe('ensureBlackRoot', () => {
    it('converts a red root to black', () => {
      const root = createNode(10, 'red');
      const fixed = ensureBlackRoot(root, withTestNode);

      expect(fixed.color).toBe('black');
      expect(fixed).not.toBe(root);
      expect(root.color).toBe('red');
    });

    it('returns the same node if root is already black', () => {
      const root = createNode(10, 'black');
      expect(ensureBlackRoot(root, withTestNode)).toBe(root);
    });
  });

  describe('fixRedViolations', () => {
    it('returns original node when no violation exists', () => {
      const root = createNode(10, 'black', createNode(5, 'red'), createNode(15, 'black'));
      expect(fixRedViolations(root, withTestNode)).toBe(root);
    });

    it('handles left-left violation', () => {
      const root = createNode(
        10,
        'black',
        createNode(5, 'red', createNode(2, 'red'), null),
        createNode(12, 'black')
      );

      const fixed = fixRedViolations(root, withTestNode);

      expect(fixed.key).toBe(5);
      expect(fixed.color).toBe('black');
      expect(fixed.right?.key).toBe(10);
      expect(fixed.right?.color).toBe('red');
      expect(inOrderKeys(fixed)).toEqual([2, 5, 10, 12]);
      assertNoRedRed(fixed);
      assertSizes(fixed);
    });

    it('handles left-right violation', () => {
      const root = createNode(
        10,
        'black',
        createNode(5, 'red', null, createNode(7, 'red')),
        createNode(12, 'black')
      );

      const fixed = fixRedViolations(root, withTestNode);

      expect(fixed.key).toBe(7);
      expect(fixed.color).toBe('black');
      expect(fixed.left?.key).toBe(5);
      expect(fixed.right?.key).toBe(10);
      expect(fixed.right?.color).toBe('red');
      expect(inOrderKeys(fixed)).toEqual([5, 7, 10, 12]);
      assertNoRedRed(fixed);
      assertSizes(fixed);
    });

    it('handles right-right violation', () => {
      const root = createNode(
        10,
        'black',
        createNode(8, 'black'),
        createNode(15, 'red', null, createNode(18, 'red'))
      );

      const fixed = fixRedViolations(root, withTestNode);

      expect(fixed.key).toBe(15);
      expect(fixed.color).toBe('black');
      expect(fixed.left?.key).toBe(10);
      expect(fixed.left?.color).toBe('red');
      expect(fixed.right?.key).toBe(18);
      expect(inOrderKeys(fixed)).toEqual([8, 10, 15, 18]);
      assertNoRedRed(fixed);
      assertSizes(fixed);
    });

    it('handles right-left violation', () => {
      const root = createNode(
        10,
        'black',
        createNode(8, 'black'),
        createNode(15, 'red', createNode(12, 'red'), null)
      );

      const fixed = fixRedViolations(root, withTestNode);

      expect(fixed.key).toBe(12);
      expect(fixed.color).toBe('black');
      expect(fixed.left?.key).toBe(10);
      expect(fixed.left?.color).toBe('red');
      expect(fixed.right?.key).toBe(15);
      expect(inOrderKeys(fixed)).toEqual([8, 10, 12, 15]);
      assertNoRedRed(fixed);
      assertSizes(fixed);
    });
  });

  describe('rebalanceAfterInsert / ensureBlackRoot', () => {
    it('rebalanceAfterInsert fixes deep subtree violations', () => {
      const root = createNode(
        20,
        'black',
        createNode(
          10,
          'black',
          createNode(5, 'red', createNode(2, 'red'), null),
          createNode(15, 'black')
        ),
        createNode(30, 'black')
      );

      const rebalanced = rebalanceAfterInsert(root, withTestNode);

      expect(inOrderKeys(rebalanced)).toEqual([2, 5, 10, 15, 20, 30]);
      assertNoRedRed(rebalanced);
      assertSizes(rebalanced);
    });

    it('rebalanceAfterInsert does not force a black root', () => {
      const root = createNode(10, 'red', createNode(5, 'black'), createNode(15, 'black'));
      const rebalanced = rebalanceAfterInsert(root, withTestNode);
      expect(rebalanced.color).toBe('red');
    });

    it('ensureBlackRoot enforces a black root after rebalance', () => {
      const root = createNode(10, 'red', createNode(5, 'black'), createNode(15, 'black'));
      // ensureBlackRoot + rebalanceAfterInsert is the equivalent of the removed fixInsert
      const fixed = ensureBlackRoot(rebalanceAfterInsert(root, withTestNode), withTestNode);

      expect(fixed.color).toBe('black');
      expect(inOrderKeys(fixed)).toEqual([5, 10, 15]);
      assertSizes(fixed);
    });

    it('insertWithPath keeps sorted order, subtree sizes, and black root through mixed insertions', () => {
      let root: TestNode | null = null;
      const keys = [10, 5, 15, 2, 7, 12, 20, 1, 3, 6, 8, 11, 13];

      for (const key of keys) {
        root = insertWithFullFix(root, key);
      }

      expect(root).not.toBeNull();
      expect((root as TestNode).color).toBe('black');
      assertSizes(root);
      expect(inOrderKeys(root)).toEqual([...keys].sort((a, b) => a - b));
    });
  });

  describe('fixInsertWithPath', () => {
    it('rotates at an ancestor after a lower color-flip propagation', () => {
      const insertedLeaf = createNode(1, 'red');
      const leafParent = createNode(5, 'red', insertedLeaf, null);
      const uncle = createNode(15, 'red');
      const grandparent = createNode(10, 'black', leafParent, uncle);

      const parent = createNode(20, 'red', grandparent, createNode(30, 'black'));
      const root = createNode(40, 'black', parent, createNode(60, 'black'));

      const path = [
        { node: root, direction: 'left' },
        { node: parent, direction: 'left' },
        { node: grandparent, direction: 'left' },
        { node: leafParent, direction: 'left' },
      ] as RootToLeafInsertPath<TestNode>;

      const fixed = fixInsertWithPath(path, withTestNode);

      // The final rotation happens at the former root (40), so 20 becomes root.
      expect(fixed.key).toBe(20);
      expect(fixed.right?.key).toBe(40);
      expect(inOrderKeys(fixed)).toEqual([1, 5, 10, 15, 20, 30, 40, 60]);
      assertRBTree(fixed);
    });

    it('synchronizes parent child references when lower fix rewrites subtree root', () => {
      const root = createNode(
        10,
        'black',
        createNode(
          5,
          'black',
          createNode(2, 'red', createNode(1, 'red'), null),
          createNode(7, 'black')
        ),
        createNode(15, 'black')
      );

      const path = [
        { node: root, direction: 'left' },
        { node: root.left as TestNode, direction: 'left' },
        { node: root.left!.left as TestNode, direction: 'left' },
      ] as RootToLeafInsertPath<TestNode>;

      const fixed = fixInsertWithPath(path, withTestNode);

      expect(fixed.left?.key).toBe(2);
      expect(fixed.left?.right?.key).toBe(5);
      expect(inOrderKeys(fixed)).toEqual([1, 2, 5, 7, 10, 15]);
      assertSizes(fixed);
    });

    it('handles color-flip case and still returns black root', () => {
      const root = createNode(
        10,
        'black',
        createNode(5, 'red', createNode(2, 'red'), null),
        createNode(15, 'red')
      );

      const fixed = fixInsertWithPath([{ node: root, direction: 'left' }] as RootToLeafInsertPath<TestNode>, withTestNode);

      expect(fixed.color).toBe('black');
      expect(fixed.left?.color).toBe('black');
      expect(fixed.right?.color).toBe('black');
      expect(inOrderKeys(fixed)).toEqual([2, 5, 10, 15]);
      assertRBTree(fixed);
    });

    it('maintains RB invariants for adversarial insertion orders', () => {
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
