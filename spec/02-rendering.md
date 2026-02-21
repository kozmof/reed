# Rendering & Viewport Status

## 1. Scope of Current Rendering Layer

Current rendering code is a **pure selector/utilities layer** in `src/store/features/rendering.ts`.
It does not include a DOM `EditorView` component.

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

- `getVisibleLines` queries line ranges from line index and extracts text from piece table.
- Returned lines include offsets and `hasNewline` metadata.
- Results are immutable/frozen.

### 2.3 Height estimation

- Supports fixed-height mode and estimated wrapped-height mode.
- Wrapped mode uses either full scan for small documents or sampled extrapolation for large documents.

### 2.4 Position conversion

- Byte offset <-> line/column conversions rely on line index + piece table range extraction.
- Character/byte selection conversion handles UTF-8/UTF-16 differences through helper conversions.

## 3. Complexity Model in Code

- Query namespace (`src/api/query.ts`) exposes selector-style functions with documented complexity labels.
- Scan namespace (`src/api/scan.ts`) exposes full traversal operations.

## 4. Not Implemented Here

- DOM virtualization engine
- Element recycling/pooling
- Syntax tokenization/render pipeline
- Scroll event binding/UI layer

## 5. Known Issue

- In lazy line-index states, `getLineRangePrecise` can produce incorrect offsets for some multiline edits before reconciliation, which can affect visible line correctness.
