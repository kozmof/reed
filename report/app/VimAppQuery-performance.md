# VimAppQuery Performance Improvements

**Files compared:**
- `VimApp.tsx` — original implementation (`scan` namespace, string-split position helpers)
- `VimAppQuery.tsx` — optimized implementation (`query` namespace, line-index lookups)

---

## Background

Both components use the same architectural baseline: a Reed piece-table as the document store, `useSyncExternalStore` for React integration, and a contenteditable div for rendering. The key difference is how they answer position questions — "what line/col is this cursor on?" and "what char offset does line N, col C map to?" — on every keypress.

---

## Changes and Complexity Analysis

### 1. `posFromOffset` → `query.findLineAtCharPosition`

**VimApp.tsx (O(n) per call):**
```ts
function posFromOffset(t: string, off: number): { line: number; col: number } {
  const before = t.slice(0, Math.max(0, Math.min(off, t.length)))
  const parts = before.split('\n')           // allocates array of all lines up to cursor
  return { line: parts.length - 1, col: parts[parts.length - 1].length }
}
```
Called in: `buildHtml`, `onKeyDown` (once per keypress), status-bar `useMemo`.

**VimAppQuery.tsx (O(log n) per call):**
```ts
const lineResult = query.findLineAtCharPosition(state, activeCursor) as unknown as
  { lineNumber: number; charOffsetInLine: number } | null
const line = lineResult?.lineNumber ?? 0
const col  = lineResult?.charOffsetInLine ?? 0
```
`findLineAtCharPosition` descends the line-index B-tree using `subtreeCharLength` prefix sums — no string allocation, no scanning.

---

### 2. `t.split('\n')` in `onKeyDown` eliminated

**VimApp.tsx (O(n) on every keypress):**
```ts
const lines = t.split('\n')          // allocates N+1 strings
const curLineText = lines[line] ?? ''
// later: lines[line ± 1].length, lines.length, lines[last].length ...
```
Every keypress — including cursor movement keys that do not mutate the document — triggered a full string split and array allocation proportional to document length.

**VimAppQuery.tsx (O(log n) per line lookup):**
```ts
const charStart = (lineNum: number): number =>
  query.getCharStartOffset(state, lineNum) as unknown as number

const lineLen = (lineNum: number): number =>
  lineNum < lineCount - 1
    ? charStart(lineNum + 1) - charStart(lineNum) - 1
    : t.length - charStart(lineNum)

const curLineStart = charStart(line)
const curLineText  = t.slice(curLineStart, curLineStart + lineLen(line))
```
`getCharStartOffset` is a single B-tree descent (O(log n)). Adjacent line lengths (`lineLen(line ± 1)`) are two more O(log n) calls. The current-line text slice is O(m) where m is the line length — unavoidable since the content is needed for `curLineText.search(/\S/)`, `fw`, etc.

---

### 3. `offsetFromPos` → `charStart(line) + col`

**VimApp.tsx (O(n) per call, called up to 13 call sites in `onKeyDown`):**
```ts
function offsetFromPos(t: string, line: number, col: number): number {
  const lines = t.split('\n')                          // another full split
  const l = Math.min(Math.max(0, line), lines.length - 1)
  const lineStart = lines.slice(0, l).reduce(...)      // O(line) reduction
  return lineStart + Math.min(Math.max(0, col), lines[l].length)
}
```
Every call: one `split('\n')` + one `slice` + one `reduce`. For a cursor on line 1000 of a large document, the reduce alone scans 1000 line lengths.

**VimAppQuery.tsx (O(log n) per call):**
```ts
// line start offset:
charStart(line)                     // single B-tree descent
// line start + col:
charStart(line) + col               // constant addition
```
All 13 `offsetFromPos` call sites in `onKeyDown` are replaced with `charStart(...)` or `charStart(...) + col`, each O(log n).

---

### 4. `buildHtml` decoupled from position computation

**VimApp.tsx:**
```ts
function buildHtml(t: string, cursorOff: number, mode: Mode): string {
  const lines = t.split('\n')
  const { line: curLine, col: curCol } = posFromOffset(t, cursorOff)  // O(n) inside render
  ...
}
```
`buildHtml` called `posFromOffset` internally, burying an O(n) split inside the render function.

