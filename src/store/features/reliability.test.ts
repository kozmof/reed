import { describe, expect, it, vi } from "vitest";
import { byteOffset, byteLength } from "../../types/branded.js";
import { getValue } from "../core/piece-table.js";
import { DocumentActions as actions } from "./actions.js";
import { createDocumentStore, createDocumentStoreWithEvents, withTransaction } from "./store.js";

function text(store: ReturnType<typeof createDocumentStore>) {
  return getValue(store.getSnapshot().pieceTable);
}

describe("snapshot byte callback isolation", () => {
  it.each([
    "forEach",
    "map",
    "filter",
    "every",
    "some",
    "find",
    "findIndex",
    "findLast",
    "findLastIndex",
    "reduce",
    "reduceRight",
  ])("protects the callback array in %s", (method) => {
    const store = createDocumentStore({ content: "abc" });
    const before = store.getSnapshot();
    store.dispatch(actions.insert(byteOffset(3), "d"));
    const after = store.getSnapshot();
    const listener = vi.fn();
    store.subscribe(listener);
    for (const bytes of [before.pieceTable.originalBuffer, after.pieceTable.addBuffer.bytes]) {
      const fn = Reflect.get(bytes, method);
      // ES2023 callbacks are tested on runtimes that provide them.
      if (fn === undefined) continue;
      expect(() =>
        Reflect.apply(fn, bytes, [
          (...args: unknown[]) => {
            const array = args.at(-1) as Uint8Array;
            expect(array).toBe(bytes);
            array[0] = 0;
          },
          0,
        ]),
      ).toThrow(TypeError);
    }
    expect(getValue(before.pieceTable)).toBe("abc");
    expect(text(store)).toBe("abcd");
    expect(store.getSnapshot()).toBe(after);
    expect(listener).not.toHaveBeenCalled();
    store.dispose();
  });

  it("preserves callback receivers, reductions, and independent result arrays", () => {
    const store = createDocumentStore({ content: "ab" });
    const bytes = store.getSnapshot().pieceTable.originalBuffer;
    const context = { calls: 0 };
    bytes.forEach(function (this: typeof context, _value, _index, array) {
      expect(this).toBe(context);
      expect(array).toBe(bytes);
      this.calls++;
    }, context);
    expect(context.calls).toBe(2);
    expect(
      bytes.reduce((sum, value, _index, array) => {
        expect(array).toBe(bytes);
        return sum + value;
      }),
    ).toBe(195);
    expect(bytes.reduceRight((sum, value) => sum + value, "")).toBe("9897");
    bytes.map((value) => value).fill(0);
    bytes.filter(() => true).fill(0);
    expect(text(store)).toBe("ab");
    expect(() => bytes.forEach(null as never)).toThrow(TypeError);
    store.dispose();
  });

  it("rejects mutation in the public byte types", () => {
    const store = createDocumentStore({ content: "a" });
    const bytes = store.getSnapshot().pieceTable.originalBuffer;
    // Compile-only checks also cover callback and derived-view types.
    const checkTypes = () => {
      // @ts-expect-error Mutating methods are not exposed.
      bytes.fill(0);
      // @ts-expect-error Mutating methods are not exposed.
      bytes.set([0]);
      // @ts-expect-error Numeric writes are forbidden.
      bytes[0] = 0;
      // @ts-expect-error Subarrays retain the readonly contract.
      bytes.subarray(0)[0] = 0;
      // @ts-expect-error Slices retain the readonly contract.
      bytes.slice(0).fill(0);
      bytes.forEach((_value, _index, array) => {
        // @ts-expect-error Callback arrays retain the readonly contract.
        array.fill(0);
      });
      bytes.reduce((sum, value, _index, array) => {
        // @ts-expect-error Reduction arrays retain the readonly contract.
        array[0] = 0;
        return sum + value;
      }, 0);
    };
    void checkTypes;
    store.dispose();
  });
});

describe("save state across history replay", () => {
  it.each(["undo", "redo"] as const)(
    "re-dirties and emits an event after saved %s",
    (operation) => {
      const store = createDocumentStoreWithEvents({ content: "a" });
      store.dispatch(actions.insert(byteOffset(1), "b"));
      if (operation === "redo") store.dispatch(actions.undo());
      store.dispatch(actions.markSaved(123));
      const listener = vi.fn();
      store.addEventListener("dirty-change", listener);
      store.dispatch(actions[operation]());
      expect(text(store)).toBe(operation === "undo" ? "a" : "ab");
      expect(store.getSnapshot().metadata.isDirty).toBe(true);
      expect(store.getSnapshot().metadata.lastSaved).toBe(123);
      expect(listener).toHaveBeenCalledTimes(1);
      store.dispose();
    },
  );

  it("keeps unavailable undo and redo clean", () => {
    const store = createDocumentStore();
    store.dispatch(actions.markSaved(123));
    const saved = store.getSnapshot();
    store.dispatch(actions.undo());
    store.dispatch(actions.redo());
    expect(store.getSnapshot()).toBe(saved);
    store.dispose();
  });
});

