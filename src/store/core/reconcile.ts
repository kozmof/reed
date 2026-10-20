/**
 * Reconciliation functions for the Reed line index.
 *
 * Extracted from line-index.ts to keep that file focused on structural
 * operations (insert, delete, lookup). This module owns the lazy dirty-range
 * tracking and the reconciliation passes that restore accurate byte offsets.
 *
 * Public exports: mergeDirtyRanges, reconcileRange, reconcileFull,
 * reconcileViewport, ReconciliationConfig
 */

import type {
  LineIndexNode,
  LineIndexState,
  DirtyLineRangeEntry,
  DirtyLineRangeList,
  EvaluationMode,
} from "../../types/state.js";
import { $beginCost, $proveCtx, type NLogNCost } from "../../types/cost-doc.js";
import {
  withLineIndexNode,
  withLineIndexNodeOffsets,
  withLineIndexState,
  asEagerLineIndex,
} from "./state.js";

// =============================================================================
// Dirty Range Management
// =============================================================================

/**
 * Merge overlapping or adjacent dirty ranges to minimize tracking overhead.
 */
export function mergeDirtyRanges(
  ranges: DirtyLineRangeList,
  maxRanges: number = 32,
): NLogNCost<DirtyLineRangeList> {
  if (ranges === "full-rebuild-needed") {
    return $proveCtx($beginCost("O(n log n)"), "full-rebuild-needed" as const);
  }
  if (ranges.length <= 1) return $proveCtx($beginCost("O(n log n)"), [...ranges]);

  // Sort by startLine only when ranges are out of order.
  let needsSort = false;
  for (let j = 1; j < ranges.length; j++) {
    if (ranges[j]!.startLine < ranges[j - 1]!.startLine) {
      needsSort = true;
      break;
    }
  }
  const sorted: DirtyLineRangeEntry[] = needsSort
    ? [...ranges].sort((a, b) => a.startLine - b.startLine)
    : [...ranges];
  const merged: DirtyLineRangeEntry[] = [];
  let i = 0;
  // `current` holds the range that has not yet been pushed to `merged`.
  // The e1===e2 branch sets it to null when the input is exhausted mid-loop.
  // The final push checks for null to avoid adding the range twice.
  let current: DirtyLineRangeEntry | null = sorted[0]!;

  while (i < sorted.length - 1) {
    i++;
    const next = sorted[i]!; // i < sorted.length by the loop guard
    if (next.startLine <= current!.endLine + 1) {
      if (next.offsetDelta === current!.offsetDelta && next.startLine > current!.endLine) {
        // Extend current to cover adjacent ranges with the same delta.
        current = Object.freeze({
          startLine: current!.startLine,
          endLine: Math.max(current!.endLine, next.endLine),
          offsetDelta: current!.offsetDelta,
        });
      } else if (next.startLine === current!.startLine) {
        // Sum deltas for ranges with the same start to apply both changes.
        current = Object.freeze({
          startLine: current!.startLine,
          endLine: Math.max(current!.endLine, next.endLine),
          offsetDelta: current!.offsetDelta + next.offsetDelta,
        });
      } else {
        // True overlap: s1 < s2 <= e1, different deltas.
        // Decompose into: [s1, s2-1, d1], [s2, min(e1,e2), d1+d2], tail.
        merged.push(
          Object.freeze({
            startLine: current!.startLine,
            endLine: next.startLine - 1,
            offsetDelta: current!.offsetDelta,
          }),
        );
        const combinedDelta = current!.offsetDelta + next.offsetDelta;
        if (current!.endLine < next.endLine) {
          // End the overlap at current.endLine because current ends first.
          merged.push(
            Object.freeze({
              startLine: next.startLine,
              endLine: current!.endLine,
              offsetDelta: combinedDelta,
            }),
          );
          current = Object.freeze({
            startLine: current!.endLine + 1,
            endLine: next.endLine,
            offsetDelta: next.offsetDelta,
          });
        } else if (current!.endLine > next.endLine) {
          // End the overlap at next.endLine because next ends first.
          merged.push(
            Object.freeze({
              startLine: next.startLine,
              endLine: next.endLine,
              offsetDelta: combinedDelta,
            }),
          );
          current = Object.freeze({
            startLine: next.endLine + 1,
            endLine: current!.endLine,
            offsetDelta: current!.offsetDelta,
          });
        } else {
          // Both ranges are consumed when e1 === e2, leaving no tail.
          // Push the combined segment and advance to the next input range.
          // Setting current = null when input is exhausted prevents the post-loop
          // push from double-counting a range already in `merged`.
          merged.push(
            Object.freeze({
              startLine: next.startLine,
              endLine: current!.endLine,
              offsetDelta: combinedDelta,
            }),
          );
          i++;
          current = i < sorted.length ? sorted[i]! : null;
        }
      }
    } else {
      // Finalize current and start a new range when there is no overlap.
      merged.push(current!);
      current = next;
    }
  }
  if (current !== null) merged.push(current);

  // Rebuild the full document if the range count exceeds the cap.
  // Threshold is configurable via DocumentStoreConfig.maxDirtyRanges (default 32).
  if (merged.length > maxRanges) {
    return $proveCtx($beginCost("O(n log n)"), "full-rebuild-needed" as const);
  }

  return $proveCtx($beginCost("O(n log n)"), merged);
}

