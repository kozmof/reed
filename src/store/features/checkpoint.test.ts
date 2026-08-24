/**
 * Tests for checkpoint capture and restore.
 *
 * Three things have to hold for a checkpoint to be worth having:
 * the restored document reads identically, it keeps editing correctly
 * (identities and allocator cursors survive), and a payload that would corrupt
 * it is refused rather than loaded.
 */

import { describe, it, expect } from "vitest";
import {
  createCheckpoint,
  restoreCheckpoint,
  encodeCheckpoint,
  decodeCheckpoint,
  isCheckpoint,
} from "./checkpoint.js";
import {
  createDocumentStore,
  createDocumentStoreFromCheckpoint,
  createDocumentStoreWithEventsFromCheckpoint,
} from "./store.js";
import { DocumentActions } from "./actions.js";
import { documentReducer } from "./reducer.js";
import { CheckpointError } from "../../types/checkpoint.js";
import type { DocumentCheckpoint } from "../../types/checkpoint.js";
import type { DocumentState } from "../../types/state.js";
import { pstackSize } from "../../types/state.js";
import { byteOffset } from "../../types/branded.js";
import { getValue, getText, collectPieces } from "../core/piece-table.js";
import {
  getLineCountFromIndex,
  getLineStartOffset,
  collectLines,
  assertEagerOffsets,
} from "../core/line-index.js";
import {
  createPoint,
  createAttention,
  resolveAttention,
  getTextForAttention,
} from "../core/attention.js";
import { createInitialState } from "../core/state.js";
import { textEncoder } from "../core/encoding.js";

const { insert, delete: del, replace, setSelection, undo, redo } = DocumentActions;

/** A checkpoint with every `readonly` stripped, so a test can corrupt one field. */
type Writable<T> = { -readonly [K in keyof T]: Writable<T[K]> };
type CheckpointDraft = Writable<DocumentCheckpoint>;

/** Deep-clone a checkpoint so a test can corrupt it in isolation. */
function clone(checkpoint: DocumentCheckpoint): CheckpointDraft {
  return JSON.parse(JSON.stringify(checkpoint)) as CheckpointDraft;
}

/** Mutate a cloned checkpoint and assert restore refuses it with `code`. */
function expectRejection(
  checkpoint: DocumentCheckpoint,
  corrupt: (draft: CheckpointDraft) => void,
  code: string,
): void {
  const draft = clone(checkpoint);
  corrupt(draft);
  try {
    restoreCheckpoint(draft);
  } catch (error) {
    expect(error).toBeInstanceOf(CheckpointError);
    expect((error as CheckpointError).code).toBe(code);
    return;
  }
  throw new Error(`expected restore to reject with ${code}`);
}

/** Run a restore and assert that its configured resource budget rejects it. */
function expectResourceLimit(run: () => unknown): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CheckpointError);
    expect((error as CheckpointError).code).toBe("RESOURCE_LIMIT");
    return;
  }
  throw new Error("expected restore to reject with RESOURCE_LIMIT");
}

/** A store carrying edits from every action that touches content. */
function editedStore() {
  const store = createDocumentStore({ content: "hello world\nsecond line\n" });
  store.dispatch(insert(byteOffset(5), ","));
  store.dispatch(replace(byteOffset(0), byteOffset(5), "HELLO"));
  store.dispatch(del(byteOffset(12), byteOffset(18)));
  store.dispatch(insert(byteOffset(6), "brave new "));
  store.dispatch(setSelection([{ anchor: byteOffset(3), head: byteOffset(7) }]));
  return store;
}

function expectSameDocument(restored: DocumentState<"eager">, original: DocumentState): void {
  expect(getValue(restored.pieceTable)).toBe(getValue(original.pieceTable));
  expect(restored.pieceTable.totalLength).toBe(original.pieceTable.totalLength);
  expect(getLineCountFromIndex(restored.lineIndex)).toBe(getLineCountFromIndex(original.lineIndex));
  expect(restored.revision).toBe(original.revision);
  expect(restored.selectionRevision).toBe(original.selectionRevision);
  expect(restored.selection).toEqual(original.selection);
  expect(restored.metadata).toEqual(original.metadata);

  const lineCount = getLineCountFromIndex(original.lineIndex);
  for (let line = 0; line < lineCount; line++) {
    expect(getLineStartOffset(restored.lineIndex.root, line)).toBe(
      getLineStartOffset(original.lineIndex.root, line),
    );
  }
}

