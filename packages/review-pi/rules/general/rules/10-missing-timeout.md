---
id: GEN-TIMEOUT-001
title: Blocking I/O without a timeout
severity: medium
category: reliability
tags: [timeout, deadline, hang, blocking, io, network, socket, retry, wait, connect, read]
---

## Why it matters

A network/socket/file/queue call with no timeout can block forever when the peer
stalls, tying up a worker or a lock and cascading into an outage. Retries without
a timeout or budget amplify the problem.

## Signals in a change

- A new outbound call (HTTP client, DB, socket, subprocess) with no timeout set.
- An existing timeout removed, raised without reason, or made non-finite.
- A retry loop with no total time budget or no cap on attempts.
- A lock acquisition with no timeout on a path that can wait indefinitely.
- A default client/connection reused where the default timeout is "none".

## Evidence required

- The call site as `path:line` with an excerpt.
- Why the peer can stall and what the worker holds while waiting.
- The timeout/deadline and retry budget that should be set.
