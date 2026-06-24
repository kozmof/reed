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
  insertWithAttention,
  deleteWithAttention,
} from "../store/core/attention.js";

export const attention = {
  /** Empty AttentionLayerState — the initial value. */
  emptyState: emptyAttentionLayerState,

  // Points
  createPoint,
  resolvePoint,

  // Attentions
  createAttention,
  getAttention,
  deleteAttention,

  // Resolution and text
  resolveAttention,
  getTextForAttention,

  // Queries
  findAttentionsAt,
  findAttentionsOverlapping,

  // Edit support
  insertWithAttention,
  deleteWithAttention,
  migrateSplits,
};