describe("createCheckpoint / restoreCheckpoint", () => {
  it("round-trips an empty document", () => {
    const store = createDocumentStore();
    const state = store.getEagerSnapshot();
    const restored = restoreCheckpoint(createCheckpoint(state));

    expectSameDocument(restored, state);
    expect(getValue(restored.pieceTable)).toBe("");
    expect(getLineCountFromIndex(restored.lineIndex)).toBe(1);
    expect(restored.pieceTable.root).toBeNull();
  });

  it("round-trips an unedited document", () => {
    const store = createDocumentStore({ content: "line one\nline two\nline three" });
    const state = store.getEagerSnapshot();
    expectSameDocument(restoreCheckpoint(createCheckpoint(state)), state);
  });

  it("round-trips a document edited through every content action", () => {
    const state = editedStore().getEagerSnapshot();
    expectSameDocument(restoreCheckpoint(createCheckpoint(state)), state);
  });

  it("round-trips multi-byte text with byte-accurate line offsets", () => {
    const store = createDocumentStore({ content: "héllo wörld\n日本語のテキスト\n🎉 emoji\n" });
    store.dispatch(insert(byteOffset(0), "→ "));
    const state = store.getEagerSnapshot();
    const restored = restoreCheckpoint(createCheckpoint(state));

    expectSameDocument(restored, state);
    const lines = collectLines(restored.lineIndex.root);
    const originalLines = collectLines(state.lineIndex.root);
    expect(lines.map((l) => [l.lineLength, l.charLength])).toEqual(
      originalLines.map((l) => [l.lineLength, l.charLength]),
    );
  });

  it("round-trips through a JSON string", () => {
    const state = editedStore().getEagerSnapshot();
    const restored = decodeCheckpoint(encodeCheckpoint(state));
    expectSameDocument(restored, state);
  });

  it("produces a checkpoint that survives structuredClone-free JSON transport", () => {
    const checkpoint = createCheckpoint(editedStore().getEagerSnapshot());
    // Nothing in the payload may need a custom replacer/reviver.
    expect(JSON.parse(JSON.stringify(checkpoint))).toEqual(checkpoint);
  });

  it("restores a fully eager line index", () => {
    const store = createDocumentStore({ content: "a\n".repeat(50) });
    store.dispatch(insert(byteOffset(0), "x"));
    const restored = restoreCheckpoint(createCheckpoint(store.getEagerSnapshot()));

    expect(restored.lineIndex.rebuildPending).toBe(false);
    expect(restored.lineIndex.dirtyRanges).toEqual([]);
    expect(() => assertEagerOffsets(restored.lineIndex)).not.toThrow();
  });

  it("rebuilds a balanced tree that answers every line query", () => {
    const lineCount = 200;
    const content = Array.from({ length: lineCount }, (_, i) => `line ${i}`).join("\n");
    const state = createDocumentStore({ content }).getEagerSnapshot();
    const restored = restoreCheckpoint(createCheckpoint(state));

    for (let line = 0; line < lineCount; line++) {
      expect(getLineStartOffset(restored.lineIndex.root, line)).toBe(
        getLineStartOffset(state.lineIndex.root, line),
      );
    }
  });

  it("keeps the restored piece tree black-rooted", () => {
    const state = editedStore().getEagerSnapshot();
    const restored = restoreCheckpoint(createCheckpoint(state));
    expect(restored.pieceTable.root?.color).toBe("black");
    expect(restored.lineIndex.root?.color).toBe("black");
  });

  it("recomputes subtree aggregates rather than trusting the payload", () => {
    const state = editedStore().getEagerSnapshot();
    const restored = restoreCheckpoint(createCheckpoint(state));

    const check = (node: typeof restored.pieceTable.root): void => {
      if (node === null) return;
      expect(node.subtreeLength).toBe(
        node.length + (node.left?.subtreeLength ?? 0) + (node.right?.subtreeLength ?? 0),
      );
      expect(node.subtreeAddLength).toBe(
        (node.bufferType === "add" ? node.length : 0) +
          (node.left?.subtreeAddLength ?? 0) +
          (node.right?.subtreeAddLength ?? 0),
      );
      check(node.left);
      check(node.right);
    };
    check(restored.pieceTable.root);
  });
});

describe("editing after restore", () => {
  it("matches a store that was never checkpointed", () => {
    const live = editedStore();
    const restoredStore = createDocumentStore();
    const restored = restoreCheckpoint(createCheckpoint(live.getEagerSnapshot()));

    // Drive both with the same follow-up actions.
    const follow = [
      insert(byteOffset(0), "prefix "),
      insert(byteOffset(4), "-"),
      del(byteOffset(2), byteOffset(5)),
      replace(byteOffset(0), byteOffset(2), "ZZ"),
    ];

    let restoredState: DocumentState = restored;
    for (const action of follow) {
      restoredState = documentReducer(restoredState, action);
      live.dispatch(action);
    }

    expect(getValue(restoredState.pieceTable)).toBe(getValue(live.getSnapshot().pieceTable));
    expect(restoredStore).toBeDefined();
  });

  it("never reissues a live piece id", () => {
    const state = editedStore().getEagerSnapshot();
    const restored = restoreCheckpoint(createCheckpoint(state));
    const idsBefore = new Set(collectPieces(restored.pieceTable.root).map((p) => p.id));

    let next: DocumentState = restored;
    for (let i = 0; i < 20; i++) {
      next = documentReducer(next, insert(byteOffset(i), "x"));
    }

    const pieces = collectPieces(next.pieceTable.root);
    const ids = pieces.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);

    // Fresh pieces must not collide with identities that were already anchored.
    const fresh = ids.filter((id) => !idsBefore.has(id));
    expect(new Set(fresh).size).toBe(fresh.length);
  });

  it("carries the add buffer forward so existing add pieces still read", () => {
    const store = createDocumentStore({ content: "abc" });
    store.dispatch(insert(byteOffset(3), "-inserted-"));
    const state = store.getEagerSnapshot();
    const restored = restoreCheckpoint(createCheckpoint(state));

    expect(getText(restored.pieceTable, byteOffset(3), byteOffset(13))).toBe("-inserted-");
    const next = documentReducer(restored, insert(byteOffset(13), "+more"));
    expect(getValue(next.pieceTable)).toBe("abc-inserted-+more");
  });
});

