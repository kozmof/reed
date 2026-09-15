/**
 * Save lifecycle.
 *
 * A public `save` event type and `createSaveEvent` factory existed from the
 * start, but nothing in the reducer or store ever caused one: `isDirty` was only
 * ever set to `true`, and no transition returned a document to clean. The event
 * therefore promised a lifecycle Reed did not provide.
 *
 * `MARK_SAVED` closes that gap. Reed still performs no I/O — the caller persists
 * the document and then reports the result — so no event here asserts that bytes
 * reached durable storage, only that the caller said they did.
 */

import { describe, expect, it, vi } from "vitest";
import { byteOffset } from "../../types/branded.js";
import { DocumentActions } from "./actions.js";
import { createDocumentStore, createDocumentStoreWithEvents, withTransaction } from "./store.js";
import { documentReducer } from "./reducer.js";
import { createInitialState } from "../core/state.js";
import { validateAction } from "../../types/actions.js";

describe("MARK_SAVED reducer", () => {
  it("clears the dirty flag and stamps the save time", () => {
    let state = createInitialState({ content: "reed" });
    state = documentReducer(state, DocumentActions.insert(byteOffset(0), "x"));
    expect(state.metadata.isDirty).toBe(true);

    const saved = documentReducer(state, DocumentActions.markSaved(1_700_000_000_000));

    expect(saved.metadata.isDirty).toBe(false);
    expect(saved.metadata.lastSaved).toBe(1_700_000_000_000);
    expect(saved.revision).toBe(state.revision + 1);
  });

  it("defaults the timestamp to dispatch time", () => {
    const before = Date.now();
    let state = createInitialState({ content: "reed" });
    state = documentReducer(state, DocumentActions.insert(byteOffset(0), "x"));
    const saved = documentReducer(state, DocumentActions.markSaved());

    expect(saved.metadata.lastSaved).toBeGreaterThanOrEqual(before);
    expect(saved.metadata.lastSaved).toBeLessThanOrEqual(Date.now());
  });

  it("is a no-op when the document is already clean at the same timestamp", () => {
    let state = createInitialState({ content: "reed" });
    state = documentReducer(state, DocumentActions.insert(byteOffset(0), "x"));
    const saved = documentReducer(state, DocumentActions.markSaved(42));
    const again = documentReducer(saved, DocumentActions.markSaved(42));

    expect(again, "repeated save must not churn the revision").toBe(saved);
  });

  it("leaves the document clean after a save even if edits are undone", () => {
    let state = createInitialState({ content: "reed" });
    state = documentReducer(state, DocumentActions.insert(byteOffset(0), "x"));
    state = documentReducer(state, DocumentActions.markSaved(1));
    state = documentReducer(state, DocumentActions.insert(byteOffset(0), "y"));

    expect(state.metadata.isDirty, "an edit after a save re-dirties").toBe(true);
    expect(state.metadata.lastSaved, "the save time survives later edits").toBe(1);
  });

  it("re-dirties on a remote change applied after a save", () => {
    let state = createInitialState({ content: "abc" });
    state = documentReducer(state, DocumentActions.markSaved(1));
    state = documentReducer(
      state,
      DocumentActions.applyRemote([{ type: "insert", start: byteOffset(0), text: "X" }]),
    );

    expect(state.metadata.isDirty).toBe(true);
  });
});

describe("MARK_SAVED validation", () => {
  it("accepts an absent or valid timestamp", () => {
    expect(validateAction({ type: "MARK_SAVED" }).valid).toBe(true);
    expect(validateAction({ type: "MARK_SAVED", timestamp: 0 }).valid).toBe(true);
  });

  it("rejects a non-finite or negative timestamp", () => {
    expect(validateAction({ type: "MARK_SAVED", timestamp: Number.NaN }).valid).toBe(false);
    expect(validateAction({ type: "MARK_SAVED", timestamp: -1 }).valid).toBe(false);
    expect(validateAction({ type: "MARK_SAVED", timestamp: "now" }).valid).toBe(false);
  });
});