describe("remote history invalidation", () => {
  it.each(["insert", "delete"] as const)(
    "invalidates both stacks on remote %s and permits new local history",
    (operation) => {
      const store = createDocumentStore({ content: "ab", undoGroupTimeout: 0 });
      store.dispatch(actions.insert(byteOffset(1), "X"));
      store.dispatch(actions.insert(byteOffset(2), "Z"));
      store.dispatch(actions.undo());
      expect(store.getSnapshot().history.undoStack).not.toBeNull();
      expect(store.getSnapshot().history.redoStack).not.toBeNull();
      store.dispatch(
        actions.applyRemote(
          operation === "insert"
            ? [{ type: "insert", start: byteOffset(0), text: "Y" }]
            : [{ type: "delete", start: byteOffset(0), length: byteLength(1) }],
        ),
      );
      const remote = store.getSnapshot();
      const expected = operation === "insert" ? "YaXb" : "Xb";
      expect(text(store)).toBe(expected);
      expect(remote.history.undoStack).toBeNull();
      expect(remote.history.redoStack).toBeNull();
      expect(remote.history.coalesceTimeout).toBe(0);
      store.dispatch(actions.undo());
      store.dispatch(actions.redo());
      expect(store.getSnapshot()).toBe(remote);
      store.dispatch(actions.insert(byteOffset(0), "N"));
      store.dispatch(actions.undo());
      expect(text(store)).toBe(expected);
      store.dispose();
    },
  );

  it("preserves history for ineffective remote changes and transaction rollback", () => {
    const store = createDocumentStore({ content: "ab" });
    store.dispatch(actions.insert(byteOffset(1), "X"));
    const before = store.getSnapshot();
    store.dispatch(actions.applyRemote([{ type: "insert", start: byteOffset(0), text: "" }]));
    expect(store.getSnapshot()).toBe(before);
    store.beginTransaction();
    store.dispatch(actions.applyRemote([{ type: "insert", start: byteOffset(0), text: "Y" }]));
    store.rollbackTransaction();
    expect(store.getSnapshot()).toBe(before);
    store.dispatch(actions.undo());
    expect(text(store)).toBe("ab");
    store.dispose();
  });
});

describe("synchronous transaction callbacks", () => {
  it("rejects async callbacks before invoking them", async () => {
    const store = createDocumentStore();
    const invoked = vi.fn();
    expect(() => {
      // @ts-expect-error Async callbacks are not supported.
      withTransaction(store, async () => {
        invoked();
        await Promise.resolve();
        store.dispatch(actions.insert(byteOffset(0), "late"));
      });
    }).toThrow("synchronous callback");
    await Promise.resolve();
    expect(invoked).not.toHaveBeenCalled();
    expect(text(store)).toBe("");
    store.dispose();
  });

  it.each([false, true])("rolls back promise results, including rejection=%s", async (reject) => {
    const store = createDocumentStoreWithEvents();
    const listener = vi.fn();
    store.addEventListener("content-change", listener);
    expect(() => {
      // @ts-expect-error Promise results are not supported.
      withTransaction(store, (s) => {
        s.dispatch(actions.insert(byteOffset(0), "temporary"));
        return reject ? Promise.reject(new Error("failure")) : Promise.resolve(1);
      });
    }).toThrow("synchronous callback");
    await Promise.resolve();
    expect(text(store)).toBe("");
    expect(listener).not.toHaveBeenCalled();
    expect(withTransaction(store, () => 42)).toBe(42);
    store.dispose();
  });

  it("rejects thenables and preserves an enclosing transaction", async () => {
    const store = createDocumentStore();
    store.beginTransaction();
    store.dispatch(actions.insert(byteOffset(0), "outer"));
    const before = store.getSnapshot();
    expect(() => {
      // @ts-expect-error Thenable results are not supported.
      withTransaction(store, (s) => {
        s.dispatch(actions.insert(byteOffset(0), "inner"));
        // eslint-disable-next-line unicorn/no-thenable -- Exercise unsupported thenable callbacks.
        return { then: (resolve: (value: number) => unknown) => resolve(1) };
      });
    }).toThrow("synchronous callback");
    expect(store.getSnapshot()).toBe(before);
    store.commitTransaction();
    await Promise.resolve();
    expect(text(store)).toBe("outer");
    store.dispose();
  });
});