describe("history across restore", () => {
  it("preserves both stacks and their depths", () => {
    const store = editedStore();
    store.dispatch(undo());
    const state = store.getEagerSnapshot();
    const restored = restoreCheckpoint(createCheckpoint(state));

    expect(pstackSize(restored.history.undoStack)).toBe(pstackSize(state.history.undoStack));
    expect(pstackSize(restored.history.redoStack)).toBe(pstackSize(state.history.redoStack));
    expect(restored.history.limit).toBe(state.history.limit);
    expect(restored.history.coalesceTimeout).toBe(state.history.coalesceTimeout);
  });

  it("undoes back to the original content", () => {
    const store = createDocumentStore({ content: "base" });
    store.dispatch(insert(byteOffset(4), " one"));
    store.dispatch(insert(byteOffset(8), " two"));
    const restored: DocumentState = restoreCheckpoint(createCheckpoint(store.getEagerSnapshot()));

    let state = documentReducer(restored, undo());
    expect(getValue(state.pieceTable)).toBe("base one");
    state = documentReducer(state, undo());
    expect(getValue(state.pieceTable)).toBe("base");
    state = documentReducer(state, redo());
    expect(getValue(state.pieceTable)).toBe("base one");
  });

  it("undoes a replace with the right displaced text", () => {
    const store = createDocumentStore({ content: "alpha beta" });
    store.dispatch(replace(byteOffset(0), byteOffset(5), "OMEGA"));
    const restored: DocumentState = restoreCheckpoint(createCheckpoint(store.getEagerSnapshot()));

    expect(getValue(documentReducer(restored, undo()).pieceTable)).toBe("alpha beta");
  });

  it("preserves history whose selections point past the current document", () => {
    const store = createDocumentStore({ content: "" });
    store.dispatch(insert(byteOffset(0), "a long stretch of text"));
    store.dispatch(del(byteOffset(0), byteOffset(22)));
    const state = store.getEagerSnapshot();

    const restored: DocumentState = restoreCheckpoint(createCheckpoint(state));
    expect(getValue(restored.pieceTable)).toBe("");
    expect(getValue(documentReducer(restored, undo()).pieceTable)).toBe("a long stretch of text");
  });

  it("keeps undo working with multi-byte text", () => {
    const store = createDocumentStore({ content: "日本" });
    store.dispatch(insert(byteOffset(6), "語です"));
    const restored: DocumentState = restoreCheckpoint(createCheckpoint(store.getEagerSnapshot()));

    expect(getValue(restored.pieceTable)).toBe("日本語です");
    expect(getValue(documentReducer(restored, undo()).pieceTable)).toBe("日本");
  });
});

describe("attention across restore", () => {
  function storeWithAttention() {
    const store = createDocumentStore({ content: "hello world" });
    const state = store.getEagerSnapshot();
    const start = createPoint(state.pieceTable.root, byteOffset(6))!;
    const end = createPoint(state.pieceTable.root, byteOffset(11))!;
    const [attention, id] = createAttention(state.attention, start, end);
    return { state: { ...state, attention } as DocumentState<"eager">, id };
  }

  it("resolves to the same text after an exact round-trip", () => {
    const { state, id } = storeWithAttention();
    const restored = restoreCheckpoint(createCheckpoint(state));

    expect(getTextForAttention(restored.pieceTable, restored.attention, id)).toBe("world");
    expect(resolveAttention(restored.pieceTable.root, restored.attention, id)).toEqual(
      resolveAttention(state.pieceTable.root, state.attention, id),
    );
  });

  it("resolves to the same text after a normalized round-trip", () => {
    const { state, id } = storeWithAttention();
    const restored = restoreCheckpoint(createCheckpoint(state, { mode: "normalized" }));

    expect(getTextForAttention(restored.pieceTable, restored.attention, id)).toBe("world");
  });

  it("keeps tracking its text through edits made after restore", () => {
    const { state, id } = storeWithAttention();
    const restored: DocumentState = restoreCheckpoint(createCheckpoint(state));

    const next = documentReducer(restored, insert(byteOffset(0), ">> "));
    expect(getTextForAttention(next.pieceTable, next.attention, id)).toBe("world");
  });

  it("preserves the id allocator so a later attention does not collide", () => {
    const { state, id } = storeWithAttention();
    const restored = restoreCheckpoint(createCheckpoint(state));

    const point = createPoint(restored.pieceTable.root, byteOffset(0))!;
    const [, nextId] = createAttention(restored.attention, point, point);
    expect(nextId).not.toBe(id);
  });
});

