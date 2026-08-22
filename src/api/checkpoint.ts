/**
 * Checkpoint namespace — capture a document state as JSON-safe data and load it
 * back without replaying the edits that produced it.
 *
 * `store.getSnapshot()` returns an in-memory `DocumentState`; a *checkpoint* is
 * that state serialized. Capture takes a `DocumentState<'eager'>`, so reach for
 * `store.getEagerSnapshot()` (or `await store.whenReconciled()`) rather than
 * `getSnapshot()` — a checkpoint never carries pending reconciliation work.
 *
 * Restore is fail-closed: a payload that would violate a piece-table or
 * line-index invariant raises `CheckpointError` instead of loading.
 *
 * @example
 * ```ts
 * import { store, checkpoint } from "@kozmof/reed";
 *
 * const saved = checkpoint.encode(doc.getEagerSnapshot());
 * localStorage.setItem("draft", saved);
 *
 * const restored = store.createDocumentStoreFromCheckpoint(
 *   JSON.parse(localStorage.getItem("draft")!),
 * );
 * ```
 *
 * @see store.createDocumentStoreFromCheckpoint — restore straight into a live store
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
