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
export type WithNodeFn<N extends RBNode> = (
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
export function isRed<N extends RBNode>(node: N | null | undefined): boolean {
  return node != null && node.color === 'red';
}

/**
 * Check if a node is black.
 * Null nodes are considered black.
 */
export function isBlack<N extends RBNode>(node: N | null | undefined): boolean {
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
export function rotateLeft<N extends RBNode>(
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
export function rotateRight<N extends RBNode>(
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
export function ensureBlackRoot<N extends RBNode>(
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
export function fixRedViolations<N extends RBNode>(
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
export function rebalanceAfterInsert<N extends RBNode>(
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
 */
export function fixInsert<N extends RBNode>(
  root: N,
  withNode: WithNodeFn<N>
): N {
  return ensureBlackRoot(rebalanceAfterInsert(root, withNode), withNode);
}