describe("save events", () => {
  it("emits save then dirty-change, in that order", () => {
    const store = createDocumentStoreWithEvents({ content: "reed", reconcileMode: "none" });
    const order: string[] = [];
    store.addEventListener("save", () => order.push("save"));
    store.addEventListener("dirty-change", () => order.push("dirty-change"));

    store.dispatch(DocumentActions.insert(byteOffset(0), "x"));
    order.length = 0;
    store.dispatch(DocumentActions.markSaved());

    expect(order).toEqual(["save", "dirty-change"]);
    store.dispose();
  });

  it("emits save even when the document was already clean", () => {
    const store = createDocumentStoreWithEvents({ content: "reed", reconcileMode: "none" });
    const save = vi.fn();
    const dirty = vi.fn();
    store.addEventListener("save", save);
    store.addEventListener("dirty-change", dirty);

    store.dispatch(DocumentActions.markSaved(1));

    // A save of a clean document is still a save; there is simply no dirty
    // transition to report.
    expect(save).toHaveBeenCalledTimes(1);
    expect(dirty).not.toHaveBeenCalled();
    store.dispose();
  });

  it("never emits save for an ordinary edit", () => {
    const store = createDocumentStoreWithEvents({ content: "reed", reconcileMode: "none" });
    const save = vi.fn();
    store.addEventListener("save", save);

    store.dispatch(DocumentActions.insert(byteOffset(0), "x"));
    store.dispatch(DocumentActions.delete(byteOffset(0), byteOffset(1)));

    expect(save, "save is reported by the caller, never inferred").not.toHaveBeenCalled();
    store.dispose();
  });

  it("carries the committed state on the event", () => {
    const store = createDocumentStoreWithEvents({ content: "reed", reconcileMode: "none" });
    const save = vi.fn();
    store.addEventListener("save", save);

    store.dispatch(DocumentActions.insert(byteOffset(0), "x"));
    store.dispatch(DocumentActions.markSaved(99));

    expect(save.mock.calls[0]![0].state.metadata.isDirty).toBe(false);
    expect(save.mock.calls[0]![0].state.metadata.lastSaved).toBe(99);
    store.dispose();
  });

  it("isolates a throwing save listener from the transition", () => {
    const store = createDocumentStoreWithEvents({ content: "reed", reconcileMode: "none" });
    store.addEventListener("save", () => {
      throw new Error("listener failure");
    });
    const later = vi.fn();
    store.addEventListener("dirty-change", later);

    // The insert itself flips clean -> dirty, so discard that first
    // dirty-change and count only the one the save causes.
    store.dispatch(DocumentActions.insert(byteOffset(0), "x"));
    later.mockClear();

    expect(() => store.dispatch(DocumentActions.markSaved())).not.toThrow();

    expect(store.getSnapshot().metadata.isDirty, "state still committed").toBe(false);
    expect(later, "a failing listener must not starve the next one").toHaveBeenCalledTimes(1);
    store.dispose();
  });

  it("defers the save event until a transaction commits", () => {
    const store = createDocumentStoreWithEvents({ content: "reed", reconcileMode: "none" });
    const save = vi.fn();
    store.addEventListener("save", save);

    store.beginTransaction();
    store.dispatch(DocumentActions.insert(byteOffset(0), "x"));
    store.dispatch(DocumentActions.markSaved());
    expect(save, "buffered until commit").not.toHaveBeenCalled();

    store.commitTransaction();
    expect(save).toHaveBeenCalledTimes(1);
    store.dispose();
  });

  it("drops the save event and the clean state when a transaction rolls back", () => {
    const store = createDocumentStoreWithEvents({ content: "reed", reconcileMode: "none" });
    const save = vi.fn();
    store.addEventListener("save", save);
    store.dispatch(DocumentActions.insert(byteOffset(0), "x"));

    expect(() =>
      withTransaction(store, (inner) => {
        inner.dispatch(DocumentActions.markSaved());
        throw new Error("persist failed");
      }),
    ).toThrow("persist failed");

    expect(save, "a rolled-back save never happened").not.toHaveBeenCalled();
    expect(store.getSnapshot().metadata.isDirty, "document stays dirty").toBe(true);
    store.dispose();
  });
});

describe("save round trip", () => {
  it("survives action serialization", () => {
    const action = DocumentActions.markSaved(1234);
    const roundTripped = JSON.parse(JSON.stringify(action)) as typeof action;

    const store = createDocumentStore({ content: "reed", reconcileMode: "none" });
    store.dispatch(DocumentActions.insert(byteOffset(0), "x"));
    store.dispatch(roundTripped);

    expect(store.getSnapshot().metadata.isDirty).toBe(false);
    expect(store.getSnapshot().metadata.lastSaved).toBe(1234);
    store.dispose();
  });
});
