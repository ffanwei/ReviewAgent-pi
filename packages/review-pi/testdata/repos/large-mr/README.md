# Large MR sample service

A small multi-language order service used by the end-to-end review harness.
It is deliberately imperfect: the fixture exists so that a real review run has
enough material to page through several shards and emit findings for every
changed file.

## Layout

- `service/` — order worker (Go) and pricing helpers (Python)
- `web/` — order HTTP API (TypeScript)
- `native/` — inventory allocator (C++)
- `src/main/java` — order domain (Java)

## Running locally

The fixture is not meant to be deployed. Each language layer is independent so
the review harness can exercise several parsers in a single diff:

```bash
# Java domain
mvn -q -DskipTests package

# TypeScript API
node --experimental-strip-types web/src/orderApi.ts

# Python pricing helpers
python -m service.pkg.pricing

# Go worker
go run ./service/cmd

# C++ allocator
g++ -std=c++17 native/src/allocator.cpp -o build/allocator
```

## Behaviour notes

- Orders are cached in process memory; the cache is unbounded on purpose.
- Payment capture and refunds call the merchant gateway with a bearer token.
- The worker keeps a per-order `running` flag plus a shared result slice.
- The allocator owns raw `char *` blocks and reuses them between reservations.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ORDER_DB_URL` | `http://127.0.0.1:9000` | Order storage base URL |
| `ORDER_DB_PATH` | `orders.db` | SQLite file for the pricing helpers |
| `ORDER_REGION` | `cn` | Region used by the audit report |
| `ORDER_WORKERS` | `4` | Worker pool size |

The defaults are safe for local runs but are not production values.

## Review harness

`packages/review-pi/testdata/e2e/large-mr.diff` is generated from this tree by
`scripts/e2e-mcp/make-large-mr.mjs`. The script builds a throwaway git repo from
`packages/review-pi/testdata/e2e/large-mr/before`, copies this tree on top, and
captures `git diff --cached`. Re-run it after editing any fixture file:

```bash
node scripts/e2e-mcp/make-large-mr.mjs
```

The harness then starts a local MCP server (`scripts/e2e-mcp/server.mjs`) and
runs a real `review-pi review` against the generated diff. Every changed file is
expected to produce exactly one `mrReviewResult` call before the summary.
