# Collaboration Status

## 1. What Exists Today

Reed provides actions for applying remote changes. It does not provide a complete collaboration system.

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
