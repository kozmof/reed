/** AVL range index for reusable copied spans, including overlapping reservations. */
export interface SourceSpan {
  readonly sourceStart: number;
  readonly length: number;
}
interface Node<T extends SourceSpan> {
  span: T;
  left: Node<T> | null;
  right: Node<T> | null;
  height: number;
  furthest: T;
}
function end(span: SourceSpan): number {
  return span.sourceStart + span.length;
}
function update<T extends SourceSpan>(node: Node<T>): Node<T> {
  node.height = 1 + Math.max(node.left?.height ?? 0, node.right?.height ?? 0);
  node.furthest = node.span;
  for (const child of [node.left, node.right])
    if (child && end(child.furthest) > end(node.furthest)) node.furthest = child.furthest;
  return node;
}
function rotateLeft<T extends SourceSpan>(node: Node<T>): Node<T> {
  const root = node.right!;
  node.right = root.left;
  root.left = update(node);
  return update(root);
}
function rotateRight<T extends SourceSpan>(node: Node<T>): Node<T> {
  const root = node.left!;
  node.left = root.right;
  root.right = update(node);
  return update(root);
}
function insert<T extends SourceSpan>(node: Node<T> | null, span: T): Node<T> {
  if (!node) return { span, left: null, right: null, height: 1, furthest: span };
  if (span.sourceStart < node.span.sourceStart) node.left = insert(node.left, span);
  else if (span.sourceStart > node.span.sourceStart) node.right = insert(node.right, span);
  else if (span.length > node.span.length) node.span = span;
  update(node);
  const balance = (node.left?.height ?? 0) - (node.right?.height ?? 0);
  if (balance > 1) {
    if ((node.left!.left?.height ?? 0) < (node.left!.right?.height ?? 0))
      node.left = rotateLeft(node.left!);
    return rotateRight(node);
  }
  if (balance < -1) {
    if ((node.right!.right?.height ?? 0) < (node.right!.left?.height ?? 0))
      node.right = rotateRight(node.right!);
    return rotateLeft(node);
  }
  return node;
}
export class SpanIndex<T extends SourceSpan> {
  #root: Node<T> | null = null;
  add(span: T): void {
    this.#root = insert(this.#root, span);
  }
  containing(start: number, length: number): T | undefined {
    let node = this.#root;
    let best: T | undefined;
    // Find the maximum end among starts <= start using subtree aggregates.
    while (node) {
      if (node.span.sourceStart > start) {
        node = node.left;
        continue;
      }
      if (!best || end(node.span) > end(best)) best = node.span;
      const left = node.left?.furthest;
      if (left && (!best || end(left) > end(best))) best = left;
      node = node.right;
    }
    return best && end(best) >= start + length ? best : undefined;
  }
}
