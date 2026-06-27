/**
 * Tests for the Attention Layer's integration with the store dispatch path:
 * - DocumentState carries an AttentionLayerState.
 * - CREATE_ATTENTION / DELETE_ATTENTION mutate it through dispatch.
 * - Content edits (INSERT/DELETE/REPLACE/APPLY_REMOTE/UNDO/REDO) migrate the
 *   anchored points automatically.
 * - The `attention-change` event fires on create/delete and on re-anchoring.
 */

import { describe, it, expect, vi } from "vitest";
import { byteOffset, byteLength, attentionID, type AttentionID } from "../../types/branded.js";
import type { DocumentState } from "../../types/state.js";
import { createInitialState } from "../core/state.js";
import {
  emptyAttentionLayerState,
  getTextForAttention,
  resolveAttention,
} from "../core/attention.js";
import { DocumentActions } from "./actions.js";
import { createDocumentStore, createDocumentStoreWithEvents } from "./store.js";

/** The single attention id present in a snapshot's layer (tests create exactly one). */
function onlyId(state: DocumentState): AttentionID {
  const ids = [...state.attention.attentions.keys()];
  expect(ids).toHaveLength(1);
  return ids[0]!;
}

describe("DocumentState.attention", () => {
  it("a fresh state carries the empty attention layer", () => {
    const state = createInitialState({ content: "hello world" });
    expect(state.attention).toBe(emptyAttentionLayerState);
    expect(state.attention.attentions.size).toBe(0);
    expect(state.attention.nextID).toBe(0);
  });
});

