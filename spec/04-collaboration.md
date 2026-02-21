# Collaboration Status

## 1. What Exists Today

Current codebase has **collaboration action primitives**, not a full collaboration stack.

Implemented:
- `RemoteChange` type (`insert` / `delete`)
- `APPLY_REMOTE` action
- reducer path applying remote changes to piece table + lazy line index

Remote changes intentionally do not push undo history.

## 2. Remote Change Shape

`insert`:
- `start`
- `text`

`delete`:
- `start`
- `length`

## 3. What Is Not Implemented

- Yjs integration
- CRDT bridge
- Awareness/cursor sharing
- Durable Object / WebSocket provider
- Offline queueing + reconnect merge workflow

## 4. Event Semantics (Current)

- Content mutation from `APPLY_REMOTE` is applied in state.
- Event wrapper currently emits `content-change` only for `INSERT/DELETE/REPLACE`, not `APPLY_REMOTE`.

## 5. Recommended Next Collaboration Milestones

1. Add transport/provider abstraction.
2. Add local<->remote operation translation layer.
3. Align event emission so remote content changes surface as `content-change`.
4. Add synchronization conflict/recovery tests.
