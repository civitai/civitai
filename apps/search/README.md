# Search service (apps/search)

A Fastify service in front of Qdrant. Callers send a query and typed filter clauses, and get back
**ranked entity ids**. The contract and a client live in `@civitai/search`
([packages/civitai-search](../../packages/civitai-search/README.md)).

Indexes served: **images** (`POST /images/search`). Text indexes (models first) are planned in
the same service.

## Why ids only

The index is updated asynchronously from Postgres (the event-engine vector sync, see
[docs/features/semantic-image-search.md](../../docs/features/semantic-image-search.md)). A result can
be an image removed a moment ago. The caller looks the ids up through its own fetch path, which
drops whatever should no longer be shown.

## What it owns, and what it doesn't

- **Owns:** the Qdrant queries, filter building from typed clauses, query embedding through the
  orchestrator (`wemm-2b`, 256 dimensions) with a 7-day Redis cache, and the model check: a query
  vector whose model revision or profile differs from the index's is refused (412).
- **Doesn't own:** viewer policy. Browsing level, hidden users, tags and images, and the base-model
  licence rule arrive as plain values. `nsfwLevels` is required, so a forgotten browsing level is a
  400, never unfiltered results.

## API

| Route                 | Auth                                         | Answer                                                                                                                                    |
| --------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`         | none                                         | liveness, no dependencies                                                                                                                 |
| `GET /metrics`        | in-cluster only (404 with `x-forwarded-for`) | Prometheus                                                                                                                                |
| `POST /images/search` | bearer `SEARCH_TOKEN`                        | `{ ids }`; 400 invalid, 404 "more like this" point not indexed, 412 index not ready or model mismatch, 502 Qdrant or orchestrator failure |

## Running it

`pnpm dev:search` loads `apps/search/.env` (copy `.env.example`). Qdrant needs a read-only key;
ask an infra owner for access. Tests: `pnpm --filter @civitai/search-app test`.