describe("normalized mode", () => {
  it("collapses the document to a single original piece", () => {
    const state = editedStore().getEagerSnapshot();
    const checkpoint = createCheckpoint(state, { mode: "normalized" });

    expect(checkpoint.mode).toBe("normalized");
    expect(checkpoint.pieceTable.pieces).toHaveLength(1);
    expect(checkpoint.pieceTable.addBuffer).toBe("");
    expectSameDocument(restoreCheckpoint(checkpoint), state);
  });

  it("keeps history usable", () => {
    const store = createDocumentStore({ content: "base" });
    store.dispatch(insert(byteOffset(4), " more"));
    const restored: DocumentState = restoreCheckpoint(
      createCheckpoint(store.getEagerSnapshot(), { mode: "normalized" }),
    );

    expect(getValue(documentReducer(restored, undo()).pieceTable)).toBe("base");
  });

  it("is smaller than an exact capture of the same edited document", () => {
    const store = createDocumentStore({ content: "x".repeat(2000) });
    for (let i = 0; i < 200; i++) {
      store.dispatch(insert(byteOffset(i), "edit"));
    }
    const state = store.getEagerSnapshot();

    const exact = encodeCheckpoint(state, { mode: "exact" }).length;
    const normalized = encodeCheckpoint(state, { mode: "normalized" }).length;
    expect(normalized).toBeLessThan(exact);
  });

  it("re-anchors an attention that was collapsed by a delete", () => {
    const store = createDocumentStore({ content: "hello world" });
    let state: DocumentState = store.getEagerSnapshot();
    const start = createPoint(state.pieceTable.root, byteOffset(6))!;
    const end = createPoint(state.pieceTable.root, byteOffset(11))!;
    const [attention, id] = createAttention(state.attention, start, end);
    state = { ...state, attention };

    // Deleting the referenced text collapses the span onto the deletion point
    // rather than dangling it — normalized capture re-anchors it there.
    state = documentReducer(state, del(byteOffset(6), byteOffset(11)));
    const collapsed = resolveAttention(state.pieceTable.root, state.attention, id);
    expect(collapsed).toEqual({ startOffset: 6, endOffset: 6 });

    const restored = restoreCheckpoint(
      createCheckpoint(state as DocumentState<"eager">, { mode: "normalized" }),
    );
    expect(resolveAttention(restored.pieceTable.root, restored.attention, id)).toEqual(collapsed);
    expect(restored.attention.nextID).toBe(state.attention.nextID);
  });

  it("drops every attention when the document is emptied", () => {
    const store = createDocumentStore({ content: "gone" });
    let state: DocumentState = store.getEagerSnapshot();
    const start = createPoint(state.pieceTable.root, byteOffset(0))!;
    const end = createPoint(state.pieceTable.root, byteOffset(4))!;
    const [attention] = createAttention(state.attention, start, end);
    state = documentReducer({ ...state, attention }, del(byteOffset(0), byteOffset(4)));

    const checkpoint = createCheckpoint(state as DocumentState<"eager">, { mode: "normalized" });
    expect(checkpoint.pieceTable.pieces).toHaveLength(0);
    expect(checkpoint.attention.attentions).toHaveLength(0);
    expect(getValue(restoreCheckpoint(checkpoint).pieceTable)).toBe("");
  });

  it("refuses a chunked document", () => {
    const state = createInitialState({ chunkSize: 64 }) as DocumentState<"eager">;
    expect(() => createCheckpoint(state, { mode: "normalized" })).toThrow(CheckpointError);
    try {
      createCheckpoint(state, { mode: "normalized" });
    } catch (error) {
      expect((error as CheckpointError).code).toBe("CHUNKED_NORMALIZE");
    }
  });
});

describe("add-buffer compaction", () => {
  it("drops unreferenced add bytes by default", () => {
    const store = createDocumentStore({ content: "keep" });
    store.dispatch(insert(byteOffset(4), "throwaway text that gets deleted"));
    store.dispatch(del(byteOffset(4), byteOffset(36)));
    const state = store.getEagerSnapshot();

    const compacted = createCheckpoint(state, { compact: true });
    const verbatim = createCheckpoint(state, { compact: false });

    expect(compacted.pieceTable.addBuffer.length).toBeLessThan(
      verbatim.pieceTable.addBuffer.length,
    );
    expect(getValue(restoreCheckpoint(compacted).pieceTable)).toBe("keep");
    expect(getValue(restoreCheckpoint(verbatim).pieceTable)).toBe("keep");
  });

  it("leaves live add pieces readable after compaction", () => {
    const store = createDocumentStore({ content: "a" });
    store.dispatch(insert(byteOffset(1), "one"));
    store.dispatch(insert(byteOffset(4), "two"));
    store.dispatch(del(byteOffset(1), byteOffset(4)));
    const state = store.getEagerSnapshot();

    expect(getValue(restoreCheckpoint(createCheckpoint(state)).pieceTable)).toBe(
      getValue(state.pieceTable),
    );
  });
});

