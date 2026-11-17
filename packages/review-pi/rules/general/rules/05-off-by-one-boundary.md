---
id: GEN-BOUND-001
title: Off-by-one or mishandled boundary condition
severity: medium
category: correctness
tags: [boundary, off-by-one, index, range, loop, length, size, slice, inclusive, exclusive, empty]
---

## Why it matters

Boundary errors on indices, ranges, or slices produce wrong results at the edges
and, worse, out-of-range access on empty or single-element inputs. They are easy
to introduce when refactoring loop bounds or slice math.

## Signals in a change

- Loop bounds changed (`<` vs `<=`, `length` vs `length - 1`) or `+1`/`-1` added to an index.
- Slice/substring ranges changed, especially inclusive/exclusive mixups.
- A new assumption that a collection is non-empty, or that `size` equals the last index.
- `startLine`/`endLine`-style inclusive ranges where one bound is treated as exclusive.
- A `for i in 0..n` vs `0..=n` change.

## Evidence required

- The loop/slice/range as `path:line` with an excerpt.
- The concrete input at the boundary (first, last, empty) and the wrong outcome.
