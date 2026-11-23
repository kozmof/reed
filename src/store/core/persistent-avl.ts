/**
 * Persistent AVL tree operations shared by the ordered trees in core.
 *
 * Each tree keeps its own node shape, so it can carry an augmented field such
 * as a subtree sum, and passes a factory that builds a node from its parts.
 * Updates copy only the search path.
 */

type Key = string | number;

export interface AvlNode<K extends Key, V, N extends AvlNode<K, V, N>> {
  readonly key: K;
  readonly value: V;
  readonly left: N | null;
  readonly right: N | null;
  readonly height: number;
}

/**
 * Build a node from its parts. It must set `height` to one more than the
 * taller child, and compute any augmented field from the children.
 */
export type MakeAvlNode<K extends Key, V, N extends AvlNode<K, V, N>> = (
  key: K,
  value: V,
  left: N | null,
  right: N | null,
) => N;

/** Height of a node built over `left` and `right`. */
export function avlHeight<N extends { readonly height: number }>(
  left: N | null,
  right: N | null,
): number {
  return 1 + Math.max(left?.height ?? 0, right?.height ?? 0);
}

/** Build a node over subtrees whose heights differ by at most two, rebalanced. */
export function avlBalance<K extends Key, V, N extends AvlNode<K, V, N>>(
  make: MakeAvlNode<K, V, N>,
  key: K,
  value: V,
  left: N | null,
  right: N | null,
): N {
  const lh = left?.height ?? 0;
  const rh = right?.height ?? 0;
  if (lh > rh + 1) {
    const l = left!;
    if ((l.left?.height ?? 0) >= (l.right?.height ?? 0)) {
      return make(l.key, l.value, l.left, make(key, value, l.right, right));
    }
    const m = l.right!;
    return make(
      m.key,
      m.value,
      make(l.key, l.value, l.left, m.left),
      make(key, value, m.right, right),
    );
  }
  if (rh > lh + 1) {
    const r = right!;
    if ((r.right?.height ?? 0) >= (r.left?.height ?? 0)) {
      return make(r.key, r.value, make(key, value, left, r.left), r.right);
    }
    const m = r.left!;
    return make(
      m.key,
      m.value,
      make(key, value, left, m.left),
      make(r.key, r.value, m.right, r.right),
    );
  }
  return make(key, value, left, right);
}

/** `root` with `key` set to `value`. */
export function avlPut<K extends Key, V, N extends AvlNode<K, V, N>>(
  make: MakeAvlNode<K, V, N>,
  root: N | null,
  key: K,
  value: V,
): N {
  if (root === null) return make(key, value, null, null);
  if (key === root.key) return make(key, value, root.left, root.right);
  return key < root.key
    ? avlBalance(make, root.key, root.value, avlPut(make, root.left, key, value), root.right)
    : avlBalance(make, root.key, root.value, root.left, avlPut(make, root.right, key, value));
}

/** `root` without `key`. */
export function avlRemove<K extends Key, V, N extends AvlNode<K, V, N>>(
  make: MakeAvlNode<K, V, N>,
  root: N | null,
  key: K,
): N | null {
  if (root === null) return null;
  if (key < root.key) {
    return avlBalance(make, root.key, root.value, avlRemove(make, root.left, key), root.right);
  }
  if (key > root.key) {
    return avlBalance(make, root.key, root.value, root.left, avlRemove(make, root.right, key));
  }
  if (root.left === null) return root.right;
  if (root.right === null) return root.left;
  let successor = root.right;
  while (successor.left !== null) successor = successor.left;
  return avlBalance(
    make,
    successor.key,
    successor.value,
    root.left,
    avlRemove(make, root.right, successor.key),
  );
}
