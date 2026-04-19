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
} from "../../types/state.ts";
import { $proveCtx, $lift, type NLogNCost } from "../../types/cost-doc.ts";
import { withLineIndexNode, withLineIndexState, asEagerLineIndex } from "./state.ts";

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
    return $proveCtx("O(n log n)", $lift("O(n log n)", "full-rebuild-needed" as const));
  }
  if (ranges.length <= 1) return $proveCtx("O(n log n)", $lift("O(n log n)", [...ranges]));

  // Sort by startLine — skip sort if already in order (common case: appended sequentially).
  let needsSort = false;
  for (let j = 1; j < ranges.length; j++) {
    if (ranges[j].startLine < ranges[j - 1].startLine) {
      needsSort = true;
      break;
    }
  }
  const sorted: DirtyLineRangeEntry[] = needsSort
    ? [...ranges].sort((a, b) => a.startLine - b.startLine)
    : [...ranges];
  const merged: DirtyLineRangeEntry[] = [];
  let i = 0;
  // Loop invariant: `current` is the "in-flight" range — it has NOT yet been
  // pushed to `merged`. Every range in `merged` is fully resolved and will
  // never be revisited. `current` is finalized either:
  //   (a) post-loop via `if (!exhausted) merged.push(current)`, or
  //   (b) mid-loop in the e1===e2 branch, which sets `exhausted = true` to
  //       prevent (a) from double-counting it.
  let current = sorted[0];
  let exhausted = false;

  while (i < sorted.length - 1) {
    i++;
    const next = sorted[i];
    if (next.startLine <= current.endLine + 1) {
      if (next.offsetDelta === current.offsetDelta && next.startLine > current.endLine) {
        // Adjacent (non-overlapping) same delta — extend current to cover both
        current = Object.freeze({
          kind: "range" as const,
          startLine: current.startLine,
          endLine: Math.max(current.endLine, next.endLine),
          offsetDelta: current.offsetDelta,
        });
      } else if (next.startLine === current.startLine) {
        // Same start, different delta — sum deltas (equivalent to applying both)
        current = Object.freeze({
          kind: "range" as const,
          startLine: current.startLine,
          endLine: Math.max(current.endLine, next.endLine),
          offsetDelta: current.offsetDelta + next.offsetDelta,
        });
      } else {
        // True overlap: s1 < s2 <= e1, different deltas.
        // Decompose into: [s1, s2-1, d1], [s2, min(e1,e2), d1+d2], tail.
        merged.push(
          Object.freeze({
            kind: "range" as const,
            startLine: current.startLine,
            endLine: next.startLine - 1,
            offsetDelta: current.offsetDelta,
          }),
        );
        const combinedDelta = current.offsetDelta + next.offsetDelta;
        if (current.endLine < next.endLine) {
          // current ends first — overlap ends at current.endLine
          merged.push(
            Object.freeze({
              kind: "range" as const,
              startLine: next.startLine,
              endLine: current.endLine,
              offsetDelta: combinedDelta,
            }),
          );
          current = Object.freeze({
            kind: "range" as const,
            startLine: current.endLine + 1,
            endLine: next.endLine,
            offsetDelta: next.offsetDelta,
          });
        } else if (current.endLine > next.endLine) {
          // next ends first — overlap ends at next.endLine
          merged.push(
            Object.freeze({
              kind: "range" as const,
              startLine: next.startLine,
              endLine: next.endLine,
              offsetDelta: combinedDelta,
            }),
          );
          current = Object.freeze({
            kind: "range" as const,
            startLine: next.endLine + 1,
            endLine: current.endLine,
            offsetDelta: current.offsetDelta,
          });
        } else {
          // e1 === e2: both ranges fully consumed by the overlap — no tail remains.
          // Push `current` into `merged` here (it is now resolved) and advance `i`
          // to the next input range. If that exhausts the input, set `exhausted` so
          // the post-loop push is skipped — `current` is already in `merged`.
          merged.push(
            Object.freeze({
              kind: "range" as const,
              startLine: next.startLine,
              endLine: current.endLine,
              offsetDelta: combinedDelta,
            }),
          );
          i++;
          if (i >= sorted.length) {
            exhausted = true;
            break;
          }
          current = sorted[i];
        }
      }
    } else {
      // No overlap — finalize current, start fresh
      merged.push(current);
      current = next;
    }
  }
  // Finalize the last in-flight range, unless the e1===e2 branch already pushed
  // it into `merged` mid-loop (signalled by `exhausted`).
  if (!exhausted) merged.push(current);

  // Safety cap: if too many ranges accumulated, collapse to full-document rebuild.
  // Threshold is configurable via DocumentStoreConfig.maxDirtyRanges (default 32).
  if (merged.length > maxRanges) {
    return $proveCtx("O(n log n)", $lift("O(n log n)", "full-rebuild-needed" as const));
  }

  return $proveCtx("O(n log n)", $lift<"O(n log n)", DirtyLineRangeList>("O(n log n)", merged));
}

