/**
 * Events namespace — event emitter factory and document event creators.
 */

import {
  createEventEmitter,
  createContentChangeEvent,
  createSelectionChangeEvent,
  createHistoryChangeEvent,
  createSaveEvent,
  createDirtyChangeEvent,
  getAffectedRanges,
} from "../store/features/events.js";

export const events = {
  createEventEmitter,
  createContentChangeEvent,
  createSelectionChangeEvent,
  createHistoryChangeEvent,
  createSaveEvent,
  createDirtyChangeEvent,
  getAffectedRanges,
} as const;
