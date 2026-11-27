/** The events namespace creates event emitters and document events. */

import {
  createEventEmitter,
  createStoreEventEmitter,
  createContentChangeEvent,
  createSelectionChangeEvent,
  createHistoryChangeEvent,
  createHistoryDropEvent,
  createAttentionChangeEvent,
  createSaveEvent,
  createDirtyChangeEvent,
  diffChangedAttentionIds,
  getAffectedRanges,
} from "../store/features/events.js";

export const events = {
  createEventEmitter,
  createStoreEventEmitter,
  createContentChangeEvent,
  createSelectionChangeEvent,
  createHistoryChangeEvent,
  createHistoryDropEvent,
  createAttentionChangeEvent,
  createSaveEvent,
  createDirtyChangeEvent,
  diffChangedAttentionIds,
  getAffectedRanges,
} as const;
