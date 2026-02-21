# Plugin System Status

## 1. Current Status

A plugin runtime is **not implemented** in the current codebase.

There is no:
- plugin registration API
- plugin lifecycle manager
- command registry
- interceptor pipeline
- decoration provider API

## 2. Available Extension Surface Today

You can currently extend behavior by wrapping store usage directly:
- wrap `dispatch`
- observe `subscribe`
- use `createDocumentStoreWithEvents` for typed events
- call pure helpers/selectors on snapshots

This is application-level composition, not a formal plugin host.

## 3. Constraints for Future Plugin Runtime

When implemented, plugin system should align with existing architecture:
- keep reducer and core operations deterministic
- avoid mutating snapshots
- make plugin effects explicit around action dispatch boundaries
- preserve undo/redo invariants and transaction semantics

## 4. Suggested Minimal Future API (Not Implemented)

- `registerPlugin(plugin)`
- `unregisterPlugin(id)`
- lifecycle hooks: `activate`, `deactivate`
- explicit action middleware/interceptor stage with ordering rules

Until then, treat this file as a status placeholder, not an implemented API contract.