describe("chunked documents", () => {
  function chunkedState(): DocumentState<"eager"> {
    const chunkSize = 16;
    const chunks = ["alpha line one\n\n", "beta line two!!\n", "gamma line thr\n\n"];
    let state: DocumentState = createInitialState({
      chunkSize,
      totalFileSize: chunkSize * chunks.length,
    });
    state = documentReducer(
      state,
      DocumentActions.declareChunkMetadata(
        chunks.map((chunk, chunkIndex) => ({
          chunkIndex,
          byteLength: chunk.length,
          lineCount: (chunk.match(/\n/g) ?? []).length,
        })),
      ),
    );
    // Load the first two; the third stays declared-but-unloaded.
    state = documentReducer(state, DocumentActions.loadChunk(0, textEncoder.encode(chunks[0]!)));
    state = documentReducer(state, DocumentActions.loadChunk(1, textEncoder.encode(chunks[1]!)));
    return state as DocumentState<"eager">;
  }

  it("round-trips loaded chunks and their pieces", () => {
    const state = chunkedState();
    const restored = restoreCheckpoint(createCheckpoint(state));

    expect(getValue(restored.pieceTable)).toBe(getValue(state.pieceTable));
    expect(restored.pieceTable.chunkSize).toBe(state.pieceTable.chunkSize);
    expect(restored.pieceTable.chunkMap.size).toBe(state.pieceTable.chunkMap.size);
    expect([...restored.pieceTable.loadedChunks]).toEqual([...state.pieceTable.loadedChunks]);
    expect(restored.pieceTable.nextExpectedChunk).toBe(state.pieceTable.nextExpectedChunk);
    expect(restored.pieceTable.totalFileSize).toBe(state.pieceTable.totalFileSize);
  });

  it("preserves declared metadata and unloaded line counts", () => {
    const state = chunkedState();
    const restored = restoreCheckpoint(createCheckpoint(state));

    expect(restored.pieceTable.chunkMetadata.get(2)).toEqual(state.pieceTable.chunkMetadata.get(2));
    expect(restored.lineIndex.unloadedLineCount).toBe(state.lineIndex.unloadedLineCount);
    expect(getLineCountFromIndex(restored.lineIndex)).toBe(getLineCountFromIndex(state.lineIndex));
  });

  it("counts lines declared for unloaded chunks against the restore limit", () => {
    const checkpoint = createCheckpoint(chunkedState());
    const loadedLineCount = checkpoint.lineIndex.lines.length;

    expectResourceLimit(() => restoreCheckpoint(checkpoint, { maxLines: loadedLineCount }));
  });

  it("keeps loading chunks after restore", () => {
    const restored: DocumentState = restoreCheckpoint(createCheckpoint(chunkedState()));
    const next = documentReducer(
      restored,
      DocumentActions.loadChunk(2, textEncoder.encode("gamma line thr\n\n")),
    );

    expect(getValue(next.pieceTable)).toBe("alpha line one\n\nbeta line two!!\ngamma line thr\n\n");
  });
});

describe("isCheckpoint", () => {
  it("accepts a real checkpoint", () => {
    expect(isCheckpoint(createCheckpoint(createDocumentStore().getEagerSnapshot()))).toBe(true);
  });

  it("rejects values that are not checkpoint envelopes", () => {
    expect(isCheckpoint(null)).toBe(false);
    expect(isCheckpoint([])).toBe(false);
    expect(isCheckpoint("reed-checkpoint")).toBe(false);
    expect(isCheckpoint({ format: "something-else" })).toBe(false);
    expect(isCheckpoint({ format: "reed-checkpoint", version: 1 })).toBe(false);
  });

  it("rejects a version this build cannot read", () => {
    const checkpoint = clone(createCheckpoint(createDocumentStore().getEagerSnapshot()));
    (checkpoint as { version: number }).version = 99;
    expect(isCheckpoint(checkpoint)).toBe(false);
  });
});

