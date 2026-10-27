---
id: GEN-ERR-001
title: Swallowed error or ignored failure
severity: high
category: error-handling
tags: [catch, except, ignore, swallow, empty, pass, error, exception, suppress, silent]
---

## Why it matters

Catching an error and doing nothing (or only logging at a level nobody reads)
hides a real failure. Callers proceed with bad state, data is silently lost, and
the defect surfaces far from its cause.

## Signals in a change

- `catch`/`except` with an empty body, `pass`, or a bare comment.
- Broad catches (`Exception`, `Throwable`, bare `except:`) added around new code.
- A returned error/result value is discarded without a check.
- A failure path that returns a default (null/0/false) instead of propagating.
- Error is logged but execution continues as if it succeeded.

## Evidence required

- The catch/ignore site as `path:line` with an excerpt.
- What a caller observes when the error is discarded (wrong result, silent loss).
- If the swallow is intentional, where it is documented and why it is safe.
