import { describe, expectTypeOf, it } from "vitest";
import { rendering } from "./rendering.js";
import type { DocumentState, SelectionRange, CharSelectionRange } from "../types/state.js";
import type { ByteOffset } from "../types/branded.js";
import type {
  VisibleLine,
  ViewportConfig,
  VisibleLinesResult,
  ScrollPosition,
  LineHeightConfig,
} from "../store/features/rendering.js";

describe("public rendering types", () => {
  it("exposes plain results while preserving position brands", () => {
    expectTypeOf(rendering.getVisibleLineRange).toEqualTypeOf<
      (
        scroll: ScrollPosition,
        totalLines: number,
        overscan?: number,
      ) => { startLine: number; endLine: number }
    >();
    expectTypeOf(rendering.getVisibleLines).toEqualTypeOf<
      (state: DocumentState, config: ViewportConfig) => VisibleLinesResult
    >();
    expectTypeOf(rendering.getVisibleLine).toEqualTypeOf<
      (state: DocumentState, lineNumber: number) => VisibleLine | null
    >();
    expectTypeOf(rendering.getLineContent).toEqualTypeOf<
      (state: DocumentState, lineNumber: number) => string | null
    >();
    expectTypeOf(rendering.estimateLineHeight).toEqualTypeOf<
      (line: VisibleLine, config: LineHeightConfig) => number
    >();
    expectTypeOf(rendering.estimateTotalHeight).toEqualTypeOf<
      (state: DocumentState, config: LineHeightConfig) => number
    >();
    expectTypeOf(rendering.positionToLineColumn).toEqualTypeOf<
      (state: DocumentState, position: ByteOffset) => { line: number; column: number } | null
    >();
    expectTypeOf(rendering.lineColumnToPosition).toEqualTypeOf<
      (state: DocumentState, line: number, column: number) => ByteOffset | null
    >();
    expectTypeOf(rendering.selectionToCharOffsets).toEqualTypeOf<
      (state: DocumentState, range: SelectionRange) => CharSelectionRange
    >();
    expectTypeOf(rendering.charOffsetsToSelection).toEqualTypeOf<
      (state: DocumentState, range: CharSelectionRange) => SelectionRange
    >();
  });
});
