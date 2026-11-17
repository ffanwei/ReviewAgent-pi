---
id: GEN-NULL-001
title: Null / undefined dereference without a guard
severity: high
category: null-safety
tags: [null, none, nil, undefined, dereference, optional, npe, guard]
---

## Why it matters

Dereferencing a value that can be null/None/undefined throws at runtime
(NullPointerException, TypeError, AttributeError). It is one of the most common
crash sources in review findings and is frequently reachable from untrusted input.

## Signals in a change

- A value returned by a lookup, parse, map/array access, or an external call is
  used immediately with no null check.
- Optional-style values are unwrapped with a forced operator (`!`, `!!`,
  `.unwrap()`, direct member access on a maybe-null reference).
- A guard was removed, or a new early-return path skips an existing guard.
- A field/parameter type changed from non-nullable to nullable.

## Evidence required

- The exact expression that can be null, and why (its producer).
- The dereference site as `path:line` with a short excerpt.
- A reachable path from input/API to the dereference.
