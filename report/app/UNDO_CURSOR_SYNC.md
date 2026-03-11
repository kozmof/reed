# Undo/Redo Cursor Sync in VimApp — Problem & Solution

## Background

VimApp maintains cursor position as a React state variable (`cursor: number`, a
char offset into the document string). This is independent from Reed's internal
`state.selection`, which also tracks cursor position as a `ByteOffset` and is
used by Reed's history system to restore the cursor on undo/redo.

Reed records a `selectionBefore` and `selectionAfter` per history entry:

- `selectionBefore` — `state.selection` at the moment the edit was dispatched
- `selectionAfter`  — `state.selection` after the edit was applied

On `undo()`, Reed restores `state.selection` to `selectionBefore`.
On `redo()`, Reed restores `state.selection` to `selectionAfter`.

---

## Issue — Cursor jumped to document start after undo

**Symptom:** Type Japanese text (e.g. `日本語`) in insert mode, return to
normal mode, press `u` to undo. The text disappears correctly, but the cursor
jumps to `H` at the very start of the document instead of staying near the
insertion point.

**Root cause:** VimApp never called `DocumentActions.setSelection(...)` to
keep Reed's `state.selection` in sync with the React `cursor` state. Every
edit was dispatched while `state.selection` was still at its initial value
(byte offset 0). Reed therefore recorded `selectionBefore = byte 0` for every
history entry. After undo, restoring `selectionBefore` always produced byte
offset 0 — position `H` of `Hello, Reed!`.

Meanwhile, the undo handler was:

```tsx
case 'u':
  if (canUndo) docStore.dispatch(store.DocumentActions.undo())
  break
```

After `undo()`, `cursor` (the React state) was never updated either, so it
stayed at the post-insert position and was clamped by `clampNormal` to some
valid offset in the now-shorter text — an arbitrary wrong position.

---

## Fix — Two-part

### Part 1: Sync `state.selection` to `cursor` before every edit

A helper is defined inside the component:

```tsx
const setSel = (t: string, off: number) =>
  docStore.dispatch(
    store.DocumentActions.setSelection([
      { anchor: toByteOffset(t, off), head: toByteOffset(t, off) },
    ]),
  )
```

`setSelection` is not an undoable action — it only updates `state.selection`.
The next edit dispatch will then record the correct `selectionBefore`.

`setSel(t, cursor)` is called immediately before every `insert` or `delete`
dispatch at all sites:

| Site | Notes |
|---|---|
| Insert mode — printable char | Before `insert(cursor, key)` |
| Insert mode — Enter | Before `insert(cursor, '\n')` |
| Insert mode — Backspace | Before `delete(cursor-1, cursor)` |
| Insert mode — Delete | Before `delete(cursor, cursor+1)` |
| `onCompositionEnd` | Before `insert(cursor, composed)` |
| `onCompositionStart` rollback | Before `delete(pos, pos+charLen)`, using the post-insert position |
| Normal mode — `x` | Before `delete(cursor, cursor+1)` |
| Normal mode — `dd` | Before `delete(lineStart, lineEnd)` |
| Normal mode — `o` | Before `insert(lineEnd, '\n')` |
| Normal mode — `O` | Before `insert(lineStart, '\n')` |

### Part 2: Read Reed's restored selection after undo/redo

A helper reads the cursor back from the post-dispatch snapshot:

```tsx
function readCursorFromSnapshot(snap: ReturnType<typeof docStore.getSnapshot>): number {
  const t = scan.getValue(snap.pieceTable) as string
  const headByte = snap.selection.ranges[0]?.head as unknown as number | undefined
  if (headByte === undefined) return 0
  return store.byteToCharOffset(t, headByte) as unknown as number
}
```

`snap.selection.ranges[0].head` is a `ByteOffset` — at runtime it is a plain
number (cost/brand types are erased). `store.byteToCharOffset` converts it to a
char offset for the React `cursor` state.

The undo/redo handlers now call `docStore.getSnapshot()` synchronously after
the dispatch (Reed applies actions synchronously) and update `cursor`:

```tsx
case 'u':
  if (canUndo) {
    docStore.dispatch(store.DocumentActions.undo())
    const snapU = docStore.getSnapshot()
    setCursor(clampNormal(readCursorFromSnapshot(snapU), scan.getValue(snapU.pieceTable) as string))
  }
  break
case 'r':
  if (e.ctrlKey && canRedo) {
    docStore.dispatch(store.DocumentActions.redo())
    const snapR = docStore.getSnapshot()
    setCursor(clampNormal(readCursorFromSnapshot(snapR), scan.getValue(snapR.pieceTable) as string))
  }
  break
```

`clampNormal` ensures the restored position doesn't land on a newline
(which is not a valid normal-mode cursor position).

---

## Why `getSnapshot()` is synchronous

Reed's store applies actions synchronously in `dispatch()`. `getSnapshot()`
returns the current (already-updated) state. There is no async gap between
`dispatch(undo())` and `getSnapshot()` — the restored selection is immediately
readable.

---

## IME interaction

For an IME insert sequence, two history entries are created:

1. The rollback `delete` in `onCompositionStart` (removes the premature
   first-key insert)
2. The `insert` in `onCompositionEnd` (inserts the composed string)

`setSel` is called before each, so both entries carry the correct
`selectionBefore`. Pressing `u` twice undoes both in reverse order, landing
the cursor at the position before the IME session started.

---

## Summary

| Problem | Fix |
|---|---|
| Reed's `state.selection` always at byte 0 | Call `setSel(t, cursor)` before every `insert`/`delete` dispatch |
| `cursor` React state not updated after undo/redo | Read `snap.selection.ranges[0].head` via `readCursorFromSnapshot` after each undo/redo dispatch and call `setCursor` |