describe("restoring into a live store", () => {
  it("comes back reading and editing like the store it came from", () => {
    const original = editedStore();
    const restored = createDocumentStoreFromCheckpoint(
      createCheckpoint(original.getEagerSnapshot()),
    );

    expect(getValue(restored.getSnapshot().pieceTable)).toBe(
      getValue(original.getSnapshot().pieceTable),
    );

    restored.dispatch(insert(byteOffset(0), "! "));
    original.dispatch(insert(byteOffset(0), "! "));
    expect(getValue(restored.getSnapshot().pieceTable)).toBe(
      getValue(original.getSnapshot().pieceTable),
    );

    restored.dispose();
    original.dispose();
  });

  it("starts with fresh runtime: no listeners and no open transaction", () => {
    const source = editedStore();
    source.beginTransaction();
    source.dispatch(insert(byteOffset(0), "uncommitted "));
    const checkpoint = createCheckpoint(source.getEagerSnapshot());

    const restored = createDocumentStoreFromCheckpoint(checkpoint);
    // A store with no open transaction throws rather than rolling back.
    expect(() => restored.rollbackTransaction()).toThrow();

    let notified = 0;
    restored.subscribe(() => {
      notified++;
    });
    restored.dispatch(insert(byteOffset(0), "x"));
    expect(notified).toBe(1);

    source.rollbackTransaction();
    restored.dispose();
    source.dispose();
  });

  it("undoes and redoes through the restored store", () => {
    const source = createDocumentStore({ content: "start" });
    source.dispatch(insert(byteOffset(5), " here"));
    const restored = createDocumentStoreFromCheckpoint(createCheckpoint(source.getEagerSnapshot()));

    restored.dispatch(undo());
    expect(getValue(restored.getSnapshot().pieceTable)).toBe("start");
    restored.dispatch(redo());
    expect(getValue(restored.getSnapshot().pieceTable)).toBe("start here");

    restored.dispose();
    source.dispose();
  });

  it("accepts runtime configuration", () => {
    const warnings: unknown[] = [];
    const restored = createDocumentStoreFromCheckpoint(
      createCheckpoint(createDocumentStore({ content: "hi" }).getEagerSnapshot()),
      { reconcileMode: "sync", logger: { warn: (m) => warnings.push(m) } },
    );

    restored.dispatch(insert(byteOffset(0), "oh "));
    expect(getValue(restored.getSnapshot().pieceTable)).toBe("oh hi");
    expect(restored.getSnapshot().lineIndex.rebuildPending).toBe(false);
    restored.dispose();
  });

  it("refuses state-bearing configuration instead of ignoring it", () => {
    const checkpoint = createCheckpoint(createDocumentStore({ content: "hi" }).getEagerSnapshot());

    expect(() =>
      createDocumentStoreFromCheckpoint(checkpoint, {
        content: "different",
      } as Parameters<typeof createDocumentStoreFromCheckpoint>[1]),
    ).toThrow(/content/);

    expect(() =>
      createDocumentStoreFromCheckpoint(checkpoint, {
        historyLimit: 5,
        lineEnding: "crlf",
      } as Parameters<typeof createDocumentStoreFromCheckpoint>[1]),
    ).toThrow(/historyLimit, lineEnding/);
  });

  it("does not create a store when the checkpoint is rejected", () => {
    const draft = clone(createCheckpoint(editedStore().getEagerSnapshot()));
    draft.pieceTable.totalLength = 1;
    expect(() => createDocumentStoreFromCheckpoint(draft)).toThrow(CheckpointError);
  });

  it("restores into an event store without emitting on restore", () => {
    const source = editedStore();
    const restored = createDocumentStoreWithEventsFromCheckpoint(
      createCheckpoint(source.getEagerSnapshot()),
    );

    const seen: string[] = [];
    restored.addEventListener("content-change", () => seen.push("content"));
    expect(seen).toEqual([]);

    restored.dispatch(insert(byteOffset(0), "z"));
    expect(seen).toEqual(["content"]);

    restored.dispose();
    source.dispose();
  });

  it("keeps a chunked document loadable after restoring into a store", () => {
    const chunkSize = 16;
    const source = createDocumentStore({ chunkSize, reconcileMode: "none" });
    source.dispatch(DocumentActions.loadChunk(0, textEncoder.encode("sixteen bytes!!\n")));

    const restored = createDocumentStoreFromCheckpoint(
      createCheckpoint(source.getEagerSnapshot()),
      { reconcileMode: "none" },
    );
    restored.dispatch(DocumentActions.loadChunk(1, textEncoder.encode("another chunk!!\n")));

    expect(getValue(restored.getSnapshot().pieceTable)).toBe("sixteen bytes!!\nanother chunk!!\n");
    expect(restored.getSnapshot().pieceTable.chunkSize).toBe(chunkSize);

    restored.dispose();
    source.dispose();
  });
});

