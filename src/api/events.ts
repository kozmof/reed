/**
 * Events namespace — event emitter factory and document event creators.
 */

import {
  createEventEmitter,
  createContentChangeEvent,
  createSelectionChangeEvent,
  createHistoryChangeEvent,
  createAttentionChangeEvent,
  createSaveEvent,
  createDirtyChangeEvent,
  diffChangedAttentionIds,
  getAffectedRanges,
} from "../store/features/events.js";

export const events = {
  createEventEmitter,
  createContentChangeEvent,
  createSelectionChangeEvent,
  createHistoryChangeEvent,
  createAttentionChangeEvent,
  createSaveEvent,
  createDirtyChangeEvent,
  diffChangedAttentionIds,
  getAffectedRanges,
} as const;
