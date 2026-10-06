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
  /** @complexity Expected O(P) cold, O(log P) cached, for bounded-length, well-distributed IDs */
  resolvePoint: $uncostedFn(resolvePoint),

  // Attentions
  /** @complexity O(log A) for native layers. External maps need one O(A log A) indexing pass */
  createAttention: $uncostedFn(createAttention),
  /** @complexity O(log A) — persistent map lookup */
  getAttention: $uncostedFn(getAttention),
  /** @complexity O(log A) for native layers. External maps need one O(A log A) indexing pass */
  deleteAttention: $uncostedFn(deleteAttention),

  // Resolution and text
  /** @complexity Expected O(P + log A) cold, O(log P + log A) cached, for bounded-length, well-distributed IDs */
  resolveAttention: $uncostedFn(resolveAttention),
  /** @complexity Identity lookup plus bytes read. Cold indexing is expected O(P) for bounded-length, well-distributed IDs */
  getTextForAttention: $uncostedFn(getTextForAttention),

  // Queries
  /** @complexity O(n + A) — one tree walk to index pieces, O(1) per attention */
  findAttentionsAt: $uncostedFn(findAttentionsAt),
  /** @complexity O(n + A) — one tree walk to index pieces, O(1) per attention */
  findAttentionsOverlapping: $uncostedFn(findAttentionsOverlapping),

  // Edit support
  /** @complexity Piece-table insert plus indexed annotation migration */
  insertWithAttention: $uncostedFn(insertWithAttention),
  /** @complexity Tree deletion plus indexed annotation migration */
  deleteWithAttention: $uncostedFn(deleteWithAttention),
  /** @complexity O((S + C) log A) after indexing, for S splits and C candidate annotations */
  migrateSplits: $uncostedFn(migrateSplits),
  /** @complexity Visits cut pieces and their candidate annotations, with logarithmic index updates */
  migrateDelete: $uncostedFn(migrateDelete),
};
