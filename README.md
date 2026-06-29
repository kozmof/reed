# reed

Reed is a fast, immutable text engine for building editors. It's built on a piece table and works with any UI framework.

## Installation

```bash
npm install @kozmof/reed
# or
pnpm add @kozmof/reed
```

Reed is ESM-only and ships its own type declarations.

## Quick start

```ts
import { store, scan, position } from "@kozmof/reed";

// Create a document store with initial content.
const doc = store.createDocumentStore({ content: "hello world" });

// Dispatch an edit. Actions are created via store.DocumentActions.
doc.dispatch(store.DocumentActions.insert(position.byteOffset(5), ","));

// Read the full text back.
const state = doc.getSnapshot();
console.log(scan.getValue(state.pieceTable)); // "hello, world"
```

## Core concepts

Reed's runtime is organized into named namespaces:

| Namespace     | Use it for                                                        |
| ------------- | ----------------------------------------------------------------- |
| `store.*`     | Store lifecycle, action creators, type guards                     |
| `query.*`     | O(1) / O(log n) reads: line lookups, cursor positioning           |
| `scan.*`      | O(n) reads: full-document serialization, analysis                 |
| `rendering.*` | Viewport calculation, position ↔ line/column conversion           |
| `history.*`   | Undo/redo state queries                                           |
| `diff.*`      | Diff algorithm and `setValue` (replace whole content efficiently) |
| `events.*`    | Event emitter and document event factories                        |
| `position.*`  | Branded offset constructors (`byteOffset`, `charOffset`, …)       |
| `attention.*` | Piece-anchored references that survive edits                      |

Types are exported flat and can be imported directly:

```ts
import type { DocumentState, InsertAction, ByteOffset } from "@kozmof/reed";
```

> `query` vs `scan`: anything on a hot path (every keystroke, scroll, or render) belongs in `query`. Reserve `scan` for one-off work like exporting the document or background analysis, since every `scan.*` call walks the whole document.

## Creating a store

```ts
import { store } from "@kozmof/reed";

const doc = store.createDocumentStore({
  content: "initial text", // initial document content
  historyLimit: 1000, // max undo entries (default: 1000)
  lineEnding: "lf", // "lf" | "crlf" | "cr" (default: "lf")
  normalizeInsertedLineEndings: true, // coerce inserts to lineEnding (default: false)
  undoGroupTimeout: 300, // ms window to group consecutive edits (default: 0 = off)
});
```

The store holds the current document state and notifies subscribers on every change:

```ts
const state = doc.getSnapshot(); // current immutable DocumentState
const unsubscribe = doc.subscribe(() => {
  // notified on every change
  render(doc.getSnapshot());
});
unsubscribe();
```

## Editing the document

All mutations go through `dispatch` with an action from `store.DocumentActions`. Offsets are byte offsets, built with `position.byteOffset(...)`.

```ts
import { store, position } from "@kozmof/reed";

const { DocumentActions } = store;
const { byteOffset } = position;

// Insert text at a byte offset.
doc.dispatch(DocumentActions.insert(byteOffset(0), "Hello "));

// Delete the range [start, end).
doc.dispatch(DocumentActions.delete(byteOffset(0), byteOffset(6)));

// Replace a range with new text.
doc.dispatch(DocumentActions.replace(byteOffset(0), byteOffset(5), "Howdy"));

// Move the selection/cursor.
doc.dispatch(DocumentActions.setSelection([{ anchor: byteOffset(3), head: byteOffset(3) }]));
```

`dispatch` returns the resulting `DocumentState`, so reads can be chained off the return value.

### Undo / redo

```ts
import { store, history } from "@kozmof/reed";

doc.dispatch(store.DocumentActions.undo());
doc.dispatch(store.DocumentActions.redo());

// Query history state (all O(1)):
history.canUndo(doc.getSnapshot()); // boolean
history.canRedo(doc.getSnapshot()); // boolean
history.getUndoCount(doc.getSnapshot());
```

### Replacing the whole document

For "set the editor to this string" (e.g. loading a file or reverting), use the `diff` namespace, which computes a minimal edit instead of clearing and re-inserting:

```ts
import { diff } from "@kozmof/reed";

const nextState = diff.setValue(doc.getSnapshot(), "completely new content");
```

## Reading the document

### Fast reads: `query` (O(1) / O(log n))

```ts
import { query, position } from "@kozmof/reed";

const state = doc.getSnapshot();

query.getLineCount(state); // total lines
query.findLineAtPosition(state, position.byteOffset(7)); // line node at a byte offset
query.findLineByNumber(state, 2); // line node by 1-based line number
query.getLineStartOffset(state, 1); // byte offset where a line starts
query.getLength(state.pieceTable); // document length in bytes
query.getText(state.pieceTable, position.byteOffset(0), position.byteOffset(5)); // substring
```

### Full reads: `scan` (O(n))

