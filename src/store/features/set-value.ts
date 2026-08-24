import type { DocumentAction } from "../../types/actions.js";
import type { DocumentState, PieceTableState } from "../../types/state.js";
import {
  $beginCost,
  $prove,
  $proveCtx,
  $checked,
  $from,
  $lift,
  $pipe,
  $andThen,
  $map,
  type LinearCost,
  type QuadCost,
} from "../../types/cost-doc.js";
import { getValue } from "../core/piece-table.js";
import { computeSetValueActions, computeSetValueActionsOptimized } from "./text-diff.js";
import { documentReducer } from "./reducer.js";

function applyDocumentActions(
  state: DocumentState,
  actions: readonly DocumentAction[],
): DocumentState {
  let nextState = state;
  for (const action of actions) {
    nextState = documentReducer(nextState, action);
  }
  return nextState;
}

/**
 * Set the entire document value to new content using a single optimized REPLACE operation.
 * Scans for the changed region and emits at most one action — O(n) in document size.
 *
 * For store semantics (single notification and rollback safety), callers should use store.batch().
 *
 * @param state - Current document state
 * @param newContent - The new content to set
 * @returns New document state with the content changed
 */
export function setValue(state: DocumentState, newContent: string): LinearCost<DocumentState> {
  return $prove(
    "O(n)",
    $checked(() =>
      $pipe(
        $from(getValue(state.pieceTable)),
        $andThen((oldContent) => {
          if (oldContent === newContent) {
            return $lift("O(n)", state);
          }

          return $pipe(
            $from(computeSetValueActionsOptimized(oldContent, newContent)),
            $map((resolvedActions) => {
              if (resolvedActions.length === 0) return state;
              return applyDocumentActions(state, resolvedActions);
            }),
          );
        }),
      ),
    ),
  );
}

/**
 * Options for setValueAuto.
 */
export interface SetValueOptions {
  /**
   * Strategy to use when computing the edit:
   * - `'fast'` (default) — single REPLACE operation, O(n). Best for interactive edits.
   * - `'diff'` — memory-bounded Myers script, O(n²). Usually produces finer-grained history.
   */
  strategy?: "fast" | "diff";
}

/**
 * Unified entry point for setting the entire document value.
 * Routes to `setValue` (O(n), single REPLACE) or `setValueWithDiff` (O(n²),
 * memory-bounded diff) based on the `strategy` option.
 *
 * Use `strategy: 'diff'` only when fine-grained undo history matters — e.g. collaborative
 * editing or patch generation. For all other cases the default `'fast'` is preferable.
 *
 * For store semantics (single notification and rollback safety), callers should use store.batch().
 *
 * @param state - Current document state
 * @param newContent - The new content to set
 * @param options - Optional strategy selector
 * @returns New document state with the content changed
 */
export function setValueAuto(
  state: DocumentState,
  newContent: string,
  options?: SetValueOptions,
): QuadCost<DocumentState> {
  if (options?.strategy === "diff") {
    return setValueWithDiff(state, newContent);
  }
  return $proveCtx($beginCost("O(n^2)"), setValue(state, newContent) as DocumentState);
}

/**
 * Set the entire document value to new content using the Myers diff algorithm.
 * Computes a minimal edit script while its trace fits the memory budget; larger
 * unrelated inputs safely fall back to a single coarse replacement.
 *
 * Prefer `setValue` for interactive use. Use this when finer diff granularity matters.
 *
 * For store semantics (single notification and rollback safety), callers should use store.batch().
 *
 * @param state - Current document state
 * @param newContent - The new content to set
 * @returns New document state with the content changed
 */
export function setValueWithDiff(
  state: DocumentState,
  newContent: string,
): QuadCost<DocumentState> {
  return $prove(
    "O(n^2)",
    $checked(() =>
      $pipe(
        $from(getValue(state.pieceTable)),
        $andThen((oldContent) => {
          if (oldContent === newContent) {
            return $lift("O(n^2)", state);
          }

          return $pipe(
            $from(computeSetValueActions(oldContent, newContent)),
            $map((resolvedActions) => {
              if (resolvedActions.length === 0) return state;
              return applyDocumentActions(state, resolvedActions);
            }),
          );
        }),
      ),
    ),
  );
}

/**
 * Compute the optimized REPLACE actions needed to transform a piece table to new content.
 * O(n) — uses `computeSetValueActionsOptimized` internally.
 *
 * @param pieceTable - Current piece table state
 * @param newContent - The desired new content
 * @returns Array of DocumentActions to apply
 */
export function computeSetValueActionsFromState(
  pieceTable: PieceTableState,
  newContent: string,
): LinearCost<DocumentAction[]> {
  return $prove(
    "O(n)",
    $checked(() =>
      $pipe(
        $from(getValue(pieceTable)),
        $andThen((oldContent) => {
          if (oldContent === newContent) {
            return $lift<"O(n)", DocumentAction[]>("O(n)", []);
          }
          return $from(computeSetValueActionsOptimized(oldContent, newContent));
        }),
      ),
    ),
  );
}

/**
 * Compute memory-bounded Myers-diff actions needed to transform a piece table.
 * Produces minimal actions while the trace fits the memory budget and a coarse
 * replacement otherwise. O(n²) worst-case time.
 *
 * @param pieceTable - Current piece table state
 * @param newContent - The desired new content
 * @returns Array of DocumentActions to apply
 */
export function computeSetValueActionsFromStateWithDiff(
  pieceTable: PieceTableState,
  newContent: string,
): QuadCost<DocumentAction[]> {
  return $prove(
    "O(n^2)",
    $checked(() =>
      $pipe(
        $from(getValue(pieceTable)),
        $andThen((oldContent) => {
          if (oldContent === newContent) {
            return $lift<"O(n^2)", DocumentAction[]>("O(n^2)", []);
          }
          return $from(computeSetValueActions(oldContent, newContent));
        }),
      ),
    ),
  );
}