// =============================================================================
// Reconciliation Pass Helpers
// =============================================================================

/**
 * Repair the cached offsets of every line in `[fromLine, toLine]` from the
 * tree's own aggregates, in one pruned in-order pass.
 *
 * `firstLine` and `firstOffset` describe where this subtree starts, so the walk
 * carries the true byte offset down with it. `subtreeLineCount` and
 * `subtreeByteLength` are exact at all times (invariants 2.1 and 2.2), which
 * lets a subtree lying entirely outside the range return untouched.
 *
 * Compute offsets from aggregates because lazily inserted lines may have
 * `documentOffset: null`. This also repairs stale offsets independently of
 * the recorded delta.
 *
 * Nodes already holding the correct offset are returned as they are, so a clean
 * window costs no allocations.
 */
function repairLineRange(
  node: LineIndexNode | null,
  fromLine: number,
  toLine: number,
  firstLine: number,
  firstOffset: number,
): LineIndexNode | null {
  if (node === null) return null;

  // Prune whole subtrees that fall outside the window.
  const lastLine = firstLine + node.subtreeLineCount - 1;
  if (lastLine < fromLine || firstLine > toLine) return node;

  const leftLineCount = node.left?.subtreeLineCount ?? 0;
  const leftByteLength = node.left?.subtreeByteLength ?? 0;
  const selfLine = firstLine + leftLineCount;
  const selfOffset = firstOffset + leftByteLength;

  const newLeft = repairLineRange(node.left, fromLine, toLine, firstLine, firstOffset);
  const newRight = repairLineRange(
    node.right,
    fromLine,
    toLine,
    selfLine + 1,
    selfOffset + node.lineLength,
  );

  const repairSelf =
    selfLine >= fromLine && selfLine <= toLine && node.documentOffset !== selfOffset;

  if (newLeft !== node.left || newRight !== node.right || repairSelf) {
    return withLineIndexNodeOffsets(node, {
      left: newLeft,
      right: newRight,
      documentOffset: repairSelf ? selfOffset : node.documentOffset,
    });
  }
  return node;
}

/**
 * Compute total number of dirty lines across all ranges, clamped to lineCount.
 */
function computeTotalDirtyLines(dirtyRanges: DirtyLineRangeList, lineCount: number): number {
  if (dirtyRanges === "full-rebuild-needed") return lineCount;
  let total = 0;
  for (const range of dirtyRanges) {
    const end = Math.min(range.endLine, lineCount - 1);
    total += Math.max(0, end - range.startLine + 1);
  }
  return total;
}

/**
 * Walk the tree in order and compute offsets from accumulated line lengths.
 * Only nodes with incorrect offsets are copied.
 *
 * This full walk is used when most of the document is dirty or delta
 * information has been lost. It visits every node without tracking separate
 * subtree-clean flags across mutations and rotations.
 */
function reconcileInPlace(
  node: LineIndexNode | null,
  acc: { offset: number },
): LineIndexNode | null {
  if (node === null) return null;

  const newLeft = reconcileInPlace(node.left, acc);
  const correctOffset = acc.offset;
  acc.offset += node.lineLength;
  const newRight = reconcileInPlace(node.right, acc);

  if (newLeft !== node.left || newRight !== node.right || node.documentOffset !== correctOffset) {
    return withLineIndexNode(node, {
      left: newLeft,
      right: newRight,
      documentOffset: correctOffset,
    });
  }
  return node;
}

