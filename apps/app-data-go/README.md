# app-data-go

The one shared app-data service: it serves app clients their users' private app data, read through
the registry, so browsers never subscribe to the registry themselves. **Scaffold** (P3 slice S5): it
builds on the registry adapter's private streams (S2) and is not deployed (prerequisites: DESIGN.md
and the PR's infra list). The design, the stream
count arithmetic and the open questions are in [DESIGN.md](DESIGN.md).

```
GET /v1/apps/{slug}/collections/{collection}/records[?major=N][&keyPrefix=P]
Authorization: Bearer <the app's hub access token for the user>
→ {"source":"registry"|"rest","items":[{"urn"?:…,"key":…,"rev":…,"version"?:N,"data":{…}}]}
```

A private item's `version` is the document's store version, the number a write's `ifVersion` is
compared against (an app reads a document, then writes it with `ifVersion: doc.version`). `rev` is
kept beside it and stays opaque: on the registry path it is a digest, not a version. A registry item
carries `version` once the adapter's private feed sends it (body format `k3`); until then the field
is omitted, and the SDK reads version `0`, which no stored document has, so a write built from it is
refused `version_conflict`, never applied.

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

**Writes (dark, `APP_DATA_WRITES`, default off: every write route is `404`).** The write routes and
`info` of [WRITES-DESIGN.md](WRITES-DESIGN.md) are checked for shape here (and a block token verified
locally), then forwarded once, never retried, with the user's own token and an HMAC signature
(`internal/sign`), to the site's internal storage route. A lost answer is `504 {outcome: "unknown"}`;
`503 not_forwarded` (refused here before anything was sent, or the site's refusal of the forward
itself: its signature check, or its internal route off) is the only answer safe to resend. A named
`major` is forwarded and judged by the site, whose `409 stale_major` is relayed. The edge's region
headers (`cf-ipcountry`, `cf-region-code`, `x-isuk`) are copied onto the forward and signed.

**Read-your-writes for private collections (dark, the same flag).** Each create, put and delete the
store acknowledged is shown over the writing token's stream (an overlay at the write's `seq`, beside
the stream's own records, never merged into them) until the stream shows it, its head passes it, the
stream deletes its URN, or one adapter poll plus 30 s (`APP_DATA_WRITES_ADAPTER_POLL_SECONDS`, which
must be kept at or above the adapter's `REGISTRY_ADAPTER_POLL_SECONDS`). A read
may name a floor, `?minSeq=S`: met by the stream's head, or for a block token by an acknowledgement
this replica still holds for it; otherwise the stream is reopened once per poll, and a floor still not
met is `503 floor_not_met`, never a REST read; a stream that names no head answers it unfloored, and
one that also holds nothing still answers empty (so the list reads REST) whatever is overlaid. The
keyed get,
`GET /v1/apps/{slug}/collections/{collection}/records/{key}`, answers from the stream only. A head
that went back (the adapter's `cursor_expired`) reopens the stream with no cooldown. With the flag
off none of this runs: no seq or head is read, and `cursor_expired` is a stream error, as before. Shared
collections, marks and the mark floor are not served yet (WRITES-DESIGN.md, "Read-your-writes").

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
| `internal/writes`   | the write routes and `info`: shape checks, the signed forward to the site                 |
| `internal/sign`     | the forward's signature, pinned to the site's by a golden vector                          |
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
