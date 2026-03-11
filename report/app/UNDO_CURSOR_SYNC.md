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

Meanwhile, after `undo()`, the React `cursor` state was never updated either,
so it stayed at the post-insert position and was clamped by `clampNormal` to
some valid offset in the now-shorter text — an arbitrary wrong position.

---

## Original workaround (superseded by Reed API improvements)

> The approach below was the initial fix before the Reed API was updated.
> See **Current approach** below for the recommended patterns.

### Part 1: Sync `state.selection` before every edit

A helper was defined inside the component:

```tsx
const setSel = (t: string, off: number) =>
  docStore.dispatch(
    store.DocumentActions.setSelection([
      { anchor: toByteOffset(t, off), head: toByteOffset(t, off) },
    ]),
  )
```

`setSel(t, cursor)` was called immediately before every `insert` or `delete`
dispatch at 10+ sites (printable char, Enter, Backspace, Delete, composition
events, normal-mode `x`/`dd`/`o`/`O`).

### Part 2: Read restored cursor via unsafe cast

```tsx
function readCursorFromSnapshot(snap): number {
  const t = scan.getValue(snap.pieceTable) as string
  const headByte = snap.selection.ranges[0]?.head as unknown as number | undefined
  if (headByte === undefined) return 0
  return store.byteToCharOffset(t, headByte) as unknown as number
}

case 'u':
  if (canUndo) {
    docStore.dispatch(store.DocumentActions.undo())
    const snapU = docStore.getSnapshot()   // redundant — dispatch return value ignored
    setCursor(clampNormal(readCursorFromSnapshot(snapU), ...))
  }
  break
```

Problems with the workaround:
- Two dispatches per edit (`setSelection` + the actual edit)
- `as unknown as number` double cast to extract a branded `ByteOffset`
- `getSnapshot()` called redundantly after `dispatch` (which already returns the new state)
- Cursor-sync logic duplicated at every undo/redo call site

---

## Current approach (Reed API improvements applied)

### Part 1: Inline `selection` on edit actions

Reed's `INSERT`/`DELETE`/`REPLACE` actions now accept an optional `selection`
field. The reducer applies it to `state.selection` before `historyPush`, so
`selectionBefore` is recorded correctly in a single dispatch — no separate
`setSelection` needed.

```tsx
// One dispatch per edit
dispatch(DocumentActions.insert(pos, text, [{ anchor: pos, head: pos }]))
dispatch(DocumentActions.delete(start, end, [{ anchor: start, head: start }]))
```

### Part 2: Event-driven cursor sync for undo/redo

`HistoryChangeEvent` (from `createDocumentStoreWithEvents`) carries `nextState`
with the restored `state.selection`. Subscribe once; the keydown handlers no
longer need any cursor readback logic.

```tsx
docStore.addEventListener('history-change', ({ nextState }) => {
  const head = query.getSelectionHead(nextState)       // ByteOffset | undefined
  if (head !== undefined) {
    const t = scan.getValue(nextState.pieceTable) as string
    const charOff = store.byteToCharOffset(t, position.rawByteOffset(head))
    setCursor(clampNormal(charOff, t))
  }
})

// keydown handler:
case 'u':
  if (canUndo) docStore.dispatch(store.DocumentActions.undo())
  break
case 'r':
  if (e.ctrlKey && canRedo) docStore.dispatch(store.DocumentActions.redo())
  break
```

`query.getSelectionHead` and `position.rawByteOffset` are new Reed API helpers
that replace the `as unknown as number` cast:

```ts
// Old
const headByte = snap.selection.ranges[0]?.head as unknown as number | undefined

// New
const head = query.getSelectionHead(snap)                 // ByteOffset | undefined
const headNum = position.rawByteOffset(head ?? position.ZERO_BYTE_OFFSET)
```

---

## IME interaction

With the `insertComposed` API (see `IME_ISSUES.md` Issue 3), an IME session now
produces a **single** `replace` history entry. One `u` press undoes the entire
session and the `history-change` listener fires once, restoring the cursor to
the position before the IME session started.

---

## Summary

| Problem | Original workaround | Current approach |
|---|---|---|
| Reed's `state.selection` always at byte 0 | Call `setSel(t, cursor)` before every edit (10+ sites) | Pass `selection` inline on `insert`/`delete`/`replace` |
| Unsafe `ByteOffset` → `number` cast | `as unknown as number` double cast | `position.rawByteOffset(query.getSelectionHead(snap))` |
| Redundant `getSnapshot()` after undo/redo | Ignored `dispatch` return value | Use `dispatch` return value directly, or subscribe to `history-change` |
| Cursor-sync scattered at every undo/redo site | Copy-pasted `readCursorFromSnapshot` calls | Single `addEventListener('history-change', ...)` handler |
