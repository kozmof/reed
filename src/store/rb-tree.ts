/**
 * Generic Red-Black tree utilities.
 * Provides immutable balancing operations for any R-B tree node type.
 */

import type { NodeColor, RBNode } from '../types/state.ts';

// Re-export RBNode for consumers that import from rb-tree
export type { RBNode };

// =============================================================================
// Types
// =============================================================================

/**
 * Function type for creating a new node with updated properties.
 * Each concrete node type provides its own implementation that handles
 * recalculating aggregate values (subtreeLength, subtreeLineCount, etc).
 */
export type WithNodeFn<N extends RBNode<N>> = (
  node: N,
  updates: Partial<{ color: NodeColor; left: N | null; right: N | null }>
) => N;

// =============================================================================
// Color Utilities
// =============================================================================

/**
 * Check if a node is red.
 * Returns false for null/undefined nodes (they're treated as black).
 */
export function isRed<N extends RBNode<N>>(node: N | null | undefined): boolean {
  return node != null && node.color === 'red';
}

/**
 * Check if a node is black.
 * Null nodes are considered black.
 */
export function isBlack<N extends RBNode<N>>(node: N | null | undefined): boolean {
  return node == null || node.color === 'black';
}

// =============================================================================
// Rotations
// =============================================================================

/**
 * Rotate left at the given node. Returns the new subtree root.
 * Immutable - creates new nodes using the provided withNode function.
 *
 *       x                y
 *      / \              / \
 *     a   y    =>      x   c
 *        / \          / \
 *       b   c        a   b
 */
export function rotateLeft<N extends RBNode<N>>(
  node: N,
  withNode: WithNodeFn<N>
): N {
  const right = node.right as N | null;
  if (right === null) return node;

  const newNode = withNode(node, {
    right: right.left as N | null,
  });

  return withNode(right, {
    left: newNode,
  });
}

/**
 * Rotate right at the given node. Returns the new subtree root.
 * Immutable - creates new nodes using the provided withNode function.
 *
 *         y            x
 *        / \          / \
 *       x   c   =>   a   y
 *      / \              / \
 *     a   b            b   c
 */
export function rotateRight<N extends RBNode<N>>(
  node: N,
  withNode: WithNodeFn<N>
): N {
  const left = node.left as N | null;
  if (left === null) return node;

  const newNode = withNode(node, {
    left: left.right as N | null,
  });

  return withNode(left, {
    right: newNode,
  });
}

// =============================================================================
// Balancing
// =============================================================================

/**
 * Ensure the root is black.
 */
export function ensureBlackRoot<N extends RBNode<N>>(
  node: N,
  withNode: WithNodeFn<N>
): N {
  if (node.color === 'red') {
    return withNode(node, { color: 'black' });
  }
  return node;
}

/**
 * Fix red-red violations at a node.
 * Implements the four rotation cases of Red-Black tree balancing.
 */
export function fixRedViolations<N extends RBNode<N>>(
  node: N,
  withNode: WithNodeFn<N>
): N {
  let result = node;

  // Case 1: Left-Left (right rotation)
  if (isRed(result.left) && isRed(result.left?.left)) {
    result = rotateRight(result, withNode);
    result = withNode(result, {
      color: 'black',
      right: result.right ? withNode(result.right as N, { color: 'red' }) : null,
    });
  }
  // Case 2: Left-Right (left-right rotation)
  else if (isRed(result.left) && isRed(result.left?.right)) {
    const newLeft = rotateLeft(result.left as N, withNode);
    result = withNode(result, { left: newLeft });
    result = rotateRight(result, withNode);
    result = withNode(result, {
      color: 'black',
      right: result.right ? withNode(result.right as N, { color: 'red' }) : null,
    });
  }
  // Case 3: Right-Right (left rotation)
  else if (isRed(result.right) && isRed(result.right?.right)) {
    result = rotateLeft(result, withNode);
    result = withNode(result, {
      color: 'black',
      left: result.left ? withNode(result.left as N, { color: 'red' }) : null,
    });
  }
  // Case 4: Right-Left (right-left rotation)
  else if (isRed(result.right) && isRed(result.right?.left)) {
    const newRight = rotateRight(result.right as N, withNode);
    result = withNode(result, { right: newRight });
    result = rotateLeft(result, withNode);
    result = withNode(result, {
      color: 'black',
      left: result.left ? withNode(result.left as N, { color: 'red' }) : null,
    });
  }

  return result;
}

