import type { PieceNode } from "../../types/state.js";
import type { PieceID } from "../../types/branded.js";
import { PersistentMap } from "./persistent-map.js";

interface Entry {
  readonly node: PieceNode;
  readonly parent: PieceID | null;
}
const cache = new WeakMap<PieceNode, PersistentMap<PieceID, Entry>>();

function indexFor(root: PieceNode): PersistentMap<PieceID, Entry> {
  const cached = cache.get(root);
  if (cached) return cached;
  let index = PersistentMap.empty<PieceID, Entry>();
  function visit(node: PieceNode | null, parent: PieceID | null): void {
    if (!node) return;
    index = index.with(node.id, { node, parent });
    visit(node.left, node.id);
    visit(node.right, node.id);
  }
  visit(root, null);
  cache.set(root, index);
  return index;
}

/** Carry an already-demanded index across a tree edit, skipping shared subtrees. */
export function carryPieceIdentityIndex(
  previous: PieceNode | null,
  root: PieceNode | null,
): PieceNode | null {
  if (!previous || !root || previous === root || cache.has(root)) return root;
  const oldIndex = cache.get(previous);
  if (!oldIndex) return root;
  let index = oldIndex;
  const shared = new Set<PieceNode>();
  const visited = new Set<PieceID>();
  function visit(node: PieceNode | null, parent: PieceID | null): void {
    if (!node) return;
    visited.add(node.id);
    const old = oldIndex!.get(node.id);
    if (old?.node === node) {
      shared.add(node);
      if (old.parent !== parent) index = index.with(node.id, { node, parent });
      return;
    }
    index = index.with(node.id, { node, parent });
    visit(node.left, node.id);
    visit(node.right, node.id);
  }
  visit(root, null);
  function removeDeleted(node: PieceNode | null): void {
    if (!node || shared.has(node)) return;
    if (!visited.has(node.id)) index = index.without(node.id);
    removeDeleted(node.left);
    removeDeleted(node.right);
  }
  removeDeleted(previous);
  cache.set(root, index);
  return root;
}

/** Cold lookup builds an index; subsequent edits and lookups follow tree paths. */
export function resolvePieceIdentity(
  root: PieceNode,
  id: PieceID,
): { offset: number; length: number } | null {
  const index = indexFor(root);
  const found = index.get(id);
  if (!found) return null;
  let entry: Entry = found;
  const length = entry.node.length;
  let offset = entry.node.left?.subtreeLength ?? 0;
  while (entry.parent !== null) {
    const parent: Entry = index.get(entry.parent)!;
    if (parent.node.right === entry.node)
      offset += (parent.node.left?.subtreeLength ?? 0) + parent.node.length;
    entry = parent;
  }
  return { offset, length };
}
