import { describe, expect, it } from "vitest";
import {
  attention,
  diff,
  events,
  history,
  position,
  query,
  rendering,
  scan,
  store,
} from "./index.js";

describe("public package entry point", () => {
  it("initializes every runtime namespace", () => {
    expect(attention.emptyState).toBeDefined();
    expect(diff.diff).toBeTypeOf("function");
    expect(events.createEventEmitter).toBeTypeOf("function");
    expect(history.canUndo).toBeTypeOf("function");
    expect(query.getLength).toBeTypeOf("function");
    expect(rendering.getVisibleLines).toBeTypeOf("function");
    expect(scan.getValue).toBeTypeOf("function");
    expect(store.createDocumentStore).toBeTypeOf("function");
  });

  it("executes façade-defined position and eviction helpers", () => {
    const documentStore = store.createDocumentStore({
      content: "😀x",
      reconcileMode: "none",
    });
    const state = documentStore.getEagerSnapshot();

    expect(position.selectionRange(0, 2, state)).toEqual({ anchor: 0, head: 4 });
    expect(store.didEvict(state, state, 0)).toBe(false);
    documentStore.dispose();

    const chunkStore = store.createDocumentStore({ chunkSize: 8, reconcileMode: "none" });
    chunkStore.dispatch(store.DocumentActions.loadChunk(0, new TextEncoder().encode("abcdefgh")));
    const beforeEviction = chunkStore.getSnapshot();
    chunkStore.dispatch(store.DocumentActions.evictChunk(0));
    const afterEviction = chunkStore.getSnapshot();

    expect(store.didEvict(beforeEviction, afterEviction, 0)).toBe(true);
    chunkStore.dispose();
  });
});