function toEagerLineIndexState(
  state: LineIndexState,
  revision: number,
  changes: Partial<LineIndexState> = {},
): LineIndexState<"eager"> {
  const reconciled = withLineIndexState(state, {
    dirtyRanges: Object.freeze([]),
    lastReconciledRevision: revision,
    rebuildPending: false,
    ...changes,
  });
  return asEagerLineIndex(reconciled);
}

// =============================================================================
// Reconciliation Functions
// =============================================================================

/**
 * Reconcile a specific range of lines.
 * Updates offsets for lines in [startLine, endLine].
 *
 * @internal Follow the dirty-range requirements below.
 * `revision` must match the state revision, and line bounds must be within
 * `[0, state.lineCount - 1]`. Misuse can leave the line index in a partially
 * reconciled state. Prefer the higher-level entry points:
 * - `reconcileNow()` — immediate full reconciliation (store method)
 * - `setViewport(startLine, endLine)` — priority reconciliation for visible lines
 */
export function reconcileRange(
  state: LineIndexState,
  startLine: number,
  endLine: number,
  revision: number,
): NLogNCost<LineIndexState> {
  const dirtyRanges = state.dirtyRanges;
  if (state.root === null) return $proveCtx($beginCost("O(n log n)"), state);
  if (dirtyRanges === "full-rebuild-needed" || dirtyRanges.length === 0)
    return $proveCtx($beginCost("O(n log n)"), state);
  const clampedStart = Math.max(0, startLine);
  const clampedEnd = Math.min(endLine, state.lineCount - 1);
  if (clampedStart > clampedEnd) return $proveCtx($beginCost("O(n log n)"), state);

  // Repair each dirty range clipped to [clampedStart, clampedEnd] in O(K) passes,
  // each O(V + log n) for the V lines it covers. The ranges are sorted and
  // non-overlapping (mergeDirtyRanges guarantees both), so no line is walked
  // twice.
  //
  // The recorded `offsetDelta` is not consulted. Repair derives each offset from
  // the tree, so a range only has to say which lines moved, not by how much.
  // That also repairs a line whose recorded delta is zero, which is how a lazily
  // inserted line with a null offset gets a real one.
  let newRoot = state.root!;
  for (const range of dirtyRanges) {
    const effectiveStart = Math.max(range.startLine, clampedStart);
    const effectiveEnd = Math.min(range.endLine, clampedEnd);
    if (effectiveStart > effectiveEnd) continue;
    newRoot = repairLineRange(newRoot, effectiveStart, effectiveEnd, 0, 0)!;
  }

  // Keep only the parts of dirty ranges that are outside [clampedStart, clampedEnd].
  const remaining: DirtyLineRangeEntry[] = [];
  for (const range of dirtyRanges) {
    const rangeEnd = Math.min(range.endLine, state.lineCount - 1);
    if (range.startLine > rangeEnd) continue;

    // No overlap with reconciled window.
    if (rangeEnd < clampedStart || range.startLine > clampedEnd) {
      remaining.push(range);
      continue;
    }

    // Left-side remainder.
    if (range.startLine < clampedStart) {
      remaining.push(Object.freeze({ ...range, endLine: clampedStart - 1 }));
    }

    // Right-side remainder.
    if (rangeEnd > clampedEnd) {
      remaining.push(Object.freeze({ ...range, startLine: clampedEnd + 1 }));
    }
  }
  const remainingRanges = mergeDirtyRanges(remaining, state.maxDirtyRanges);

  return $proveCtx(
    $beginCost("O(n log n)"),
    withLineIndexState(state, {
      root: newRoot,
      dirtyRanges: remainingRanges,
      lastReconciledRevision: revision,
      rebuildPending: remainingRanges === "full-rebuild-needed" || remainingRanges.length > 0,
    }),
  );
}

/**
 * Configuration for reconciliation behavior.
 */
export interface ReconciliationConfig {
  /** Compute the threshold below which incremental reconciliation is used.
   *  Receives lineCount, returns max dirty lines for incremental path.
   *  Default: Math.max(256, Math.floor(lineCount * 0.75))
   */
  thresholdFn?: (lineCount: number) => number;
}

// Compare O(K log n + totalDirty) incremental repair with an O(n) full walk.
// Leave headroom for repeated tree descents when choosing the incremental path.
const defaultThresholdFn = (lineCount: number): number =>
  Math.max(256, Math.floor(lineCount * 0.75));

