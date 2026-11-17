---
id: GEN-RES-001
title: Resource not released on the error path
severity: high
category: resource-management
tags: [leak, resource, close, release, dispose, file, stream, connection, lock, finally, defer, try-with-resources]
---

## Why it matters

A file handle, stream, socket, lock, or transaction that is acquired and only
released on the success path leaks on exceptions or early returns. Leaks
accumulate and eventually exhaust descriptors, connection pools, or locks.

## Signals in a change

- `open`/`connect`/`acquire`/`lock` followed by manual release, where the release
  is not in a `finally` / `defer` / try-with-resources / `with` block.
- An early `return`/`throw` inserted **after** acquisition but **before** release.
- A `close()`/`dispose()` call removed or moved out of a finally block.
- A guard clause added at the top of a method that already holds a resource.
- Multiple acquisitions where a later one can throw before earlier ones are released.

## Evidence required

- The acquisition site and the release site as `path:line` with excerpts.
- The path that skips the release (exception type or the early return).
