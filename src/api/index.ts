/**
 * Complexity-stratified API namespaces.
 *
 * - `query.*` — O(log n) and O(1) operations (tree-based lookups)
 * - `scan.*` — O(n) operations (full document traversals)
 */

export { query } from './query.ts';
export { scan } from './scan.ts';
