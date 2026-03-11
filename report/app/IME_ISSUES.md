# IME Input Handling in VimApp — Problem & Solution

## Background

VimApp is a vim-mode editor built on a `contenteditable` div. All input is
handled manually; the browser never modifies the document on its own. This
works well for ASCII but requires careful coordination with IME (Input Method
Editor) used for Japanese, Chinese, Korean, etc.

---

## Issues Encountered & Fixes Applied

### Issue 1 — Composition text inserted at position 0

**Symptom:** Typing Japanese with IME inserted the composed text at the
beginning of the document regardless of cursor position.

**Root cause:** The browser's native cursor (DOM Selection) was never
positioned. `useLayoutEffect` replaced `innerHTML` on every render but never
called `window.getSelection().addRange(...)`. When IME activated it inserted
at the browser's default position — offset 0 in the container.

**Fix:** After every `innerHTML` update in insert mode, call
`placeInsertCursor(el, charOffset)` to position the browser's Selection at the
correct text-node offset. This gives IME an explicit, correct insertion point.

---

### Issue 2 — Preedit characters appeared vertically (one per line)

**Symptom:** Typing `nihongo` with Japanese IME showed:

```
に
ほ
ん
ご
```

Then after confirmation, `日本語` appeared correctly.

**Root cause (first attempt):** The editor rendered each line as a `<div>`.
The browser's contenteditable block-editing model created a new `<div>` for
each `compositionupdate` instead of extending the existing preedit text inline.

**Partial fix:** Changed `buildHtml` from div-per-line to a flat structure
with `<br>` as line separators. This prevents the browser from creating new
block elements on each composition update.

**Root cause (remaining):** The `<span class="vim-cur-ins">` cursor element
(an `inline-block` span) was embedded at the cursor position even in insert
mode. IME tracks its preedit range as a Selection over **text nodes**. An
`inline-block` span at the insertion point disrupts preedit range tracking:
the browser loses the range on each `compositionupdate` and re-inserts from
scratch, creating a new element each time.

**Fix:** Removed the cursor span from insert mode entirely. `buildHtml` now
produces **plain text + `<br>` only** in insert mode — no span elements
whatsoever. The visual cursor is provided by the browser's native caret
(`caretColor: '#a6e3a1'` on the div). `placeInsertCursor` positions it inside
the text node at the exact character offset, which is the well-defined
insertion point that all IME implementations expect.

---

### Issue 3 — First character of every IME session double-inserted

**Symptom:** Typing `nihongo` → `日本語` produced `n日本語` (the romanized
first keystroke leaked into the document).

**Root cause:** In browsers, `keydown` fires **before** `compositionstart`.
So the first keypress of an IME session (e.g. `n`) reaches `onKeyDown` with
`isComposing = false` — it looks like a regular keystroke. The char gets
dispatched to Reed. Then `compositionstart` fires and sets `isComposing =
true`. When the user confirms, `compositionend` dispatches the full composed
text (`日本語`). Reed ends up with both `n` and `日本語`.

#### Original fix: rollback in `onCompositionStart` (superseded)

> This approach still correctly handles the double-insert, but creates two
> history entries per IME session. See **Current fix** below.

```
keydown('n') fires
  → insert 'n' into Reed
  → lastInsertedChar.current = { pos: cursor, char: 'n' }

compositionstart fires
  → isComposing.current = true
  → dispatch delete(pos, pos+1) to Reed  ← rolls back 'n'
  → lastInsertedChar.current = null

compositionend fires
  → dispatch insert(pos, '日本語')
```

Problem: two dispatches → two history entries → user must press `u` twice to
undo one IME session.

#### Current fix: deferred rollback with `insertComposed`

`keydown` still inserts speculatively and records the rollback range.
`compositionstart` records the rollback info but **does not dispatch** the
delete. `compositionend` dispatches a single `insertComposed` action, which
delegates to `REPLACE` and creates **one** history entry.

```
keydown('n') fires
  → insert 'n' into Reed
  → lastInsert = { start: pos, end: byteOffset(pos + byteLen) }

compositionstart fires
  → isComposing = true
  → rollback = lastInsert; lastInsert = null
  → (no dispatch — defer the rollback)

  ...composition proceeds; Reed has 'n' in it but useLayoutEffect
  skips re-render during composition, so the user never sees it...

compositionend fires
  → dispatch insertComposed(rollback.start, rollback.end, '日本語', selection)
     = REPLACE(rollback.start, rollback.end, '日本語')
     = one HistoryEntry (type 'replace')
  → one u press undoes the entire session
```

`DocumentActions.insertComposed` signature:

```ts
insertComposed(
  rollbackStart: ByteOffset,
  rollbackEnd: ByteOffset,
  composedText: string,
  selection?: readonly SelectionRange[]
): ReplaceAction
```

Edge case: if `compositionend` fires with empty text (user cancelled),
`REPLACE(start, end, '')` removes the speculative character — still one
history entry, correct behaviour.

For regular ASCII typing (`a`, `b`, `c`), `compositionstart` never fires, so
`lastInsert` is cleared on the next `onKeyDown` call and the char remains in
Reed normally.

---

## Final Architecture Summary

| Event | Role |
|---|---|
| `onKeyDown` | Handles all keys. Records speculative inserts in `lastInsert`. Returns early if `isComposing`. |
| `onCompositionStart` | Sets `isComposing = true`. Saves rollback info from `lastInsert`; does **not** dispatch a delete. |
| `onCompositionEnd` | Sets `isComposing = false`. Dispatches `insertComposed(rollback, composed, selection)` — one atomic history entry. |
| `onBeforeInput` | Allows all events during composition. Blocks all other browser mutations. |
| `useLayoutEffect` | Rebuilds `innerHTML` from Reed state after every change, **skipping** during composition. In insert mode, calls `placeInsertCursor` to keep browser Selection in sync with the logical cursor. |

### Key design constraints

- **Insert mode DOM is span-free.** Any span element at the insertion point
  confuses IME preedit range tracking. The visual cursor is the browser's
  native caret only.
- **Flat `<br>` structure, not div-per-line.** Block elements cause IME to
  wrap each composition update in a new block.
- **Text-node-based Selection placement.** `placeInsertCursor` walks the DOM
  and calls `range.setStart(textNode, offset)`, not
  `setStartBefore(element)`. Text-node ranges are the canonical input for all
  IME implementations.
- **Deferred rollback, not immediate.** `compositionstart` records rollback
  info but does not dispatch. `compositionend` dispatches a single `REPLACE`
  via `insertComposed`, keeping the IME session as one undo entry.
  (`useLayoutEffect` skips during composition, so Reed holding the speculative
  char is invisible to the user.)
