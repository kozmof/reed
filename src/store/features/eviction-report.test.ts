/**
 * Test that an awaited eviction is answered only by the store it was awaited
 * on, whatever other stores commit meanwhile.
 */

import { describe, it, expect, vi } from "vitest";
import {
  attachEvictionTap,
  createEvictionTap,
  dispatchEviction,
  evictionTapOf,
  EVICTION_TAP,
} from "./eviction-report.js";
import { createDocumentStore, createDocumentStoreWithEvents } from "./store.js";
import { DocumentActions } from "./actions.js";
import type { DocumentStore } from "../../types/store.js";

const evict = DocumentActions.evictChunks([0], 1);

describe("eviction taps", () => {
  it("ignores a matching eviction another store commits from the same history", () => {
    const store = createDocumentStore({ content: "hello" });
    const before = store.getSnapshot();
    const tap = createEvictionTap();
    const mirrorTap = createEvictionTap();
    // A store whose dispatch first sends the eviction to a mirror that holds
    // the very same history object, and loses history there.
    const lost = { ...before.history };
    const wrapped = attachEvictionTap(
      {
        ...store,
        dispatch: (action: Parameters<DocumentStore["dispatch"]>[0]) => {
          mirrorTap.record(action, before.history, lost as never, false);
          tap.record(action, before.history, before.history, false);
          return store.getSnapshot();
        },
      },
      tap,
    );
    const onDropped = vi.fn();
    dispatchEviction(wrapped, before, evict, onDropped);
    expect(onDropped).not.toHaveBeenCalled();
  });

  it("reports what the awaited store's own commit discarded", () => {
    const store = createDocumentStore({ content: "hello" });
    const before = store.getSnapshot();
    const tap = createEvictionTap();
    const lost = { ...before.history };
    const wrapped = attachEvictionTap(
      {
        ...store,
        dispatch: (action: Parameters<DocumentStore["dispatch"]>[0]) => {
          tap.record({ ...action } as typeof action, before.history, lost as never, false);
          return store.getSnapshot();
        },
      },
      tap,
    );
    const onDropped = vi.fn();
    dispatchEviction(wrapped, before, evict, onDropped);
    expect(onDropped).toHaveBeenCalledWith({ from: before.history, to: lost });
  });

  it("is carried by every store Reed builds and by a spread copy of one", () => {
    const store = createDocumentStore();
    const events = createDocumentStoreWithEvents();
    expect(evictionTapOf(store)).toBeDefined();
    expect(evictionTapOf({ ...store })).toBe(evictionTapOf(store));
    expect(evictionTapOf(events)).toBeDefined();
    expect(evictionTapOf({ ...events })).toBe(evictionTapOf(events));
  });

  it("ignores a value under the key that no store put there", () => {
    expect(evictionTapOf({ [EVICTION_TAP]: { record: () => null } })).toBeUndefined();
  });
});
