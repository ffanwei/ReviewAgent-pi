---
id: GEN-RACE-001
title: Check-then-act race (TOCTOU)
severity: high
category: concurrency
tags: [race, toctou, check, act, atomic, exists, create, get, set, lock, file, conditional]
---

## Why it matters

Between a check and the action that depends on it, another thread or process can
change the state (file created/deleted, row updated, counter changed), so the
action operates on a stale assumption. Classic file-exists-then-open and
get-then-put races.

## Signals in a change

- `exists`/`isFile`/`canRead` followed by an open/create, outside a lock.
- `get(key)` then `if absent: put(key)` on a shared map/cache/store.
- A conditional update split into read-modify-write across two statements.
- A file/row created then assumed to exist.
- A uniqueness check followed by an insert without a constraint/transaction.

## Evidence required

- The check and the dependent action as `path:line` with excerpts.
- The interleaving that breaks the assumption, and who else mutates the state.
- The atomic operation (compare-and-set, `create` with no-overwrite, unique
  constraint, transaction) that should replace the pair.
