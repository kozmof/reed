/**
 * Complexity-stratified and domain-categorized API namespaces.
 *
 * - `store.*`     — store lifecycle, state factories, mutations, reducer, actions, type guards
 * - `query.*`     — O(1) and O(log n) read operations (tree-based lookups)
 * - `scan.*`      — O(n) operations (full document traversals)
 * - `events.*`    — event emitter and document event factories
 * - `rendering.*` — viewport calculations and position/line-column conversion
 * - `history.*`   — undo/redo state queries
 * - `diff.*`      — diff algorithm and setValue operations
 * - `position.*`  — branded position constructors, arithmetic, and constants
 * - `cost.*`      — cost algebra for annotating algorithmic complexity
 */

export type { QueryApi, QueryLineIndexApi, ScanApi, HistoryApi } from "./interfaces.ts";
export { store } from "./store.ts";
export { query } from "./query.ts";
export { scan } from "./scan.ts";
export { events } from "./events.ts";
export { rendering } from "./rendering.ts";
export { history } from "./history.ts";
export { diff } from "./diff.ts";
export { position } from "./position.ts";
export { cost } from "./cost-doc.ts";
