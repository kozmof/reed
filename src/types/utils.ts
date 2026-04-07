/**
 * General-purpose utility types for the Reed document editor.
 */

/**
 * Non-empty readonly array — guarantees at least one element.
 * Used for SelectionState.ranges so that primaryIndex: 0 is always valid.
 */
export type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];
