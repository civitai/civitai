# app-index-go

A search index of the apps a registry streams. It subscribes to the app entity schema
(`urn:schema:apps.civitai.com:app@v1`, published by the registry adapter in
`src/server/registry-adapter/`), keeps every app in its own Postgres database, and answers
`GET /search`. The index is a cache: it can always be rebuilt from the registry. Its shape follows
the registry spec's model-index example.

The `/apps` store reads it for text search when the `app-index-search` Flipt flag is on for the
viewer (`src/server/services/blocks/app-index-search.service.ts`, `APP_INDEX_URL`). Any failed
call serves the store's database search instead, and a run of them opens a per-process breaker
that stops calling the index for a cooldown (`APP_INDEX_BREAKER_FAILURE_THRESHOLD`,
`APP_INDEX_BREAKER_COOLDOWN_MS`).

## HTTP

| Route          | What                                                                                                                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /search`  | `q`, `kind` (`onsite` / `offsite`), `category`, `limit` (1-50, default 20) → `{results:[{urn, slug, name, tagline, kind, category, rating, iconUrl, creator}]}` |
| `GET /healthz` | the process is up                                                                                                                                                                       |
| `GET /readyz`  | 200 once a generation is serving (the first `Live`), 503 before                                                                                                                          |
| `GET /metrics` | Prometheus (`app_index_*`)                                                                                                                                                              |

`q` matches word by word: every word must be a prefix of a word of the app's name, slug, tagline or
creator. Results are in relevance order, Postgres `ts_rank` (name above slug and tagline above
creator), then by name; without `q` they are by name. There is one page of at most `limit` results:
no other sort and no paging. `/search` answers 503 until the index is ready.

Every `/search` response, success or error, carries `Access-Control-Allow-Origin: *`, so an app
in a sandboxed iframe can call it from the browser: it answers only public listings and takes no
credentials. `OPTIONS /search` answers a CORS preflight (204, `GET`, `Access-Control-Max-Age`).
`/healthz`, `/readyz` and `/metrics` send no CORS header.

A 200 from `/search` is `Cache-Control: public, max-age=0, s-maxage=30`: a shared cache in front
of the service may hold it for 30 s and absorb repeated searches, while browsers revalidate every
time. Every other response, errors included, is `no-store`. A CDN only applies this to `/search`
once it treats the path as cacheable: the TTL lives here, and the CDN rule only opts the path in.

## Following the stream

- `Upsert` replaces the app's row, `Delete` removes it, `Progress` only moves the cursor. Each stores
  its cursor in the same transaction as its change, so after a crash the index holds exactly what its
  cursor says.
- `Live` stores its cursor. The first `Live` of a building generation makes it the serving one.
- `End` is logged and the subscription is opened again after the longest backoff.
- A restart resumes from the stored cursor. A stored empty cursor (a snapshot cut off before `Live`)
  starts over.
- `cursor_expired`, a `LayoutVersion` bump (`internal/index`), or a serving generation whose cursor
  is empty builds a new generation from an empty cursor while the old one keeps answering; the switch
  happens in one transaction at the new one's `Live`, and the old one is dropped.
- Any other end of the stream reconnects with the same cursor after an exponential backoff with
  jitter (`APP_INDEX_BACKOFF_*_MS`). A quiet stream is never treated as lost (the spec: a live
  stream may be silent for any length of time); there is no response-header or idle timeout. A dead
  connection is detected by the transport: TCP keepalive probes, and HTTP/2 PING frames over HTTP/2.
- An upsert whose body lacks a field the index relies on is treated as deleted. An event that
  cannot be decoded at all is skipped and counted (`app_index_malformed_events_total`), advancing
  the cursor only when it carried one, so it cannot wedge the stream.
- Only one process follows the stream (a Postgres session advisory lock); others serve searches.
  Writes to a generation also check that this process still owns it (`Postgres.Claim` says exactly
  what that guarantees).

The subscription is anonymous unless `APP_INDEX_REGISTRY_TOKEN` is set, so the registry serves it the
audience anyone may read: SFW apps only.

## Configuration

See `.env.example`. `APP_INDEX_REGISTRY_URL` and `APP_INDEX_DATABASE_URL` are required. The service
creates its tables at startup (`internal/store/postgres.go`); point it at a database of its own.
`APP_INDEX_DATABASE_URL` must be a direct (session) connection, never a transaction-mode pooler: the
consumer lock is a session advisory lock, which such a pooler does not hold.

## Tests

```
go test ./...                                              # unit: in-memory store, fake registry
APP_INDEX_TEST_PG_URL=postgres://… go test -tags integration -run Integration ./...   # Postgres
```

The unit tier runs the store contract and the consumer scenarios against the in-memory store; the
integration tier runs the same contract and scenarios against Postgres. CI runs both
(`.github/workflows/app-index-go.yml`).

## Releasing

`pnpm run release:app-index-go` bumps `package.json` and cuts an `app-index-go-vX.Y.Z` tag
(`scripts/release-app.mjs`). Building an image from that tag needs a tag-webhook entry for
`app-index-go`, which does not exist yet.
