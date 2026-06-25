/**
 * Attention namespace — piece-anchored boundary references into mutable text.
 *
 * The attention layer is the third independent Reed layer, alongside the piece
 * table (content) and the line index (navigation). An attention pins to a piece
 * boundary rather than a document offset, so a reference survives tree rotations,
 * rebalancing, inserts, and deletes without the caller re-tracking offsets.
 *
 * State is immutable and caller-owned: pass the current `AttentionLayerState`
 * into each state-returning op and store the result. Start from `emptyState`.
 *
 * Use `insertWithAttention` / `deleteWithAttention` to advance the piece table
 * and attention layer together; resolution is fail-closed (a dangling point
 * resolves to `null` rather than to a corrupt offset).
 *
 * Cost discipline is an implementation detail of `store/core`: the core ops are
 * authored against the `cost-doc` algebra so their declared complexity is checked
 * at composition time, but the brand is stripped at this boundary so callers get
 * plain values. Complexity is documented here via `@complexity` tags instead.
 *
 * @see scan — full-document traversals
 */

import {
  emptyAttentionLayerState,
  createPoint,
  resolvePoint,
  createAttention,
  getAttention,
  deleteAttention,
  resolveAttention,
  getTextForAttention,
  findAttentionsAt,
  findAttentionsOverlapping,
  migrateSplits,
  migrateDelete,
  insertWithAttention,
  deleteWithAttention,
} from "../store/core/attention.js";
import { $uncostedFn } from "../types/cost-doc.js";
import type { AttentionApi } from "./interfaces.js";

export const attention: AttentionApi = {
  /** Empty AttentionLayerState — the initial value. */
  emptyState: emptyAttentionLayerState,

  // Points
  /** @complexity O(log n) — tree walk to find the piece containing the offset */
  createPoint: $uncostedFn(createPoint),
  /** @complexity O(n) — builds the piece-offset index in one in-order pass */
  resolvePoint: $uncostedFn(resolvePoint),

  // Attentions
  /** @complexity O(1) — mint an ID and copy-on-write the attention map */
  createAttention: $uncostedFn(createAttention),
  /** @complexity O(1) — map lookup */
  getAttention: $uncostedFn(getAttention),
  /** @complexity O(1) — copy-on-write delete from the attention map */
  deleteAttention: $uncostedFn(deleteAttention),

  // Resolution and text
  /** @complexity O(n) — a single tree walk resolves both points */
  resolveAttention: $uncostedFn(resolveAttention),
  /** @complexity O(n) — resolve the range, then read the covered text */
  getTextForAttention: $uncostedFn(getTextForAttention),

  // Queries
  /** @complexity O(n + A) — one tree walk to index pieces, O(1) per attention */
  findAttentionsAt: $uncostedFn(findAttentionsAt),
  /** @complexity O(n + A) — one tree walk to index pieces, O(1) per attention */
  findAttentionsOverlapping: $uncostedFn(findAttentionsOverlapping),

  // Edit support
  /** @complexity O(n) — piece-table insert plus per-attention split migration */
  insertWithAttention: $uncostedFn(insertWithAttention),
  /** @complexity O(n + A·log n) — pre-delete index plus per-point re-anchor */
  deleteWithAttention: $uncostedFn(deleteWithAttention),
  /** @complexity O(A·S) — A attention points across S splits (usually 0 or 1) */
  migrateSplits: $uncostedFn(migrateSplits),
  /** @complexity O(n + A·log n) — pre-delete index plus per-point re-anchor */
  migrateDelete: $uncostedFn(migrateDelete),
};
