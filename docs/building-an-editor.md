# Building an editor with Reed

Reed supplies the document state, viewport reads, selection model, and edit history that an editor needs. Your UI remains responsible for DOM events, layout, and painting.

## Start with the editor-facing namespaces

Most editors begin with four namespaces.

| Namespace   | Responsibility                        |
| ----------- | ------------------------------------- |
| `store`     | Document lifecycle and edit actions   |
| `query`     | Fast state and line queries           |
| `rendering` | Visible lines and position conversion |
| `history`   | Undo and redo availability            |

Add `attention`, streaming, checkpoints, collaboration, and diff support only when the application needs them.

## Bridge immutable snapshots to the UI

A store exposes `subscribe`, `getSnapshot`, and `getServerSnapshot`. Snapshots are immutable. Replace the snapshot reference when the store changes instead of deep-proxying it.

```ts
import { store } from "@kozmof/reed";

const doc = store.createDocumentStore({ content: initialText });
let snapshot = doc.getSnapshot();

const unsubscribe = doc.subscribe(() => {
  snapshot = doc.getSnapshot();
  render(snapshot);
});

// Call this when the editor is destroyed.
unsubscribe();
```

Use `getServerSnapshot` when a UI integration needs a stable server-rendering snapshot. The store shape works with any UI framework even though it also matches React's external-store convention.

## Render only the viewport

Pass the first visible line and the number of lines that fit in the viewport. Overscan adds a small buffer above and below the visible range.

```ts
import { rendering } from "@kozmof/reed";

const viewport = rendering.getVisibleLines(snapshot, {
  startLine,
  visibleLineCount,
  overscan: 8,
});

for (const line of viewport.lines) {
  paintLine(line);
}
```

`viewport.totalLines` provides the full line count for scroll sizing. The `lines` array contains only the requested window.

## Keep byte and character positions separate

Document positions and selections use UTF-8 byte offsets. Columns returned by `positionToLineColumn` use character positions. DOM selection offsets normally use UTF-16 code units.

Convert at the UI boundary.

```ts
import { position, rendering } from "@kozmof/reed";

const documentPosition = rendering.lineColumnToPosition(snapshot, line, column);
const location = rendering.positionToLineColumn(snapshot, position.byteOffset(bytePosition));

const selection = position.selectionRange(charAnchor, charHead, snapshot);
```

Keep `ByteOffset` and `CharOffset` values branded while they move through editor logic. Use `position.rawByteOffset` or `position.rawCharOffset` when a browser or framework requires an ordinary number.

## Pass the pre-edit selection into each edit

The optional selection on `insert`, `delete`, and `replace` records the logical selection before the edit. Undo restores that selection. Redo computes the new caret from the stored action kind.

For backspace, record the cursor at the end of the deleted range. For forward delete, record the deletion point.

```ts
const caret = position.byteOffset(5);
const previousByte = position.byteOffset(4);

// Backspace deletes [4, 5) and records the pre-edit caret at 5.
doc.dispatch(store.DocumentActions.delete(previousByte, caret, [{ anchor: caret, head: caret }]));
```

The caret contract is shown below.

| Edit                         | Recorded selection head | After undo | After redo |
| ---------------------------- | ----------------------: | ---------: | ---------: |
| Insert `"!!!"` at 11         |                      11 |         11 |         14 |
| Insert without a selection   |                    none |          0 |         14 |
| Forward delete `[4, 5)`      |                       4 |          4 |          4 |
| Backspace delete `[4, 5)`    |                       5 |          5 |          4 |
| Replace `[0, 5)` with `"HI"` |                       0 |          0 |          2 |

After an ordinary input event, update the UI caret from that input operation. After undo or redo, read the restored selection from the returned snapshot.

```ts
import { position, query, store } from "@kozmof/reed";

const next = doc.dispatch(store.DocumentActions.undo());
const restoredCaret = query.getSelectionHead(next);

if (restoredCaret !== undefined) {
  moveCaret(position.rawByteOffset(restoredCaret));
}
```

## Configure undo grouping

Set `undoGroupTimeout` to group nearby edits of the same kind.

```ts
const doc = store.createDocumentStore({
  content: initialText,
  undoGroupTimeout: 300,
});
```

Reed starts a new history entry when the timeout expires, when edits are not contiguous, or when the action kind changes. Action creators accept an explicit timestamp as their last argument for deterministic tests.

## Handle line boundaries explicitly

A trailing newline opens another line. The content `"a\nb\n"` therefore has three lines.

`rendering.getLineContent` returns `null` when the line is outside the document. It returns `""` when the line exists but is empty. Preserve this distinction in adapters and view models.

## Avoid duplicate browser behavior

Reed does not own browser input events. Prevent the browser default when the editor handles a key itself. Keep layout padding in one coordinate conversion. These boundaries prevent the UI from applying an edit or offset twice.
