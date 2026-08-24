import { describe, expect, it } from "vitest";
import {
  attention,
  checkpoint,
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
    expect(checkpoint.create).toBeTypeOf("function");
    expect(diff.diff).toBeTypeOf("function");
    expect(events.createEventEmitter).toBeTypeOf("function");
    expect(history.canUndo).toBeTypeOf("function");
    expect(query.getLength).toBeTypeOf("function");
    expect(rendering.getVisibleLines).toBeTypeOf("function");
    expect(scan.getValue).toBeTypeOf("function");
    expect(store.createDocumentStore).toBeTypeOf("function");
  });

  it("round-trips a store through the checkpoint namespace", () => {
    const documentStore = store.createDocumentStore({
      content: "checkpoint me",
      reconcileMode: "none",
    });
    documentStore.dispatch(store.DocumentActions.insert(position.byteOffset(0), "please "));

    const encoded = checkpoint.encode(documentStore.getEagerSnapshot());
    expect(checkpoint.isCheckpoint(JSON.parse(encoded))).toBe(true);

    const restored = store.createDocumentStoreFromCheckpoint(JSON.parse(encoded));
    expect(scan.getValue(restored.getSnapshot().pieceTable)).toBe("please checkpoint me");

    documentStore.dispose();
    restored.dispose();
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

  it("validates untrusted actions and replaces a live store value", () => {
    const documentStore = store.createDocumentStore({ content: "Hello😀World" });
    expect(() =>
      store.dispatchValidated(documentStore, { type: "INSERT", start: 0.5, text: "x" }),
    ).toThrow(/integer/);

    const inserted = store.dispatchValidated(documentStore, {
      type: "INSERT",
      start: 0,
      text: ">> ",
    });
    expect(scan.getValue(inserted.pieceTable)).toBe(">> Hello😀World");
    const next = store.setValue(documentStore, "Hello😂World", { strategy: "diff" });
    expect(next).toBe(documentStore.getSnapshot());
    expect(scan.getValue(next.pieceTable)).toBe("Hello😂World");

    const fast = store.setValue(documentStore, "fast replacement");
    expect(scan.getValue(fast.pieceTable)).toBe("fast replacement");
    expect(store.setValue(documentStore, "fast replacement")).toBe(fast);
    expect(() => store.setValue(documentStore, 123 as unknown as string)).toThrow(
      /must be a string/,
    );
    documentStore.dispose();
  });
});
