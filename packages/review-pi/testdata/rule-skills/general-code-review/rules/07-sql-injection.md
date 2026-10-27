---
id: GEN-SQL-001
title: Query built by string concatenation
severity: high
category: injection
tags: [sql, injection, query, concatenation, parameterized, prepared, statement, escape, orm]
---

## Why it matters

Building a query by concatenating or interpolating untrusted values lets an
attacker change the query's structure (SQL injection, and the same shape for
LDAP, NoSQL, command, and template injection).

## Signals in a change

- A query/command string assembled with `+`, `format`, `%`, f-string, or template
  interpolation that includes a variable.
- A parameterized call rewritten to inline the value.
- Escaping/literal-quoting removed, or a hand-rolled escape added.
- An identifier (table/column) interpolated from input.
- A "safe" wrapper that itself concatenates.

## Evidence required

- The assembly site as `path:line` with an excerpt, and the interpolated variable.
- Whether that variable is attacker-controlled (trace it to a boundary entry point).
- The parameterized form that should be used instead.