/**
 * Perform full reconciliation of all dirty ranges.
 * Uses incremental updates for small dirty ranges (O(K log n + totalDirty)),
 * and an in-place tree walk for large ranges (O(n) with structural sharing).
 * Intended to be called from idle callback.
 */
export function reconcileFull(
  state: LineIndexState,
  revision: number,
  config?: ReconciliationConfig,
): NLogNCost<LineIndexState<"eager">> {
  const dirtyRanges = state.dirtyRanges;
  if (dirtyRanges !== "full-rebuild-needed" && dirtyRanges.length === 0) {
    return $proveCtx($beginCost("O(n log n)"), toEagerLineIndexState(state, revision));
  }

  if (state.root === null) {
    return $proveCtx(
      $beginCost("O(n log n)"),
      toEagerLineIndexState(state, revision, {
        lineCount: 1,
      }),
    );
  }

  // Repair each range once without repeatedly filtering the remaining ranges.
  const totalDirty = computeTotalDirtyLines(dirtyRanges, state.lineCount);
  const thresholdFn = config?.thresholdFn ?? defaultThresholdFn;
  const threshold = thresholdFn(state.lineCount);
  const hasCollapsedCapSentinel = dirtyRanges === "full-rebuild-needed";

  // The sentinel has no range boundaries, so repair the whole tree below.
  if (!hasCollapsedCapSentinel && totalDirty <= threshold) {
    let root = state.root;
    for (const range of dirtyRanges) {
      root = repairLineRange(root, range.startLine, range.endLine, 0, 0)!;
    }
    return $proveCtx($beginCost("O(n log n)"), toEagerLineIndexState(state, revision, { root }));
  }

  // Use the full tree walk when the sentinel indicates lost delta information
  // or totalDirty exceeds the threshold.
  // Both cases use the O(n) in-place tree walk because it is cheaper than the
  // O(K log n + totalDirty) incremental path when the dirty region is large.
  //
  // Recompute documentOffset from stored lineLength values with reconcileInPlace.
  // This path does not call getText or rebuildLineIndex or decode the document.
  const newRoot = reconcileInPlace(state.root, { offset: 0 });

  return $proveCtx(
    $beginCost("O(n log n)"),
    toEagerLineIndexState(state, revision, {
      root: newRoot,
    }),
  );
}

/**
 * Ensure viewport lines are fully reconciled.
 * Called before rendering to guarantee visible content accuracy.
 */
export function reconcileViewport(
  state: LineIndexState,
  startLine: number,
  endLine: number,
  revision: number,
): NLogNCost<LineIndexState> {
  const dirtyRanges = state.dirtyRanges;
  if (dirtyRanges !== "full-rebuild-needed" && dirtyRanges.length === 0)
    return $proveCtx($beginCost("O(n log n)"), state);
  const normalizedStart = Math.min(startLine, endLine);
  const normalizedEnd = Math.max(startLine, endLine);
  const clampedStart = Math.max(0, normalizedStart);
  const clampedEnd = Math.min(normalizedEnd, state.lineCount - 1);
  if (clampedStart > clampedEnd) return $proveCtx($beginCost("O(n log n)"), state);

  // Check if any viewport lines are dirty.
  // Treat every viewport as dirty when dirtyRanges is 'full-rebuild-needed'.
  const viewportDirty =
    dirtyRanges === "full-rebuild-needed" ||
    dirtyRanges.some((range) => range.startLine <= clampedEnd && range.endLine >= clampedStart);

  if (!viewportDirty) return $proveCtx($beginCost("O(n log n)"), state);

  // The sentinel means every cached documentOffset may be stale, but it does
  // not prevent us from deriving exact offsets for the visible window from the
  // always-current subtree byte-length aggregates. Keep the sentinel afterward
  // so background reconciliation still repairs the rest of the document.
  if (dirtyRanges === "full-rebuild-needed") {
    const newRoot = repairLineRange(state.root, clampedStart, clampedEnd, 0, 0);
    if (newRoot === state.root && state.lastReconciledRevision === revision) {
      return $proveCtx($beginCost("O(n log n)"), state);
    }
    return $proveCtx(
      $beginCost("O(n log n)"),
      withLineIndexState(state, {
        root: newRoot,
        lastReconciledRevision: revision,
      }),
    );
  }

  // Reconcile only the viewport range
  return reconcileRange(state, clampedStart, clampedEnd, revision);
}

// Explicit re-export of EvaluationMode for consumers that import from this module
export type { EvaluationMode };
