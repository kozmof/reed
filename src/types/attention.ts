/**
 * Attention Layer data types — the piece-anchored reference system that forms
 * Reed's third independent layer (alongside the piece table and line index).
 *
 * These are the pure, dependency-light state shapes. The operations that read
 * and migrate them live in `src/store/core/attention.ts`, which re-exports
 * everything here so the attention module's public surface stays self-contained.
 *
 * They live in `types/` (importing only from `./branded.js`) so that
 * `DocumentState` in `state.ts` can carry an `AttentionLayerState` without
 * creating a `types → store → types` import cycle.
 */

import type { ByteOffset, PieceID, AttentionID } from "./branded.js";

// `PieceID` and `AttentionID` are branded string identities defined in branded.ts.
// Re-exported here so the Attention Layer's data surface stays self-contained.
export type { PieceID, AttentionID } from "./branded.js";

/**
 * A position anchored to a piece rather than to a document offset.
 * `boundary` is the byte count from the piece's start to this position,
 * i.e. the gap *before* byte `boundary` and *after* byte `boundary - 1`.
 * Valid range: 0 (before first byte) to piece.length (after last byte).
 */
export interface AttentionPoint {
  readonly pieceID: PieceID;
  readonly boundary: number;
}

/**
 * A reference into mutable text.
 * Covers all bytes whose piece-relative position falls in [start, end).
 *
 * Reed stores only the two boundary points.
 * Structure (groups, trees, ASTs) is the caller's responsibility.
 */
export interface Attention {
  readonly id: AttentionID;
  readonly start: AttentionPoint;
  readonly end: AttentionPoint;
}

/**
 * Immutable Attention Layer state.
 * Lives alongside the piece table and line index as the third Reed layer.
 */
export interface AttentionLayerState {
  readonly attentions: ReadonlyMap<AttentionID, Attention>;
  /**
   * Monotonic counter for minting fresh AttentionIDs, scoped to this layer's
   * history rather than the process. Keeps IDs deterministic across runs and
   * stable for serialization. Carried forward by every state-returning op.
   */
  readonly nextID: number;
}

/** A resolved Attention's current document span, half-open `[startOffset, endOffset)`. */
export interface ResolvedRange {
  readonly startOffset: ByteOffset;
  readonly endOffset: ByteOffset;
}
