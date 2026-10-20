/**
 * The attention namespace tracks references to text across edits.
 *
 * An attention stores two piece boundaries to track a text range. Piece IDs
 * survive tree rotations and rebalancing. Use the edit helpers below to migrate
 * boundaries when inserts split pieces or deletes remove tracked text.
 *
 * Pass the current, immutable `AttentionLayerState` into each operation and
 * keep the returned state. Start from `emptyState`.
 *
 * Use `insertWithAttention` / `deleteWithAttention` to advance the piece table
 * and attention layer together. A dangling point resolves to `null`.
 *
 * Core operations use `cost-doc` annotations to track declared costs when
 * composing functions. These annotations do not verify runtime performance.
 * Public wrappers remove cost brands. See the `@complexity` tags below.
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
  /** Empty attention state to use as the initial value. */
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
  /**
   * @complexity O(P + A log A) to build the snapshot index. Cached queries visit
   * matching intervals and boundary paths, then sort K results in O(K log K).
   */
  findAttentionsAt: $uncostedFn(findAttentionsAt),
  /**
   * @complexity O(P + A log A) to build the snapshot index. Cached queries visit
   * matching intervals and boundary paths, then sort K results in O(K log K).
   */
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