```ts
import { scan } from "@kozmof/reed";

const state = doc.getSnapshot();

scan.getValue(state.pieceTable); // the entire document as a string

// Each chunk is a DocumentChunk { content, byteOffset, ... }; good for exporting large files.
for (const chunk of scan.getValueStream(state.pieceTable)) {
  write(chunk.content);
}
```

## Rendering a viewport

The `rendering` namespace turns document state into the lines a UI needs to paint, plus position conversions for cursor handling.

```ts
import { rendering } from "@kozmof/reed";

const state = doc.getSnapshot();

const visible = rendering.getVisibleLines(state, {
  startLine: 0, // first visible line (0-indexed)
  visibleLineCount: 30, // lines that fit in the viewport
  overscan: 5, // extra lines above/below for smooth scrolling
});

for (const line of visible.lines) {
  paint(line);
}
```

## Reacting to changes with events

`createDocumentStoreWithEvents` adds typed event emission on top of the base store. Subscribe to specific change types instead of a generic notification:

```ts
import { store, position } from "@kozmof/reed";

const doc = store.createDocumentStoreWithEvents({ content: "" });

doc.addEventListener("content-change", (e) => console.log("text changed", e));
doc.addEventListener("selection-change", (e) => console.log("cursor moved", e));
doc.addEventListener("history-change", (e) => console.log("undo/redo state changed", e));
doc.addEventListener("dirty-change", (e) => console.log("dirty flag:", e));

doc.dispatch(store.DocumentActions.insert(position.byteOffset(0), "hi"));
```

## Tracking references with attention

The `attention` namespace anchors references to piece boundaries instead of document offsets, so a reference keeps pointing at the same text across edits elsewhere in the document. State is immutable and caller-owned. Pass the current `AttentionLayerState` into each operation and store the result, starting from `attention.emptyState`.

```ts
import { store, scan, position, attention } from "@kozmof/reed";

const doc = store.createDocumentStore({ content: "hello world" });
let pt = doc.getSnapshot().pieceTable;
let att = attention.emptyState;

// Anchor an attention over "world".
const start = attention.createPoint(pt.root, position.byteOffset(6))!;
const end = attention.createPoint(pt.root, position.byteOffset(11))!;
let id;
[att, id] = attention.createAttention(att, start, end);

// Insert earlier in the document; advance both layers together.
const next = attention.insertWithAttention(pt, att, position.byteOffset(0), ">> ");
pt = next.pieceTableState;
att = next.attentionState;

scan.getValue(pt); // ">> hello world"
attention.getTextForAttention(pt, att, id); // "world"
```

Use `insertWithAttention` / `deleteWithAttention` to keep the piece table and attention layer in sync. Resolution is fail-closed. A reference whose text was deleted resolves to `null` rather than to a wrong offset. See [spec/10-attention.md](spec/10-attention.md) for the full model.

## Working with large files

Reed supports chunked, streaming loads for files that don't fit comfortably in memory. `createChunkManager` and `createStreamingDocumentLoader` are flat exports (not part of the `store` namespace) and take the store plus a `ChunkLoader` that fetches raw bytes for a chunk index:

```ts
import { createChunkManager, createStreamingDocumentLoader } from "@kozmof/reed";

const loader = {
  loadChunk: (chunkIndex: number): Promise<Uint8Array> => fetchChunkBytes(chunkIndex),
};

// High-level: declare chunk metadata, then load/pin/prefetch around a viewport.
const streaming = createStreamingDocumentLoader(doc, loader, metadata);
streaming.setViewport(startChunkIndex, endChunkIndex);

// Or manage chunks directly.
const manager = createChunkManager(doc, loader);
await manager.ensureLoaded(0);
```

Background re-indexing after edits is handled by a reconciliation scheduler. A fully-resolved (eager) state can be forced when needed immediately, for example before an `O(n)` export:

```ts
const eager = doc.reconcileNow(); // returns a fully reconciled DocumentState
```

See [spec/03-loading-and-history.md](spec/03-loading-and-history.md) for the chunk lifecycle.

## Designs

1. Deterministic, pure reducers: every transition is a pure function of `(state, action)`.
2. Immutable state with structural sharing: snapshots are safe to hold, compare by reference, and diff.
3. Byte-accurate text model: explicit byte/char conversion utilities and no hidden encoding assumptions.
4. Stratified complexity: `query` (fast lookups) and `scan` (full traversals) are separate namespaces so cost is visible at the call site.

## Development

```bash
pnpm install
pnpm build        # type-check + bundle + emit declarations
pnpm test         # run the test suite (vitest)
pnpm test:watch   # watch mode
pnpm coverage     # coverage report
pnpm test:perf    # performance suite
pnpm bench        # run benchmarks
pnpm lint         # oxlint
pnpm fmt          # oxfmt
```

## Documentation

- [SPEC.md](SPEC.md): current implemented surface and verification status
- [spec/](spec/): per-domain specifications (architecture, rendering, loading, API, testing, internals)
- [docs/invariants.md](docs/invariants.md): invariants the engine maintains

## License

See [LICENCE](LICENCE).
