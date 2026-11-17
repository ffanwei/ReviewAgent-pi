---
id: GEN-VALID-001
title: Unvalidated external input
severity: high
category: input-validation
tags: [validation, input, untrusted, parse, trust, sanitize, boundary, request, parameter]
---

## Why it matters

Data crossing a trust boundary (request parameters, headers, file contents,
environment, message payloads) that is used without validation lets malformed or
hostile values reach parsing, indexing, and business logic.

## Signals in a change

- A request/parameter/payload value used directly as an index, divisor, path
  segment, query fragment, or buffer size.
- Validation removed, relaxed, or applied to the wrong value.
- A new field read from external input with no type/range/format check.
- Assumed encodings or character sets without verification.
- Trusting a client-supplied id/role/limit without an allow-list.

## Evidence required

- The boundary entry point and the unvalidated use as `path:line` with excerpts.
- The malformed/hostile value that reaches the sink and its consequence.
