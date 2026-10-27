---
id: GEN-DOS-001
title: Unbounded work or allocation from an untrusted size
severity: medium
category: resource-exhaustion
tags: [dos, unbounded, allocation, memory, limit, size, length, capacity, recursion, amplification]
---

## Why it matters

Allocating or looping based on a size that comes from untrusted input lets a
single request exhaust memory or CPU. The same shape covers unbounded recursion,
regex backtracking, and quadratic scans.

## Signals in a change

- Buffer/array/list sized or preallocated from a request-supplied length.
- A loop count or recursion depth taken from input without an upper bound.
- A read with no maximum size (whole body/file/stream into memory).
- A regex or nested loop over input that can degrade to quadratic/exponential time.
- A decompression/parse with no expansion or depth limit.

## Evidence required

- The allocation/loop site as `path:line` with an excerpt.
- The untrusted size and the missing bound.
- The worst-case cost at the maximum acceptable input.
