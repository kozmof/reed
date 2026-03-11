# Reed API Improvements — 2026-03-12

Source reports: `report/app/IME_ISSUES.md`, `report/app/UNDO_CURSOR_SYNC.md`

**Status: Implemented** — all four improvements landed, 576/576 tests passing.

---

## Summary

Four improvements to the public API, derived from friction observed building VimApp (a vim-mode editor) on top of Reed. No backward-compatibility constraints — project is v0.

| # | Improvement | Files changed | Status |
|---|---|---|---|
| 1 | Inline `selection` on edit actions | `types/actions.ts`, `features/reducer.ts`, `features/actions.ts` | Done |
| 2 | Branded type extraction utilities | `types/branded.ts`, `api/position.ts`, `api/query.ts`, `api/interfaces.ts` | Done |
| 3 | `insertComposed` IME convenience creator | `features/actions.ts` | Done |
| 4 | Event-driven undo/redo cursor sync | `features/events.ts`, `types/store.ts` (JSDoc) | Done |

Implementation order: 2 → 1 → 3 → 4.

---

## Improvement 1 — Inline `selection` on edit actions

### Problem

`historyPush` snapshots `state.selection` as `selectionBefore` at the moment an edit is dispatched. Reed's `state.selection` only updates via an explicit `SET_SELECTION` dispatch. VimApp was forced to call `setSel(t, cursor)` — a separate `setSelection` dispatch — before every `insert`/`delete`/`replace`, at **10+ call sites**.

```ts
// Before: two dispatches per edit
setSel(t, cursor)
dispatch(DocumentActions.insert(pos, text))
```

### Fix

Added `readonly selection?: readonly SelectionRange[]` to `InsertAction`, `DeleteAction`, and `ReplaceAction`. When present, the reducer applies it to `state.selection` inside `applyEdit` before `historyPush`, so `selectionBefore` is captured correctly in a single dispatch.

```ts
// After: one dispatch per edit
dispatch(DocumentActions.insert(pos, text, [{ anchor: pos, head: pos }]))
```

### Changes made

**`src/types/actions.ts`**
- Added `readonly selection?: readonly SelectionRange[]` to `InsertAction`, `DeleteAction`, `ReplaceAction`.

**`src/store/features/reducer.ts`**
- Added `selection?: readonly SelectionRange[]` to the internal `EditOperation` interface.
- In `applyEdit`, before `historyPush`: if `op.selection` is set, freeze and apply it to `newState.selection`.
- In the `INSERT`, `DELETE`, `REPLACE` reducer cases: pass `selection: action.selection` to `applyEdit`.

**`src/store/features/actions.ts`**
- Added optional `selection` parameter to `insert`, `delete`, and `replace` creators.
- Spread only when defined (`...(selection && { selection })`), keeping serialized actions clean.

---

## Improvement 2 — Branded type extraction utilities

### Problem

After `undo()`/`redo()`, VimApp read the restored cursor with an unsafe double cast:

```ts
const head = snap.selection.ranges[0]?.head as unknown as number | undefined
```

`ByteOffset` is a branded type with no extraction utility, forcing `as unknown as number`.

### Fix

Added zero-overhead extraction functions and a selection convenience accessor.

```ts
// After
const head = query.getSelectionHead(snap)                              // ByteOffset | undefined
const headNum = position.rawByteOffset(head ?? position.ZERO_BYTE_OFFSET)  // number
```

### Changes made

**`src/types/branded.ts`**
- Added `rawByteOffset(o: ByteOffset): number` — identity at runtime, erases brand.
- Added `rawCharOffset(o: CharOffset): number` — same for `CharOffset`.

**`src/api/position.ts`**
- Imported and re-exported `rawByteOffset`, `rawCharOffset` under the `// Extraction` comment.

**`src/api/query.ts`**
- Added `getSelectionHead(state: DocumentState): ByteOffset | undefined` wrapped with `$constCostFn`.
- Reads `state.selection.ranges[state.selection.primaryIndex]?.head`.

**`src/api/interfaces.ts`**
- Added `getSelectionHead(state: DocumentState): ConstCost<ByteOffset | undefined>` to `QueryApi`.

---

## Improvement 3 — `insertComposed` IME convenience creator

### Problem

The IME rollback pattern created two history entries — a `delete` in `compositionstart` and an `insert` in `compositionend` — so the user had to press `u` twice to undo one composition session.

### Fix

`REPLACE` already creates a single `replace` HistoryEntry (one undo step). Added `insertComposed` as a named convenience creator that delegates to `replace`, making the deferred-rollback IME pattern idiomatic.

```ts
DocumentActions.insertComposed(
  rollbackStart: ByteOffset,
  rollbackEnd: ByteOffset,
  composedText: string,
  selection?: readonly SelectionRange[]
): ReplaceAction   // delegates to replace()
```

Revised app IME flow — defers rollback to `compositionend`:

```
keydown('n')         → insert 'n'; record { rollbackStart, rollbackEnd }
compositionstart     → set isComposing = true; save rollback info; do NOT dispatch delete
compositionend       → dispatch insertComposed(rollbackStart, rollbackEnd, '日本語', selection)
                       → one HistoryEntry (type 'replace') → one u undoes the session
```

Edge case: `compositionend` with empty text (user cancelled) = `REPLACE(start, end, '')` = delete. One history entry, correct behaviour.

### Changes made

**`src/store/features/actions.ts`**
- Added `insertComposed(rollbackStart, rollbackEnd, composedText, selection?)` to `DocumentActions`. Pure delegation to `replace`; no new action type, no reducer change.

---

## Improvement 4 — Event-driven undo/redo cursor sync

### Problem

VimApp called `getSnapshot()` after every undo/redo dispatch to read the restored cursor — redundant because `dispatch` already returns the new `DocumentState`. The cursor-sync logic was also scattered across every undo/redo call site.

### Fix

`HistoryChangeEvent` (emitted by `createDocumentStoreWithEvents`) carries `nextState` with the restored `state.selection`. Apps subscribe once to centralise cursor sync, eliminating the per-site readback.

```ts
store.addEventListener('history-change', ({ nextState }) => {
  const head = query.getSelectionHead(nextState)
  if (head !== undefined) {
    const text = scan.getValue(nextState.pieceTable) as string
    const charOff = store.byteToCharOffset(text, position.rawByteOffset(head))
    setCursor(clampNormal(charOff, text))
  }
})

// keydown handler shrinks to:
case 'u':
  if (canUndo) dispatch(DocumentActions.undo())
  break
```

### Changes made

**`src/store/features/events.ts`**
- Added JSDoc on `HistoryChangeEvent` with cursor-sync example using `nextState.selection`, `query.getSelectionHead`, and `position.rawByteOffset`.

**`src/types/store.ts`**
- Strengthened JSDoc on `dispatch` to note: use the return value directly for undo/redo rather than calling `getSnapshot()` afterward; or subscribe to `history-change` on a `DocumentStoreWithEvents` to centralise cursor sync.
