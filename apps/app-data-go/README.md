# app-data-go

The one shared app-data service: it serves app clients their users' private app data, read through
the registry, so browsers never subscribe to the registry themselves. **Scaffold** (P3 slice S5): it
builds on the registry adapter's private streams (S2) and is not deployed (prerequisites: DESIGN.md
and the PR's infra list). The design, the stream
count arithmetic and the open questions are in [DESIGN.md](DESIGN.md).

```
GET /v1/apps/{slug}/collections/{collection}/records[?major=N]
Authorization: Bearer <the app's hub access token for the user>
→ {"source":"registry"|"rest","items":[{"urn"|"key":…,"rev":…,"data":{…}}]}
```

A read is answered from a per-user stream on the registry adapter, opened lazily with a token this
service exchanges from the user's own, as the adapter's relay (the origin judges it). When no stream
can answer in time, the read comes from the site's document-store REST list, made with the user's
token. With `APP_DATA_REGISTRY_URL` unset every read is the REST read and no token is exchanged. An
App Block token is exchanged at the hub's block exchange, once per block token, only with
`APP_DATA_BLOCK_EXCHANGE` on (default off: it reads REST), after its signature and claims are checked
here against the site's block-token JWKS (`APP_DATA_BLOCK_JWKS_URL`); DESIGN.md, "Block tokens".

With `X-App-Data-Registry-Only: 1` a read the registry cannot answer is not read from REST: it
answers `{"source":"none","reason":<why>,"items":[]}`. The site's shadow read of App Storage lists
sends it, since the REST fallback is the site's own route (DESIGN.md, "P4: the site's shadow read").

## Layout

| Package             | What                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------- |
| `cmd/app-data-go`   | wiring and shutdown                                                                       |
| `internal/api`      | the HTTP surface, the fallback decision                                                   |
| `internal/session`  | per-token streams: lazy open, idle, age and expiry close, caps, the cache                 |
| `internal/exchange` | the RFC 8693 token exchange at the hub, as this service's relay client; the block cache   |
| `internal/registry` | the registry HTTP binding consumer, a byte-identical copy of app-index-go's (CI compares) |
| `internal/rest`     | the document-store REST read                                                              |
| `internal/urn`      | the collection schema URN, pinned to the adapter's by golden vectors                      |
| `internal/config`   | the environment ([.env.example](.env.example)), validated at start                        |
| `internal/metrics`  | Prometheus series, `app_data_*`; no label holds a token, user, app or collection          |

## Tests

CI only (`.github/workflows/app-data-go.yml`): gofmt, vet, `go test -race` with test-count and
coverage floors (`ci/coverage-floors.txt`), golangci-lint, govulncheck, go.mod tidiness, a fuzz run of
the SSE reader. The golden vectors (`testdata/golden/vectors.json`) are regenerated from the adapter's
TypeScript in `scripts/__tests__/app-data-go-vectors.schema-drift.test.ts`:

```
pnpm exec tsx --tsconfig tsconfig.json apps/app-data-go/testdata/golden/gen.ts
```

The tests use a fake registry that judges by token as the adapter does, with pairwise-distinct
fixtures per user: lazy open, idle and age close, `Delete` on revoke, isolation between users, cap
exhaustion falling back to REST, the live-wait deadline and a stalled stream. The fake adapter
accepts only tokens the fake hub exchanged, so a user's own token reaching it fails the run.
