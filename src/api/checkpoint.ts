/**
 * The checkpoint namespace captures a document state as JSON-safe data and loads
 * it without replaying the edits that produced it.
 *
 * `store.getSnapshot()` returns an in-memory `DocumentState`. A checkpoint
 * serializes that state. Capture takes a `DocumentState<'eager'>`, so reach for
 * `store.getEagerSnapshot()` (or `await store.whenReconciled()`) rather than
 * `getSnapshot()`. Checkpoints never carry pending reconciliation work.
 *
 * Restore fails closed. A payload that would violate a piece-table or
 * line-index invariant raises `CheckpointError` instead of loading.
 * Add restore limits when input comes from outside the application.
 *
 * @example
 * ```ts
 * import { checkpoint } from "@kozmof/reed";
 *
 * const saved = checkpoint.encode(doc.getEagerSnapshot());
 * localStorage.setItem("draft", saved);
 *
 * const restored = checkpoint.decode(localStorage.getItem("draft")!, {
 *   maxJsonLength: 10_000_000,
 *   maxBufferBytes: 8_000_000,
 *   maxPieces: 100_000,
 *   maxLines: 500_000,
 * });
 * ```
 *
 * @see store.createDocumentStoreFromCheckpoint to restore straight into a live store
 */

import {
  createCheckpoint,
  restoreCheckpoint,
  encodeCheckpoint,
  decodeCheckpoint,
  isCheckpoint,
} from "../store/features/checkpoint.js";
import type { CheckpointApi } from "./interfaces.js";

export const checkpoint: CheckpointApi = {
  /** @complexity O(n) — one pass over the pieces, lines, and history */
  create: createCheckpoint,
  /** @complexity O(n) — validates every piece and line, then bulk-builds both trees */
  restore: restoreCheckpoint,
  /** @complexity O(n) — capture plus JSON.stringify */
  encode: encodeCheckpoint,
  /** @complexity O(n) — JSON.parse plus restore */
  decode: decodeCheckpoint,
  /** @complexity O(1) — envelope fields only; restore does the full validation */
  isCheckpoint,
};
