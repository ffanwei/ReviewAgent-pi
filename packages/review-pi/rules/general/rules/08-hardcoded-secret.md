---
id: GEN-SECRET-001
title: Hardcoded secret or credential
severity: high
category: secrets
tags: [secret, credential, password, token, apikey, api-key, key, private, hardcoded, embed, certificate]
---

## Why it matters

A secret committed in source (password, API key, private key, token, connection
string) is exposed to everyone with repo access and lives forever in history. It
cannot be rotated by configuration.

## Signals in a change

- A literal assigned to a name like `password`, `secret`, `token`, `apiKey`,
  `privateKey`, or embedded in a URL/connection string.
- A real-looking key/credential in a test, sample, or default config (still a leak
  if it is live, and a bad pattern if not).
- A secret moved from config/env into code.
- A certificate or private key with actual key material.
- A TODO/default placeholder replaced with a value instead of a lookup.

## Evidence required

- The literal site as `path:line` with an excerpt (redact the value's tail).
- Whether the value looks live vs. a placeholder.
- The configuration/secret-store lookup that should replace it.
