/**
 * Generic Red-Black tree utilities.
 * Provides immutable balancing operations for any R-B tree node type.
 */

import type { NodeColor, RBNode } from "../../types/state.js";

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
  updates: Partial<{ color: NodeColor; left: N | null; right: N | null }>,
) => N;

// =============================================================================
// Color Utilities
// =============================================================================

/**
 * Check if a node is red.
 * Returns false for null/undefined nodes (they're treated as black).
 */
export function isRed<N extends RBNode<N>>(node: N | null | undefined): boolean {
  return node != null && node.color === "red";
}

/**
 * Check if a node is black.
 * Null nodes are considered black.
 */
export function isBlack<N extends RBNode<N>>(node: N | null | undefined): boolean {
  return node == null || node.color === "black";
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
export function rotateLeft<N extends RBNode<N>>(node: N, withNode: WithNodeFn<N>): N {
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
export function rotateRight<N extends RBNode<N>>(node: N, withNode: WithNodeFn<N>): N {
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
export function ensureBlackRoot<N extends RBNode<N>>(node: N, withNode: WithNodeFn<N>): N {
  if (node.color === "red") {
    return withNode(node, { color: "black" });
  }
  return node;
}

/**
 * Rotate away a red-red violation at a node, for the narrow case where the
 * uncle is known to be black.
 *
 * This is **not** a general red-black repair, and must not be used as one:
 *
 * - It cannot repair a black deficit. Deletion needs
 *   {@link repairLeftBlackDeficit} / {@link repairRightBlackDeficit}, which
 *   carry the deficit in their return value.
 * - It does not handle a red uncle. That case needs the colour flip in
 *   `fixInsertViolation`, which also propagates the violation upward; applying
 *   only the rotations below leaves the violation in place, one level deeper.
 *
 * Its callers are insertion fix-up and right-spine grafting (chunk loading),
 * where both preconditions hold.
 */
export function fixRedViolations<N extends RBNode<N>>(node: N, withNode: WithNodeFn<N>): N {
  let result = node;

  // Case 1: Left-Left (right rotation)
  if (isRed(result.left) && isRed(result.left?.left)) {
    result = rotateRight(result, withNode);
    result = withNode(result, {
      color: "black",
      right: result.right ? withNode(result.right as N, { color: "red" }) : null,
    });
  }
  // Case 2: Left-Right (left-right rotation)
  else if (isRed(result.left) && isRed(result.left?.right)) {
    const newLeft = rotateLeft(result.left as N, withNode);
    result = withNode(result, { left: newLeft });
    result = rotateRight(result, withNode);
    result = withNode(result, {
      color: "black",
      right: result.right ? withNode(result.right as N, { color: "red" }) : null,
    });
  }
  // Case 3: Right-Right (left rotation)
  else if (isRed(result.right) && isRed(result.right?.right)) {
    result = rotateLeft(result, withNode);
    result = withNode(result, {
      color: "black",
      left: result.left ? withNode(result.left as N, { color: "red" }) : null,
    });
  }
  // Case 4: Right-Left (right-left rotation)
  else if (isRed(result.right) && isRed(result.right?.left)) {
    const newRight = rotateRight(result.right as N, withNode);
    result = withNode(result, { right: newRight });
    result = rotateLeft(result, withNode);
    result = withNode(result, {
      color: "black",
      left: result.left ? withNode(result.left as N, { color: "red" }) : null,
    });
  }

  return result;
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
  direction: "left" | "right";
}

/**
 * An insertion path ordered root-first (index 0 = root, last index = leaf-parent).
 * This is the ordering required by fixInsertWithPath.
 *
 * bstInsert builds the path leaf-to-root as the recursion unwinds, then calls
 * .reverse() to produce this ordering. The brand makes that contract visible
 * at the type level: passing an unreversed (leaf-to-root) array to
 * fixInsertWithPath is a compile error.
 */
export type RootToLeafInsertPath<N extends RBNode<N>> = InsertionPathEntry<N>[] & {
  readonly _pathOrder: "root-to-leaf";
};

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
  withNode: WithNodeFn<N>,
): { fixed: N; propagate: boolean } {
  const leftRed = isRed(node.left);
  const rightRed = isRed(node.right);

  const hasLeftViolation =
    leftRed && (isRed((node.left as N)?.left) || isRed((node.left as N)?.right));
  const hasRightViolation =
    rightRed && (isRed((node.right as N)?.right) || isRed((node.right as N)?.left));

  if (!hasLeftViolation && !hasRightViolation) {
    return { fixed: node, propagate: false };
  }

  // Both children red: color flip (uncle-red case in standard RB insertion)
  if (leftRed && rightRed) {
    return {
      fixed: withNode(node, {
        color: "red" as NodeColor,
        left: withNode(node.left as N, { color: "black" }),
        right: withNode(node.right as N, { color: "black" }),
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
  insertPath: RootToLeafInsertPath<N>,
  withNode: WithNodeFn<N>,
): N {
  for (let i = insertPath.length - 1; i >= 0; i--) {
    // Index is in-bounds by the loop guard; capturing the entry avoids repeated
    // assertions and lets mutations flow back through the shared object reference.
    const entry = insertPath[i]!;
    // Sync: if the child below was modified, update this node's reference to it
    if (i < insertPath.length - 1) {
      const childBelow = insertPath[i + 1]!.node;
      const dir = entry.direction;
      const myChild = dir === "left" ? entry.node.left : entry.node.right;
      if (myChild !== childBelow) {
        entry.node =
          dir === "left"
            ? withNode(entry.node, { left: childBelow })
            : withNode(entry.node, { right: childBelow });
      }
    }

    const { fixed } = fixInsertViolation(entry.node, withNode);
    entry.node = fixed;
  }

  return ensureBlackRoot(insertPath[0]!.node, withNode);
}

// =============================================================================
// Right-Spine Append
// =============================================================================

/**
 * Append a new red leaf as the rightmost node of the tree, then fix any
 * red-red violations bottom-up and ensure the root is black.
 *
 * Used for sequential append operations (e.g. streaming chunk loading) where
 * the new element is always the largest key in document order.
 */
export function appendToRightmost<N extends RBNode<N>>(
  root: N | null,
  newLeaf: N,
  withNode: WithNodeFn<N>,
): N {
  if (root === null) {
    return withNode(newLeaf, { color: "black" });
  }

  // Walk the right spine collecting ancestors (root → rightmost parent).
  const path: N[] = [];
  let cur: N = root;
  while (cur.right !== null) {
    path.push(cur);
    cur = cur.right;
  }

  // Attach leaf to the rightmost node, then fix any red-red violation.
  let updated: N = fixRedViolations(withNode(cur, { right: newLeaf }), withNode);

  for (let i = path.length - 1; i >= 0; i--) {
    updated = fixRedViolations(withNode(path[i]!, { right: updated }), withNode);
  }

  return updated.color === "black" ? updated : withNode(updated, { color: "black" });
}

// =============================================================================
// Black Height
// =============================================================================

/**
 * Black height of a subtree: the number of black nodes on a root-to-null path,
 * counting the null terminator as one.
 *
 * Only one spine is read, which is correct exactly when the subtree already
 * satisfies the black-height invariant. Never call this on a tree that is
 * part-way through being rebuilt — a malformed tree returns a rank that is not
 * a property of the tree at all, and joins driven by that rank compound the
 * damage instead of repairing it.
 */
export function blackHeight<N extends RBNode<N>>(node: N | null): number {
  let height = 1;
  let current = node;
  while (current !== null) {
    if (current.color === "black") height++;
    current = current.left;
  }
  return height;
}

// =============================================================================
// Deletion
// =============================================================================

/**
 * Outcome of a removal or repair step.
 *
 * `blackHeightDecreased` is the black deficit made explicit: it reports that
 * `node` is one black level shorter than the subtree it replaces, so the caller
 * must repair at its own level or propagate further up. Encoding the deficit in
 * the return value — rather than in a colour, or by recolouring the root at the
 * end — is what lets deletion preserve the invariant at every level.
 */
export interface RemoveResult<N extends RBNode<N>> {
  readonly node: N | null;
  readonly blackHeightDecreased: boolean;
}

/** A repair step, which always yields a subtree root. */
export interface RepairResult<N extends RBNode<N>> {
  readonly node: N;
  readonly blackHeightDecreased: boolean;
}

/**
 * Repair a subtree whose **left** child has lost one black level.
 *
 * The four standard deletion cases, in order: red sibling (rotate to make it
 * black and retry), black sibling with two black children (push the deficit up),
 * near-red nephew (normalise into the far-red shape), far-red nephew (terminal
 * rotation).
 */
export function repairLeftBlackDeficit<N extends RBNode<N>>(
  parent: N,
  withNode: WithNodeFn<N>,
): RepairResult<N> {
  const sibling = parent.right;
  // No sibling means the deficit cannot be repaired here; propagate it.
  if (sibling === null) return { node: parent, blackHeightDecreased: true };

  if (sibling.color === "red") {
    const innerParent = withNode(parent, { color: "red", right: sibling.left });
    const repaired = repairLeftBlackDeficit(innerParent, withNode);
    return {
      node: withNode(sibling, { color: "black", left: repaired.node }),
      blackHeightDecreased: repaired.blackHeightDecreased,
    };
  }

  if (isBlack(sibling.left) && isBlack(sibling.right)) {
    const redSibling = withNode(sibling, { color: "red" });
    if (parent.color === "red") {
      // The parent's red absorbs the deficit.
      return {
        node: withNode(parent, { color: "black", right: redSibling }),
        blackHeightDecreased: false,
      };
    }
    return { node: withNode(parent, { right: redSibling }), blackHeightDecreased: true };
  }

  if (isBlack(sibling.right) && isRed(sibling.left)) {
    const nearChild = sibling.left as N;
    const rotatedRight = withNode(sibling, { color: "red", left: nearChild.right });
    const rotatedSibling = withNode(nearChild, { color: "black", right: rotatedRight });
    return repairLeftBlackDeficit(withNode(parent, { right: rotatedSibling }), withNode);
  }

  const farChild = sibling.right;
  const newParent = withNode(parent, { color: "black", right: sibling.left });
  return {
    node: withNode(sibling, {
      color: parent.color,
      left: newParent,
      right: farChild === null ? null : withNode(farChild, { color: "black" }),
    }),
    blackHeightDecreased: false,
  };
}

/** Repair a subtree whose **right** child has lost one black level. */
export function repairRightBlackDeficit<N extends RBNode<N>>(
  parent: N,
  withNode: WithNodeFn<N>,
): RepairResult<N> {
  const sibling = parent.left;
  if (sibling === null) return { node: parent, blackHeightDecreased: true };

  if (sibling.color === "red") {
    const innerParent = withNode(parent, { color: "red", left: sibling.right });
    const repaired = repairRightBlackDeficit(innerParent, withNode);
    return {
      node: withNode(sibling, { color: "black", right: repaired.node }),
      blackHeightDecreased: repaired.blackHeightDecreased,
    };
  }

  if (isBlack(sibling.left) && isBlack(sibling.right)) {
    const redSibling = withNode(sibling, { color: "red" });
    if (parent.color === "red") {
      return {
        node: withNode(parent, { color: "black", left: redSibling }),
        blackHeightDecreased: false,
      };
    }
    return { node: withNode(parent, { left: redSibling }), blackHeightDecreased: true };
  }

  if (isBlack(sibling.left) && isRed(sibling.right)) {
    const nearChild = sibling.right as N;
    const rotatedLeft = withNode(sibling, { color: "red", right: nearChild.left });
    const rotatedSibling = withNode(nearChild, { color: "black", left: rotatedLeft });
    return repairRightBlackDeficit(withNode(parent, { left: rotatedSibling }), withNode);
  }

  const farChild = sibling.left;
  const newParent = withNode(parent, { color: "black", left: sibling.right });
  return {
    node: withNode(sibling, {
      color: parent.color,
      left: farChild === null ? null : withNode(farChild, { color: "black" }),
      right: newParent,
    }),
    blackHeightDecreased: false,
  };
}

/**
 * Remove a node that has at most one child, reporting any black deficit.
 *
 * A red node can go without consequence. A black node with a red child is
 * replaced by that child, repainted black. A black node with no red child is
 * the case that creates a deficit.
 */
export function removeNodeWithAtMostOneChild<N extends RBNode<N>>(
  node: N,
  withNode: WithNodeFn<N>,
): RemoveResult<N> {
  const child = node.left ?? node.right;
  if (node.color === "red") return { node: child, blackHeightDecreased: false };
  if (child !== null && child.color === "red") {
    return { node: withNode(child, { color: "black" }), blackHeightDecreased: false };
  }
  return { node: child, blackHeightDecreased: true };
}

/**
 * Remove the leftmost node, returning it alongside the remaining subtree and
 * any black deficit the removal created.
 */
export function removeMinimum<N extends RBNode<N>>(
  node: N,
  withNode: WithNodeFn<N>,
): RemoveResult<N> & { readonly minimum: N } {
  if (node.left === null) {
    return { ...removeNodeWithAtMostOneChild(node, withNode), minimum: node };
  }

  const extracted = removeMinimum(node.left, withNode);
  const rebuilt = withNode(node, { left: extracted.node });
  const repaired = extracted.blackHeightDecreased
    ? repairLeftBlackDeficit(rebuilt, withNode)
    : { node: rebuilt, blackHeightDecreased: false };

  return {
    node: repaired.node,
    blackHeightDecreased: repaired.blackHeightDecreased,
    minimum: extracted.minimum,
  };
}

// =============================================================================
// Rank-based Join
// =============================================================================

/**
 * Join when the left tree is taller: descend its right spine to a black node of
 * black height `rh`, graft the key there as red, then repair red-red violations
 * on the way back up.
 */
function joinRight<N extends RBNode<N>>(
  left: N | null,
  key: N,
  right: N | null,
  rh: number,
  withNode: WithNodeFn<N>,
): N {
  if (isBlack(left) && blackHeight(left) === rh) {
    return withNode(key, { left, right, color: "red" });
  }

  // Reachable only while blackHeight(left) > rh or left is red, both of which
  // imply left is non-null: a null left is black with black height 1, and
  // blackHeight(left) >= rh holds by construction.
  const node = left as N;
  const rebuilt = withNode(node, {
    right: joinRight(node.right, key, right, rh, withNode),
  });

  const child = rebuilt.right;
  if (node.color === "black" && isRed(child) && isRed((child as N).right)) {
    const blackened = withNode(child as N, {
      right: withNode((child as N).right as N, { color: "black" }),
    });
    return rotateLeft(withNode(rebuilt, { right: blackened }), withNode);
  }
  return rebuilt;
}

/** Mirror of {@link joinRight} for a taller right tree. */
function joinLeft<N extends RBNode<N>>(
  left: N | null,
  key: N,
  right: N | null,
  lh: number,
  withNode: WithNodeFn<N>,
): N {
  if (isBlack(right) && blackHeight(right) === lh) {
    return withNode(key, { left, right, color: "red" });
  }

  const node = right as N;
  const rebuilt = withNode(node, {
    left: joinLeft(left, key, node.left, lh, withNode),
  });

  const child = rebuilt.left;
  if (node.color === "black" && isRed(child) && isRed((child as N).left)) {
    const blackened = withNode(child as N, {
      left: withNode((child as N).left as N, { color: "black" }),
    });
    return rotateRight(withNode(rebuilt, { left: blackened }), withNode);
  }
  return rebuilt;
}

/**
 * Join `left`, `key` and `right` into one red-black tree, where every key in
 * `left` precedes `key` and `key` precedes every key in `right`.
 *
 * The key's colour and children are overwritten; only its payload is used.
 * Cost is proportional to the difference in black heights, so a join against a
 * much shorter tree does not walk the taller one.
 *
 * The returned root may be red — that is a well-formed intermediate result and
 * keeps nested joins from repeatedly inflating the black height. Callers that
 * need a canonical tree apply {@link ensureBlackRoot} to the final root only.
 */
export function joinBalanced<N extends RBNode<N>>(
  left: N | null,
  key: N,
  right: N | null,
  withNode: WithNodeFn<N>,
): N {
  const lh = blackHeight(left);
  const rh = blackHeight(right);

  if (lh > rh) {
    const joined = joinRight(left, key, right, rh, withNode);
    return isRed(joined) && isRed(joined.right) ? withNode(joined, { color: "black" }) : joined;
  }

  if (rh > lh) {
    const joined = joinLeft(left, key, right, lh, withNode);
    return isRed(joined) && isRed(joined.left) ? withNode(joined, { color: "black" }) : joined;
  }

  // Equal black heights: a red root keeps both sides' black height intact,
  // unless a child is already red, in which case the root must be black.
  return withNode(key, {
    left,
    right,
    color: isBlack(left) && isBlack(right) ? "red" : "black",
  });
}

/**
 * Concatenate two trees whose key ranges do not overlap.
 *
 * The minimum of the right tree becomes the join key, so the black deficit its
 * removal may create is discharged by {@link removeMinimum} before the join
 * reads either tree's rank.
 */
export function joinTrees<N extends RBNode<N>>(
  left: N | null,
  right: N | null,
  withNode: WithNodeFn<N>,
): N | null {
  if (left === null) return right;
  if (right === null) return left;

  const extracted = removeMinimum(right, withNode);
  return joinBalanced(left, extracted.minimum, extracted.node, withNode);
}
