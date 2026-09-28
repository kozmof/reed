# Collaboration Status

## 1. What Exists Today

Reed provides actions for applying remote changes. It does not provide a complete collaboration system.

Implemented:

- `RemoteChange` type (`insert` / `delete`)
- `APPLY_REMOTE` action
- reducer path applying remote changes to piece table + lazy line index

Remote changes intentionally do not push undo history. Applying a remote edit clears
both local undo and redo stacks because stored offsets are not rebased. Empty or
otherwise ineffective remote actions preserve history. New local edits start a
fresh history after the remote edit. Applications that need collaborative undo
must manage that history outside Reed.

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
