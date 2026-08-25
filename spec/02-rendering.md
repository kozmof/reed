# Rendering and viewport status

## 1. Scope of Current Rendering Layer

Reed provides rendering selectors and utilities through `rendering.*`. Their implementation is in `src/store/features/rendering.ts`.

Implemented utilities:

- `getVisibleLineRange(scroll, totalLines, overscan?)`
- `getVisibleLines(state, config)`
- `getVisibleLine(state, lineNumber)`
- `getLineContent(state, lineNumber)`
- `estimateLineHeight(line, config)`
- `estimateTotalHeight(state, config)`
- `positionToLineColumn(state, byteOffset)`
- `lineColumnToPosition(state, line, column)`
- `selectionToCharOffsets` / `charOffsetsToSelection`

## 2. Current Behavior

### 2.1 Viewport range

- `getVisibleLineRange` maps scroll pixels to `[startLine, endLine]`.
- Default overscan is `5` lines.

### 2.2 Visible lines

- `getVisibleLines` resolves resident line ranges, then reads the contiguous viewport text once.
- Returned lines include offsets and `hasNewline` metadata.
- `totalLines` is the expected count including unloaded chunk metadata.
- `residentLineCount`, `isComplete`, and `coordinateSpace: "resident"` distinguish renderable resident lines from the expected count.
- Results are immutable and frozen.

### 2.3 Height estimation

- Supports fixed-height mode and estimated wrapped-height mode.
- Wrapped mode uses either full scan for small documents or sampled extrapolation for large documents.
- Unloaded lines contribute one base-height row because their wrap length is unknown.

### 2.4 Position conversion

- Byte offset and line/column conversions use the resident line tree and bounded piece-table reads.
- A byte position inside a UTF-8 sequence returns `null` for position lookup or throws `RangeError` for selection conversion.
- In the other direction, a column inside a code point resolves to the end of that character, so `lineColumnToPosition` always returns a code-point boundary. The snap is forward, so a caret UI that wants the start of the character snaps on its own side.
- Character and byte selection conversion handles UTF-8 and UTF-16 differences through helper conversions.

## 3. Complexity Model in Code

- Query namespace (`src/api/query.ts`) exposes selector-style functions with documented complexity labels.
- Scan namespace (`src/api/scan.ts`) exposes full traversal operations.