describe("CREATE_ATTENTION / DELETE_ATTENTION dispatch", () => {
  it("CREATE_ATTENTION mints a resolvable attention over the span", () => {
    const store = createDocumentStore({ content: "hello world" });
    store.dispatch(DocumentActions.createAttention(byteOffset(6), byteOffset(11)));
    const snap = store.getSnapshot();
    const id = onlyId(snap);
    expect(id).toBe(attentionID("a0")); // deterministic mint from nextID
    expect(getTextForAttention(snap.pieceTable, snap.attention, id)).toBe("world");
  });

  it("does not increment revision (content-neutral) but yields a new state reference", () => {
    const store = createDocumentStore({ content: "hello world" });
    const before = store.getSnapshot();
    store.dispatch(DocumentActions.createAttention(byteOffset(0), byteOffset(5)));
    const after = store.getSnapshot();
    expect(after).not.toBe(before);
    expect(after.revision).toBe(before.revision);
  });

  it("notifies subscribers on create", () => {
    const store = createDocumentStore({ content: "hello world" });
    const listener = vi.fn();
    store.subscribe(listener);
    store.dispatch(DocumentActions.createAttention(byteOffset(0), byteOffset(5)));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("DELETE_ATTENTION removes the attention", () => {
    const store = createDocumentStore({ content: "hello world" });
    store.dispatch(DocumentActions.createAttention(byteOffset(6), byteOffset(11)));
    const id = onlyId(store.getSnapshot());
    store.dispatch(DocumentActions.deleteAttention(id));
    expect(store.getSnapshot().attention.attentions.size).toBe(0);
  });

  it("DELETE_ATTENTION with an unknown id is a no-op (same reference)", () => {
    const store = createDocumentStore({ content: "hello world" });
    const before = store.getSnapshot();
    store.dispatch(DocumentActions.deleteAttention(attentionID("nope")));
    expect(store.getSnapshot()).toBe(before);
  });

  it("CREATE_ATTENTION against an empty document is a no-op", () => {
    const store = createDocumentStore({ content: "" });
    const before = store.getSnapshot();
    store.dispatch(DocumentActions.createAttention(byteOffset(0), byteOffset(0)));
    expect(store.getSnapshot()).toBe(before);
    expect(store.getSnapshot().attention.attentions.size).toBe(0);
  });
});

describe("attention migration across content edits", () => {
  function storeWithWorldAttention() {
    const store = createDocumentStore({ content: "hello world" });
    store.dispatch(DocumentActions.createAttention(byteOffset(6), byteOffset(11)));
    return { store, id: onlyId(store.getSnapshot()) };
  }

  const textOf = (store: ReturnType<typeof createDocumentStore>, id: AttentionID) => {
    const snap = store.getSnapshot();
    return getTextForAttention(snap.pieceTable, snap.attention, id);
  };

  it("INSERT before the span: attention follows the text (spec §7)", () => {
    const { store, id } = storeWithWorldAttention();
    store.dispatch(DocumentActions.insert(byteOffset(0), ">> "));
    expect(textOf(store, id)).toBe("world");
  });

  it("INSERT inside the span widens it", () => {
    const { store, id } = storeWithWorldAttention();
    store.dispatch(DocumentActions.insert(byteOffset(8), "XYZ"));
    expect(textOf(store, id)).toBe("woXYZrld");
  });

  it("DELETE before the span shifts it left", () => {
    const { store, id } = storeWithWorldAttention();
    store.dispatch(DocumentActions.delete(byteOffset(0), byteOffset(6)));
    expect(textOf(store, id)).toBe("world");
  });

  it("DELETE covering the span collapses it to an empty range", () => {
    const { store, id } = storeWithWorldAttention();
    store.dispatch(DocumentActions.delete(byteOffset(4), byteOffset(11)));
    expect(textOf(store, id)).toBe("");
    // Still resolvable (not dangling): a zero-width range at the cut point.
    const snap = store.getSnapshot();
    const range = resolveAttention(snap.pieceTable.root, snap.attention, id);
    expect(range).not.toBeNull();
    expect(range!.startOffset).toBe(range!.endOffset);
  });

  it("REPLACE before the span keeps it anchored", () => {
    const { store, id } = storeWithWorldAttention();
    store.dispatch(DocumentActions.replace(byteOffset(0), byteOffset(5), "HI"));
    expect(textOf(store, id)).toBe("world");
  });

  it("survives an UNDO/REDO round-trip", () => {
    const { store, id } = storeWithWorldAttention();
    store.dispatch(DocumentActions.insert(byteOffset(0), ">> "));
    expect(textOf(store, id)).toBe("world");
    store.dispatch(DocumentActions.undo());
    expect(textOf(store, id)).toBe("world");
    store.dispatch(DocumentActions.redo());
    expect(textOf(store, id)).toBe("world");
  });

  it("migrates across an APPLY_REMOTE insert before the span", () => {
    const { store, id } = storeWithWorldAttention();
    store.dispatch(
      DocumentActions.applyRemote([{ type: "insert", start: byteOffset(0), text: "AB" }]),
    );
    expect(textOf(store, id)).toBe("world");
  });

  it("migrates across an APPLY_REMOTE delete before the span", () => {
    const { store, id } = storeWithWorldAttention();
    store.dispatch(
      DocumentActions.applyRemote([
        { type: "delete", start: byteOffset(0), length: byteLength(3) },
      ]),
    );
    expect(textOf(store, id)).toBe("world");
  });
});

describe("attention-change event", () => {
  it("fires on CREATE_ATTENTION with the new id in changedIds", () => {
    const store = createDocumentStoreWithEvents({ content: "hello world" });
    const handler = vi.fn();
    store.addEventListener("attention-change", handler);

    store.dispatch(DocumentActions.createAttention(byteOffset(6), byteOffset(11)));

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0]![0];
    expect(event.type).toBe("attention-change");
    expect(event.changedIds).toEqual([attentionID("a0")]);
  });

  it("fires on DELETE_ATTENTION", () => {
    const store = createDocumentStoreWithEvents({ content: "hello world" });
    store.dispatch(DocumentActions.createAttention(byteOffset(6), byteOffset(11)));
    const id = onlyId(store.getSnapshot());

    const handler = vi.fn();
    store.addEventListener("attention-change", handler);
    store.dispatch(DocumentActions.deleteAttention(id));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]![0].changedIds).toEqual([id]);
  });

  it("fires on a content edit that re-anchors a stored point (split rewrite)", () => {
    const store = createDocumentStoreWithEvents({ content: "hello world" });
    store.dispatch(DocumentActions.createAttention(byteOffset(6), byteOffset(11)));
    const id = onlyId(store.getSnapshot());

    const handler = vi.fn();
    store.addEventListener("attention-change", handler);
    // Insert *inside* the span: splits the anchored piece, so the end point's
    // stored {pieceID, boundary} is rewritten to the right half.
    store.dispatch(DocumentActions.insert(byteOffset(8), "XYZ"));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]![0].changedIds).toContain(id);
  });

  it("fires on a delete that re-anchors a stored point", () => {
    const store = createDocumentStoreWithEvents({ content: "hello world" });
    store.dispatch(DocumentActions.createAttention(byteOffset(6), byteOffset(11)));
    const id = onlyId(store.getSnapshot());

    const handler = vi.fn();
    store.addEventListener("attention-change", handler);
    store.dispatch(DocumentActions.delete(byteOffset(0), byteOffset(3)));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]![0].changedIds).toContain(id);
  });

  it("does not fire when an insert before the span only shifts resolution (no stored-point change)", () => {
    const store = createDocumentStoreWithEvents({ content: "hello world" });
    store.dispatch(DocumentActions.createAttention(byteOffset(6), byteOffset(11)));

    const handler = vi.fn();
    store.addEventListener("attention-change", handler);
    // Insert at offset 0 prepends a new piece without splitting the anchored one,
    // so the stored points are unchanged — resolution shifts for free.
    store.dispatch(DocumentActions.insert(byteOffset(0), ">> "));

    expect(handler).not.toHaveBeenCalled();
  });

  it("buffers within a transaction and flushes on commit", () => {
    const store = createDocumentStoreWithEvents({ content: "hello world" });
    const handler = vi.fn();
    store.addEventListener("attention-change", handler);

    store.beginTransaction();
    store.dispatch(DocumentActions.createAttention(byteOffset(6), byteOffset(11)));
    expect(handler).not.toHaveBeenCalled();
    store.commitTransaction();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("discards buffered events on rollback", () => {
    const store = createDocumentStoreWithEvents({ content: "hello world" });
    const handler = vi.fn();
    store.addEventListener("attention-change", handler);

    store.beginTransaction();
    store.dispatch(DocumentActions.createAttention(byteOffset(6), byteOffset(11)));
    store.rollbackTransaction();

    expect(handler).not.toHaveBeenCalled();
    expect(store.getSnapshot().attention.attentions.size).toBe(0);
  });
});
