---
id: GEN-LOG-001
title: Sensitive data written to logs or errors
severity: medium
category: privacy
tags: [log, logging, privacy, pii, secret, token, password, credential, trace, dump, error]
---

## Why it matters

Logging or embedding secrets and personal data (credentials, tokens, full
payloads, IDs) leaks them into log stores, crash reports, and error messages that
are read far more widely than the data itself.

## Signals in a change

- A log/debug/trace call that includes a token, password, session, or full request body.
- An exception message or stack trace that carries credential or PII values.
- A new debug dump of an object that contains secrets.
- A URL logged with query parameters (keys/full url with token).
- Secret/PII added to a metric label or span attribute.

## Evidence required

- The log/error site as `path:line` with an excerpt.
- Which value is sensitive and where it originates.
- The redaction/bounded-format approach that should be used instead.
