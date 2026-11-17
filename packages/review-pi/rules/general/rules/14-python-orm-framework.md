---
id: OCR-PY-ORM-001
title: Python ORM / 数据库规则（Peewee / SQLAlchemy）
severity: P1
category: 可靠性
languages: [python]
tags: [python, orm, peewee, sqlalchemy, transaction, sql]
---

> Favor precision over recall: only raise an issue when the defect is observable in the changed code and its immediate ORM/session semantics; stay silent when the framework version or transaction boundary is unclear. Treat correctness and data-integrity findings as blocking.

#### Empty `IN` lists
- Peewee `.in_([])` / `.not_in_([])` and SQLAlchemy `in_([])` generate invalid SQL such as `IN ()` on many backends; guard the empty collection and return early or skip the predicate.

#### Bulk write atomicity
- Bulk `delete`, `update`, `insert_many`, or loops of writes that must succeed together without `db.atomic()` / `session.begin()` / an explicit transaction: a mid-way failure leaves partial data.
- Do not demand a transaction when the operation is intentionally best-effort or already inside a documented transaction boundary.

#### ORM lookups returning `None`
- `.get()`, `.get_or_none()`, `.first()`, `.scalar()`, or raw query helpers that can return `None`; check before indexing, iterating, `.append`, `len`, or passing to code that assumes a value.
- A helper that claims to return a list but returns `None` on an empty result; callers doing `for x in result` or `if item not in result` then fail.

#### Class methods and `cls`
- A `@classmethod` that hardcodes its own concrete class (e.g. `FooService.delete(...)`) instead of `cls`; subclasses then bypass their own overrides.
- Static methods used only to avoid `cls` are not automatically wrong; require a concrete subtype/override consequence.

#### Session / connection lifecycle
- Sessions, connections, or cursors opened without `with`/`try/finally` on error paths; leaked connections under exceptions.
- Queries executed after a session was closed or outside its context.

#### SQL construction
- SQL built with f-strings, `%`, `.format`, or string concatenation from request/user data instead of bound parameters.
- Dynamic `ORDER BY`/table names from user input without an allowlist.