describe("restore rejects untrustworthy payloads", () => {
  const base = createCheckpoint(editedStore().getEagerSnapshot());

  function loadedChunkCheckpoint(): DocumentCheckpoint {
    let state: DocumentState = createInitialState({ chunkSize: 16 });
    state = documentReducer(
      state,
      DocumentActions.loadChunk(0, textEncoder.encode("sixteen bytes!!\n")),
    );
    return createCheckpoint(state as DocumentState<"eager">);
  }

  it("rejects a non-object", () => {
    expect(() => restoreCheckpoint(null as unknown as DocumentCheckpoint)).toThrow(CheckpointError);
    expect(() => restoreCheckpoint(42 as unknown as DocumentCheckpoint)).toThrow(CheckpointError);
  });

  it("rejects a foreign format tag", () => {
    expectRejection(
      base,
      (d) => {
        d.format = "not-reed" as typeof d.format;
      },
      "NOT_A_CHECKPOINT",
    );
  });

  it("rejects a newer format version", () => {
    expectRejection(
      base,
      (d) => {
        d.version = 999;
      },
      "VERSION_UNSUPPORTED",
    );
  });

  it("rejects an older format version without a migration", () => {
    expectRejection(
      base,
      (d) => {
        d.version = 0;
      },
      "VERSION_UNSUPPORTED",
    );
  });

  it("rejects an unknown mode", () => {
    expectRejection(
      base,
      (d) => {
        d.mode = "lossy" as typeof d.mode;
      },
      "MALFORMED",
    );
  });

  it("rejects a missing section", () => {
    expectRejection(
      base,
      (d) => {
        delete (d as Partial<CheckpointDraft>).pieceTable;
      },
      "MALFORMED",
    );
  });

  it("rejects invalid base64", () => {
    expectRejection(
      base,
      (d) => {
        d.pieceTable.originalBuffer = "!!!not base64!!!";
      },
      "MALFORMED",
    );
  });

  it("rejects a piece reading past its buffer", () => {
    expectRejection(
      base,
      (d) => {
        d.pieceTable.pieces[0]![3] = 999_999;
      },
      "PIECE_OUT_OF_BOUNDS",
    );
  });

  it("rejects a zero-length piece", () => {
    expectRejection(
      base,
      (d) => {
        d.pieceTable.pieces[0]![3] = 0;
      },
      "MALFORMED",
    );
  });

  it("rejects duplicate piece ids", () => {
    expectRejection(
      base,
      (d) => {
        d.pieceTable.pieces[1]![0] = d.pieceTable.pieces[0]![0]!;
      },
      "ID_COLLISION",
    );
  });

  it("rejects a totalLength that disagrees with the pieces", () => {
    expectRejection(
      base,
      (d) => {
        d.pieceTable.totalLength = 1;
      },
      "LENGTH_MISMATCH",
    );
  });

  it("rejects an allocator cursor that would reissue a live piece id", () => {
    expectRejection(
      base,
      (d) => {
        d.pieceTable.nextPieceID = 0;
      },
      "ID_COLLISION",
    );
  });

  it("rejects lines that do not cover the document", () => {
    expectRejection(
      base,
      (d) => {
        d.lineIndex.lines[0]![0] = 0;
      },
      "LINE_INDEX_MISMATCH",
    );
  });

  it("rejects an empty line list", () => {
    expectRejection(
      base,
      (d) => {
        d.lineIndex.lines = [];
      },
      "MALFORMED",
    );
  });

  it("rejects a non-positive maxDirtyRanges", () => {
    expectRejection(
      base,
      (d) => {
        d.lineIndex.maxDirtyRanges = 0;
      },
      "MALFORMED",
    );
  });

  it("rejects a selection past the end of the document", () => {
    expectRejection(
      base,
      (d) => {
        d.selection.ranges[0]![1] = 10_000;
      },
      "SELECTION_OUT_OF_RANGE",
    );
  });

  it("rejects an empty selection range list", () => {
    expectRejection(
      base,
      (d) => {
        d.selection.ranges = [];
      },
      "SELECTION_OUT_OF_RANGE",
    );
  });

  it("rejects a primaryIndex with no matching range", () => {
    expectRejection(
      base,
      (d) => {
        d.selection.primaryIndex = 7;
      },
      "SELECTION_OUT_OF_RANGE",
    );
  });

  it("rejects a non-positive history limit", () => {
    expectRejection(
      base,
      (d) => {
        d.history.limit = 0;
      },
      "HISTORY_INVALID",
    );
  });

  it("rejects a negative coalesce timeout", () => {
    expectRejection(
      base,
      (d) => {
        d.history.coalesceTimeout = -1;
      },
      "HISTORY_INVALID",
    );
  });

  it("rejects an undo stack deeper than its limit", () => {
    expectRejection(
      base,
      (d) => {
        d.history.limit = 1;
      },
      "HISTORY_INVALID",
    );
  });

  it("rejects an unknown history change kind", () => {
    expectRejection(
      base,
      (d) => {
        (d.history.undo[0]!.changes[0] as unknown as string[])[0] = "x";
      },
      "MALFORMED",
    );
  });

  it("rejects a history change with a non-string text", () => {
    expectRejection(
      base,
      (d) => {
        (d.history.undo[0]!.changes[0] as unknown as number[])[2] = 7;
      },
      "MALFORMED",
    );
  });

  it("rejects an attention anchored to a piece that is not there", () => {
    const state = createDocumentStore({ content: "hello world" }).getEagerSnapshot();
    const point = createPoint(state.pieceTable.root, byteOffset(6))!;
    const [attention] = createAttention(state.attention, point, point);
    const checkpoint = createCheckpoint({ ...state, attention } as DocumentState<"eager">);

    expectRejection(
      checkpoint,
      (d) => {
        d.attention.attentions[0]![1] = "p999";
      },
      "ATTENTION_DANGLING",
    );

    expectRejection(
      checkpoint,
      (d) => {
        d.attention.attentions[0]![2] = 10_000;
      },
      "ATTENTION_DANGLING",
    );

    expectRejection(
      checkpoint,
      (d) => {
        d.attention.attentions[0]![0] = "a0";
        d.attention.nextID = 0;
      },
      "ID_COLLISION",
    );
  });

  it("rejects duplicate attention ids", () => {
    const state = createDocumentStore({ content: "hello world" }).getEagerSnapshot();
    const point = createPoint(state.pieceTable.root, byteOffset(6))!;
    let [attention, first] = createAttention(state.attention, point, point);
    [attention] = createAttention(attention, point, point);
    const checkpoint = createCheckpoint({ ...state, attention } as DocumentState<"eager">);

    expectRejection(
      checkpoint,
      (d) => {
        d.attention.attentions[1]![0] = first;
      },
      "ID_COLLISION",
    );
  });

  it("rejects a chunk piece whose chunk is absent", () => {
    let state: DocumentState = createInitialState({ chunkSize: 16 });
    state = documentReducer(
      state,
      DocumentActions.loadChunk(0, textEncoder.encode("sixteen bytes!!\n")),
    );

    expectRejection(
      createCheckpoint(state as DocumentState<"eager">),
      (d) => {
        d.pieceTable.chunks = [];
      },
      "CHUNK_MISSING",
    );
  });

  it("rejects duplicate resident chunk entries", () => {
    expectRejection(
      loadedChunkCheckpoint(),
      (d) => {
        d.pieceTable.chunks.push([...d.pieceTable.chunks[0]!]);
      },
      "MALFORMED",
    );
  });

  it("rejects a resident chunk missing from loadedChunks", () => {
    expectRejection(
      loadedChunkCheckpoint(),
      (d) => {
        d.pieceTable.loadedChunks = [];
      },
      "MALFORMED",
    );
  });

  it("rejects a chunk piece reading past its chunk", () => {
    let state: DocumentState = createInitialState({ chunkSize: 16 });
    state = documentReducer(
      state,
      DocumentActions.loadChunk(0, textEncoder.encode("sixteen bytes!!\n")),
    );

    expectRejection(
      createCheckpoint(state as DocumentState<"eager">),
      (d) => {
        d.pieceTable.pieces[0]![3] = 64;
        d.pieceTable.totalLength = 64;
        d.lineIndex.lines[0]![0] = 64;
      },
      "PIECE_OUT_OF_BOUNDS",
    );
  });

  it("rejects chunk pieces that are out of index order", () => {
    let state: DocumentState = createInitialState({ chunkSize: 16 });
    state = documentReducer(
      state,
      DocumentActions.loadChunk(0, textEncoder.encode("sixteen bytes!!\n")),
    );
    state = documentReducer(
      state,
      DocumentActions.loadChunk(1, textEncoder.encode("more bytes here\n")),
    );

    expectRejection(
      createCheckpoint(state as DocumentState<"eager">),
      (d) => {
        d.pieceTable.pieces.reverse();
      },
      "CHUNK_ORDER",
    );
  });

  it("rejects fields whose runtime type is wrong", () => {
    expectRejection(
      base,
      (d) => {
        (d as unknown as { lineIndex: { lines: unknown } }).lineIndex.lines = "not an array";
      },
      "MALFORMED",
    );

    expectRejection(
      base,
      (d) => {
        (d.pieceTable as unknown as { originalBuffer: unknown }).originalBuffer = 7;
      },
      "MALFORMED",
    );

    expectRejection(
      base,
      (d) => {
        (d.metadata as unknown as { isDirty: unknown }).isDirty = "yes";
      },
      "MALFORMED",
    );

    expectRejection(
      base,
      (d) => {
        (d.history.undo[0] as unknown as { timestamp: unknown }).timestamp = "now";
      },
      "MALFORMED",
    );

    expectRejection(
      base,
      (d) => {
        (d.pieceTable as unknown as { totalLength: unknown }).totalLength = 1.5;
      },
      "MALFORMED",
    );
  });

  it("accepts piece ids that do not follow the pN convention", () => {
    const draft = clone(base);
    // Opaque ids are not minted by the allocator, so they place no constraint
    // on nextPieceID — but the pieces they name must still resolve.
    const renamed = new Map<string, string>();
    draft.pieceTable.pieces.forEach((piece, i) => {
      renamed.set(piece[0], `piece-${i}`);
      piece[0] = `piece-${i}`;
    });
    draft.pieceTable.nextPieceID = 0;
    draft.attention.attentions.forEach((attention) => {
      attention[1] = renamed.get(attention[1]) ?? attention[1];
      attention[3] = renamed.get(attention[3]) ?? attention[3];
    });

    const restored = restoreCheckpoint(draft);
    expect(getValue(restored.pieceTable)).toBe(getValue(restoreCheckpoint(base).pieceTable));
  });

  it("rejects invalid JSON", () => {
    expect(() => decodeCheckpoint("{not json")).toThrow(CheckpointError);
    try {
      decodeCheckpoint("{not json");
    } catch (error) {
      expect((error as CheckpointError).code).toBe("NOT_A_CHECKPOINT");
    }
  });

  it("enforces configured resource limits", () => {
    const encoded = JSON.stringify(base);
    const oversizedMalformed = clone(base);
    oversizedMalformed.pieceTable.originalBuffer = "AAAAA";
    const attempts: readonly (() => unknown)[] = [
      () => decodeCheckpoint(encoded, { maxJsonLength: encoded.length - 1 }),
      () => restoreCheckpoint(base, { maxBufferBytes: 0 }),
      () => restoreCheckpoint(oversizedMalformed, { maxBufferBytes: 1 }),
      () => restoreCheckpoint(base, { maxPieces: 0 }),
      () => restoreCheckpoint(base, { maxLines: 0 }),
      () => restoreCheckpoint(base, { maxHistoryEntries: 0 }),
    ];

    for (const attempt of attempts) expectResourceLimit(attempt);
  });

  it("limits attention records", () => {
    const state = createDocumentStore({ content: "hello world" }).getEagerSnapshot();
    const point = createPoint(state.pieceTable.root, byteOffset(6))!;
    const [attention] = createAttention(state.attention, point, point);
    const checkpoint = createCheckpoint({ ...state, attention } as DocumentState<"eager">);

    expectResourceLimit(() => restoreCheckpoint(checkpoint, { maxAttentions: 0 }));
  });

  it("rejects invalid restore limits", () => {
    expect(() => restoreCheckpoint(base, { maxPieces: -1 })).toThrow(RangeError);
    expect(() => decodeCheckpoint(JSON.stringify(base), { maxJsonLength: NaN })).toThrow(
      RangeError,
    );
  });

  it("forwards restore limits through live store factories", () => {
    expectResourceLimit(() => createDocumentStoreFromCheckpoint(base, {}, { maxPieces: 0 }));
    expectResourceLimit(() =>
      createDocumentStoreWithEventsFromCheckpoint(base, {}, { maxPieces: 0 }),
    );
  });

  it("names the failing field in its message", () => {
    const draft = clone(base);
    draft.pieceTable.totalLength = 1;
    expect(() => restoreCheckpoint(draft)).toThrow(/pieceTable\.totalLength/);
  });
});
