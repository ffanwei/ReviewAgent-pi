---
id: GEN-CONC-001
title: Unsynchronized shared mutable state
severity: high
category: concurrency
tags: [concurrency, thread, race, shared, mutable, static, singleton, volatile, synchronized, lock, atomic]
---

## Why it matters

Mutable state shared across threads (a static/singleton field, a shared cache, a
lazily initialized reference) that is read and written without synchronization is
a data race: lost updates, torn reads, or visibility bugs that appear only under load.

## Signals in a change

- A new mutable field on a shared object, or a static/global mutated per request.
- Lazy initialization without a lock or an atomic/volatile guarantee.
- Check-then-write on shared state outside a critical section.
- A collection/singleton handed to multiple threads without a concurrent/immutable wrapper.
- A new `synchronized`/lock added on only one of several access paths.

## Evidence required

- The shared field and all access sites as `path:line` with excerpts.
- The interleaving that produces a wrong result, and who else touches the field.