**VimAppQuery.tsx:**
```ts
function buildHtml(t: string, curLine: number, curCol: number, mode: Mode): string { ... }

// caller in useLayoutEffect:
const lineResult = query.findLineAtCharPosition(state, clampedCursor)  // O(log n)
el.innerHTML = buildHtml(text, lineResult?.lineNumber ?? 0, lineResult?.charOffsetInLine ?? 0, mode)
```
Position is pre-computed by the caller using the line index; `buildHtml` itself no longer contains a position lookup. (The remaining `t.split('\n')` inside `buildHtml` is unavoidable — iterating all lines to build HTML is inherently O(n).)

---

### 5. Status-bar byte count: `text.length` → `query.getLength`

**VimApp.tsx:**
```tsx
{text.length} bytes
```
`text.length` is a JS string property (O(1) in V8 for UTF-16 code units), but it reports code-unit count, not byte count. For multi-byte characters these diverge.

**VimAppQuery.tsx:**
```ts
const docLen = useMemo(() => query.getLength(state.pieceTable) as unknown as number, [state])
// ...
{docLen} bytes
```
`query.getLength` reads the cached `totalLength` field on the piece-table root — O(1) — and returns the true byte count matching the piece-table's internal representation.

---

## Summary Table

| Operation | VimApp.tsx | VimAppQuery.tsx | Improvement |
|---|---|---|---|
| Cursor → line/col (`posFromOffset`) | O(n) — `slice` + `split('\n')` | O(log n) — `findLineAtCharPosition` | **O(n) → O(log n)** |
| Line/col → char offset (`offsetFromPos`) | O(n) — `split('\n')` + `reduce` | O(log n) — `getCharStartOffset + col` | **O(n) → O(log n)** |
| Line array on every keypress | O(n) — `t.split('\n')` | eliminated — lazy `charStart`/`lineLen` | **O(n) → O(log n)** |
| Adjacent line length (j/k/ArrowUp/Down) | O(1) index into split array (after O(n) split) | O(log n) — `getCharStartOffset` | **O(n) → O(log n)** |
| Current line text | O(1) index into split array (after O(n) split) | O(log n + m) — `charStart` + `slice` | **O(n) → O(log n + m)** |
| Status-bar line/col | O(n) — `posFromOffset` in `useMemo` | O(log n) — `findLineAtCharPosition` | **O(n) → O(log n)** |
| Status-bar byte count | O(1) — JS string `.length` (code units, not bytes) | O(1) — `query.getLength` (true bytes) | correctness fix |
| `lines.length` comparisons | O(1) after O(n) split | O(1) — cached `lineCount` | no change in isolation |

---

## What Was Not Changed

- **`buildHtml`'s `t.split('\n')`** — rendering every line is inherently O(L) where L is line count; cannot be improved without switching to a virtual/windowed renderer.
- **Word motions (`w`/`b`/`e`)** — character-by-character scan of `t`; inherently O(m) where m is the scan distance. The line index does not help here.
- **`clampNormal`** — checks individual characters of `t`; inherently O(1) per call given the full string.
- **`toByteOffset` / `selAt`** — require the full text string for `store.charToByteOffset`; unchanged.
- **`onCompositionEnd`** — still materializes the full document via `query.getText` because `toByteOffset` needs the string. No regression from the original `scan.getValue`.

---

## Practical Impact

For a document of N bytes and L lines, the cost of a single keypress in `onKeyDown` dropped from:

- **VimApp.tsx**: O(N) unconditionally — at minimum one `t.split('\n')` plus one `posFromOffset` (another `slice` + `split`), regardless of which key was pressed.
- **VimAppQuery.tsx**: O(log L) for position + line-length queries, plus O(m) for the current-line text slice where m ≪ N.

For a 100 KB document (~3 000 lines), each cursor-movement keypress in VimApp.tsx allocates and GC-collects ~6 000+ strings. VimAppQuery.tsx performs ~3 B-tree descents (each ~12 comparisons at depth log₂(3000) ≈ 12) and one bounded slice.
