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

## 3. Event Semantics (Current)

With `store.createDocumentStoreWithEvents`:

- `APPLY_REMOTE` emits `content-change`.
- `dirty-change` is emitted when remote edits transition dirty state.

## 4. What Is Not Implemented

- Yjs integration
- CRDT bridge
- Awareness/cursor sharing
- Durable Object / WebSocket provider
- Offline queueing + reconnect merge workflow

## 5. Recommended Next Collaboration Milestones

1. Add transport/provider abstraction.
2. Add local<->remote operation translation layer.
3. Add synchronization conflict/recovery tests around reconnect and replay.
4. Add presence/awareness and remote cursor state propagation.