/**
 * Rebalance tree after insert to fix red-red violations.
 * Recursively fixes violations from leaves up to root.
 */
export function rebalanceAfterInsert<N extends RBNode<N>>(
  node: N,
  withNode: WithNodeFn<N>
): N {
  // Fix left subtree first
  let newLeft = node.left as N | null;
  if (newLeft !== null) {
    newLeft = rebalanceAfterInsert(newLeft, withNode);
  }

  // Fix right subtree
  let newRight = node.right as N | null;
  if (newRight !== null) {
    newRight = rebalanceAfterInsert(newRight, withNode);
  }

  let result = node;
  if (newLeft !== node.left || newRight !== node.right) {
    result = withNode(node, { left: newLeft, right: newRight });
  }

  // Check for red-red violations and fix
  return fixRedViolations(result, withNode);
}

/**
 * Complete rebalancing after insert: rebalance and ensure black root.
 * Note: This traverses the entire tree — O(n). Prefer fixInsertWithPath for O(log n).
 */
export function fixInsert<N extends RBNode<N>>(
  root: N,
  withNode: WithNodeFn<N>
): N {
  return ensureBlackRoot(rebalanceAfterInsert(root, withNode), withNode);
}

// =============================================================================
// Path-based Insert Fix (O(log n))
// =============================================================================

/**
 * An entry in the insertion path: a newly-created node and the direction
 * we descended from it to reach the next node in the path.
 */
export interface InsertionPathEntry<N extends RBNode<N>> {
  node: N;
  direction: 'left' | 'right';
}

/**
 * Fix a red-red violation at a node during insertion.
 * Unlike fixRedViolations (which only rotates), this also handles
 * the color-flip case when both children are red (uncle-red case).
 *
 * Returns the fixed node and whether the violation may propagate upward
 * (true for color flips where the node becomes red).
 */
function fixInsertViolation<N extends RBNode<N>>(
  node: N,
  withNode: WithNodeFn<N>
): { fixed: N; propagate: boolean } {
  const leftRed = isRed(node.left);
  const rightRed = isRed(node.right);

  const hasLeftViolation = leftRed && (isRed((node.left as N)?.left) || isRed((node.left as N)?.right));
  const hasRightViolation = rightRed && (isRed((node.right as N)?.right) || isRed((node.right as N)?.left));

  if (!hasLeftViolation && !hasRightViolation) {
    return { fixed: node, propagate: false };
  }

  // Both children red: color flip (uncle-red case in standard RB insertion)
  if (leftRed && rightRed) {
    return {
      fixed: withNode(node, {
        color: 'red' as NodeColor,
        left: withNode(node.left as N, { color: 'black' }),
        right: withNode(node.right as N, { color: 'black' }),
      }),
      propagate: true,
    };
  }

  // Uncle is black: rotation (terminal — subtree root becomes black)
  return { fixed: fixRedViolations(node, withNode), propagate: false };
}

/**
 * Fix Red-Black violations after insert using only the insertion path.
 * Walks from the leaf-parent to the root, syncing child references and
 * applying fix-up (color flips or rotations) at each level.
 * O(log n) since the path length is bounded by tree height.
 *
 * @param insertPath - Array of new nodes from root (index 0) to leaf-parent (last index),
 *                     each annotated with the direction taken to reach the next level.
 * @param withNode - Function to create new nodes with updated properties.
 * @returns The balanced root node.
 */
export function fixInsertWithPath<N extends RBNode<N>>(
  insertPath: InsertionPathEntry<N>[],
  withNode: WithNodeFn<N>
): N {
  for (let i = insertPath.length - 1; i >= 0; i--) {
    // Sync: if the child below was modified, update this node's reference to it
    if (i < insertPath.length - 1) {
      const childBelow = insertPath[i + 1].node;
      const dir = insertPath[i].direction;
      const myChild = dir === 'left' ? insertPath[i].node.left : insertPath[i].node.right;
      if (myChild !== childBelow) {
        insertPath[i].node = dir === 'left'
          ? withNode(insertPath[i].node, { left: childBelow })
          : withNode(insertPath[i].node, { right: childBelow });
      }
    }

    const { fixed } = fixInsertViolation(insertPath[i].node, withNode);
    insertPath[i].node = fixed;
  }

  return ensureBlackRoot(insertPath[0].node, withNode);
}