// =============================================================================
// Reconciliation Pass Helpers
// =============================================================================

/**
 * Update offset for a specific line in the tree.
 */
function updateLineOffsetByNumber(
  node: LineIndexNode,
  lineNumber: number,
  offsetDelta: number,
): LineIndexNode {
  const leftLineCount = node.left?.subtreeLineCount ?? 0;

  if (lineNumber < leftLineCount && node.left !== null) {
    return withLineIndexNode(node, {
      left: updateLineOffsetByNumber(node.left, lineNumber, offsetDelta),
    });
  } else if (lineNumber > leftLineCount && node.right !== null) {
    return withLineIndexNode(node, {
      right: updateLineOffsetByNumber(node.right, lineNumber - leftLineCount - 1, offsetDelta),
    });
  } else {
    return withLineIndexNode(node, {
      documentOffset:
        node.documentOffset === null ? offsetDelta : node.documentOffset + offsetDelta,
    });
  }
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
 * Walk the tree in-order and update offsets by accumulating line lengths.
 * Uses structural sharing — only nodes with incorrect offsets get new allocations.
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
  version: number,
  changes: Partial<LineIndexState> = {},
): LineIndexState<"eager"> {
  const reconciled = withLineIndexState(state, {
    dirtyRanges: Object.freeze([]),
    lastReconciledVersion: version,
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
 * @internal Low-level operation — callers must understand dirty-range semantics:
 * `version` must match the state version, and line bounds must be within
 * `[0, state.lineCount - 1]`. Misuse can leave the line index in a partially
 * reconciled state. Prefer the higher-level entry points:
 * - `reconcileNow()` — immediate full reconciliation (store method)
 * - `setViewport(startLine, endLine)` — priority reconciliation for visible lines
 */
export function reconcileRange(
  state: LineIndexState,
  startLine: number,
  endLine: number,
  version: number,
): NLogNCost<LineIndexState> {
  const dirtyRanges = state.dirtyRanges;
  if (state.root === null) return $proveCtx("O(n log n)", $lift("O(n log n)", state));
  if (dirtyRanges === "full-rebuild-needed" || dirtyRanges.length === 0)
    return $proveCtx("O(n log n)", $lift("O(n log n)", state));
  const clampedStart = Math.max(0, startLine);
  const clampedEnd = Math.min(endLine, state.lineCount - 1);
  if (clampedStart > clampedEnd) return $proveCtx("O(n log n)", $lift("O(n log n)", state));

  // Build sweep events from sorted, non-overlapping dirty ranges — O(K)
  // Each range contributes a +delta event at its effective start and
  // a -delta event at its effective end+1 within [clampedStart, clampedEnd].
  const events: Array<{ line: number; delta: number }> = [];
  for (const range of dirtyRanges) {
    const effectiveStart = Math.max(range.startLine, clampedStart);
    const effectiveEnd = Math.min(range.endLine, clampedEnd);
    if (effectiveStart > effectiveEnd) continue;
    events.push({ line: effectiveStart, delta: range.offsetDelta });
    if (effectiveEnd < clampedEnd) {
      events.push({ line: effectiveEnd + 1, delta: -range.offsetDelta });
    }
  }

  // Sweep [clampedStart, clampedEnd] with a running cumulative delta — O(K + V)
  let newRoot = state.root!;
  let cumDelta = 0;
  let evtIdx = 0;
  for (let line = clampedStart; line <= clampedEnd; line++) {
    while (evtIdx < events.length && events[evtIdx].line === line) {
      cumDelta += events[evtIdx].delta;
      evtIdx++;
    }
    if (cumDelta !== 0) {
      newRoot = updateLineOffsetByNumber(newRoot, line, cumDelta);
    }
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
    "O(n log n)",
    $lift(
      "O(n log n)",
      withLineIndexState(state, {
        root: newRoot,
        dirtyRanges: remainingRanges,
        lastReconciledVersion: version,
        rebuildPending: remainingRanges === "full-rebuild-needed" || remainingRanges.length > 0,
      }),
    ),
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

// Incremental reconciliation total cost: O(K² + totalDirty) where K ≤ 32 (sentinel cap).
// Full-walk cost: O(n). Incremental is cheaper when totalDirty + 1024 ≤ n, i.e. when
// totalDirty ≤ n − 1024 ≈ 0.75n for typical documents. The old formula (n / log₂n) was
// calibrated for the former O(V×K) reconcileRange; the sweep-line O(K+V) implementation
// makes incremental viable up to ~75% dirty lines.
const defaultThresholdFn = (lineCount: number): number =>
  Math.max(256, Math.floor(lineCount * 0.75));

/**
 * Perform full reconciliation of all dirty ranges.
 * Uses incremental updates for small dirty ranges (O(k * log n)),
 * and an in-place tree walk for large ranges (O(n) with structural sharing).
 * Intended to be called from idle callback.
 */
export function reconcileFull(
  state: LineIndexState,
  version: number,
  config?: ReconciliationConfig,
): NLogNCost<LineIndexState<"eager">> {
  const dirtyRanges = state.dirtyRanges;
  if (dirtyRanges !== "full-rebuild-needed" && dirtyRanges.length === 0) {
    return $proveCtx("O(n log n)", $lift("O(n log n)", toEagerLineIndexState(state, version)));
  }

  if (state.root === null) {
    return $proveCtx(
      "O(n log n)",
      $lift(
        "O(n log n)",
        toEagerLineIndexState(state, version, {
          lineCount: 1,
        }),
      ),
    );
  }

  // Fast path: incremental reconciliation — O(K² + totalDirty) via sweep-line reconcileRange
  const totalDirty = computeTotalDirtyLines(dirtyRanges, state.lineCount);
  const thresholdFn = config?.thresholdFn ?? defaultThresholdFn;
  const threshold = thresholdFn(state.lineCount);
  const hasCollapsedCapSentinel = dirtyRanges === "full-rebuild-needed";

  // 'full-rebuild-needed' means delta information was lost — incremental reconciliation
  // cannot repair offsets correctly, so fall through to the slow path.
  if (!hasCollapsedCapSentinel && totalDirty <= threshold) {
    let current: LineIndexState = state;
    for (const range of dirtyRanges) {
      const endLine = Math.min(range.endLine, current.lineCount - 1);
      current = reconcileRange(current, range.startLine, endLine, version);
    }
    return $proveCtx("O(n log n)", $lift("O(n log n)", toEagerLineIndexState(current, version)));
  }

  // Slow path: triggered either by a sentinel (delta information lost) or when
  // totalDirty > threshold (non-sentinel ranges covering most of the document).
  // Both cases are intentional — the O(n) in-place tree walk is cheaper than the
  // O(K²+totalDirty) incremental path when the dirty region is large.
  //
  // IMPORTANT: this path uses reconcileInPlace, which recomputes documentOffset
  // values from each node's stored lineLength via an in-order traversal. It does
  // NOT call getText or rebuildLineIndex — no full document decode occurs here.
  const newRoot = reconcileInPlace(state.root, { offset: 0 });

  return $proveCtx(
    "O(n log n)",
    $lift(
      "O(n log n)",
      toEagerLineIndexState(state, version, {
        root: newRoot,
      }),
    ),
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
  version: number,
): NLogNCost<LineIndexState> {
  const dirtyRanges = state.dirtyRanges;
  if (dirtyRanges !== "full-rebuild-needed" && dirtyRanges.length === 0)
    return $proveCtx("O(n log n)", $lift("O(n log n)", state));
  const normalizedStart = Math.min(startLine, endLine);
  const normalizedEnd = Math.max(startLine, endLine);
  const clampedStart = Math.max(0, normalizedStart);
  const clampedEnd = Math.min(normalizedEnd, state.lineCount - 1);
  if (clampedStart > clampedEnd) return $proveCtx("O(n log n)", $lift("O(n log n)", state));

  // Check if any viewport lines are dirty.
  // 'full-rebuild-needed' means the entire document is dirty — viewport is always dirty.
  const viewportDirty =
    dirtyRanges === "full-rebuild-needed" ||
    dirtyRanges.some((range) => range.startLine <= clampedEnd && range.endLine >= clampedStart);

  if (!viewportDirty) return $proveCtx("O(n log n)", $lift("O(n log n)", state));

  // Reconcile only the viewport range
  return reconcileRange(state, clampedStart, clampedEnd, version);
}

// Explicit re-export of EvaluationMode for consumers that import from this module
export type { EvaluationMode };
