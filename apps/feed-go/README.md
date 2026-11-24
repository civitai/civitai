# feed-go (apps/feed-go)

A Go port of the tRPC procedure `image.getImagesAsPostsInfinite` (the model / Model3D gallery feed)
and, in shadow only, of the tRPC procedures `image.getInfinite` (the flat image feed; also servable
behind `FEED_GO_SERVE_INFINITE`, default off) and `model.getAll` (the model browse feed; also servable
behind `FEED_GO_SERVE_MODEL_GETALL`, default off) and the public
REST endpoints `GET /api/v1/images` and `GET /api/v1/models` / `/api/v1/models/{id}` (the model ones
also servable behind `FEED_GO_SERVE_V1_MODELS`, the images one behind `FEED_GO_SERVE_V1_IMAGES`, both
default off), built to measure CPU per
request against the Node path on the same traffic. It answers the request shapes it has ported and
proxies everything else to the Node app unchanged. **Read
[DESIGN.md](DESIGN.md) first** — it covers scope, auth, wire format, routing, shadow comparison, the
measurement plan, the parity gaps and deploy prerequisites.

This is the repo's only Go module. It is not a pnpm workspace member and none of the Node suites or
scripts touch it; its CI is `.github/workflows/feed-go.yml`.

## Endpoints

| Listener                          | Path                                                   | Purpose                                                                                                                                         |
| --------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `FEED_GO_ADDR` (`:8080`)          | `GET /api/trpc/image.getImagesAsPostsInfinite`         | the procedure; only listens when `FEED_GO_FALLBACK_URL` is set                                                                                  |
|                                   | `GET /api/trpc/model.getAll`                           | computed only with `FEED_GO_SERVE_MODEL_GETALL=true` (default off: proxied to the Node app as the `model-getall-off` fallback; DESIGN.md §15.8) |
|                                   | `GET /api/trpc/image.getInfinite`                      | computed only with `FEED_GO_SERVE_INFINITE=true` (default off: proxied to the Node app as the `infinite-off` fallback; DESIGN.md §14.8)         |
|                                   | `GET /api/v1/models`, `GET /api/v1/models/{id}`        | mounted only with `FEED_GO_V1_FALLBACK_URL`; computed only with `FEED_GO_SERVE_V1_MODELS=true` (default off: proxied as `v1-models-off`; §16.8) |
|                                   | `GET /api/v1/images`                                   | mounted only with `FEED_GO_V1_IMAGES_FALLBACK_URL`, its one fallback upstream; computed only with `FEED_GO_SERVE_V1_IMAGES=true` (default off: proxied as `v1-images-off`; §13.8) |
| `FEED_GO_INTERNAL_ADDR` (`:9090`) | `GET /healthz`                                         | liveness / readiness                                                                                                                            |
|                                   | `GET /metrics`                                         | Prometheus (`feed_go_*`, Go runtime, process CPU)                                                                                               |
|                                   | `POST /internal/shadow/image.getImagesAsPostsInfinite` | shadow comparison (DESIGN.md §7)                                                                                                                |
|                                   | `POST /internal/shadow/api/v1/images`                  | shadow comparison of the REST images endpoint, body and response headers (DESIGN.md §13)                                                        |
|                                   | `POST /internal/shadow/image.getInfinite`              | shadow comparison of `image.getInfinite` (DESIGN.md §14)                                                                                        |
|                                   | `POST /internal/shadow/model.getAll`                   | shadow comparison of `model.getAll` (DESIGN.md §15)                                                                                             |
|                                   | `POST /internal/shadow/api/v1/models`, `…/models/id`   | shadow comparison of the REST model endpoints, body and response headers (DESIGN.md §16)                                                        |
|                                   | `GET /debug/pprof/…`                                   | `net/http/pprof`, only with `FEED_GO_PPROF=true` (default off; DESIGN.md §10.2)                                                                 |

A request from a blocked region (`REGION_BLOCK_CONFIG`) is handed to the Node app, which answers its
451, unless `FEED_GO_ANSWER_REGION_BLOCKED=true` (default off): then every public route writes that
same 451 here (outcome `region_blocked`; DESIGN.md §6.2).

Every answer on the public routes carries `X-Feed-Go-Served`: `go` when this service computed it
(or answered the error itself), `node` when it was proxied to the Node app, including the proxy's own 502. The browser's shadow compare (`src/utils/faro/shadowCompare.ts`) reads it, so a proxied answer,
which is Node's own bytes, is never counted as Go matching Node. Same-origin, so no CORS
`Access-Control-Expose-Headers` is needed for the browser to read it.

Answers are superjson unless `TRPC_WRITE_DEVALUE=true` (the Node app's own switch, read the same way):
then an answer this service computes for a web bundle new enough to read devalue, and not
edge-cacheable, is devalue, byte for byte the body the Node app writes (DESIGN.md §5.2). Proxied
answers and shadow comparisons are unchanged either way.

## Run locally

**It just works with `pnpm dev`.** The root `dev` script (`scripts/dev-feed-go/launcher.mjs`) starts
`next dev` and, next to it, feed-go at the version pinned in `package.json`: the release binary for
your platform (linux/darwin, amd64/arm64), downloaded once from the `feed-go-v<x.y.z>` GitHub Release
into `node_modules/.cache/feed-go/` and checked against that release's `SHA256SUMS` (a mismatch is
refused, never run), or, when no binary can be had and Go is installed, a `go build` of this directory.
feed-go gets only the variables it reads from the app's own `.env` chain (database replica, both
Redis URLs, the auth hub's issuer and JWKS, the domain and region settings and any `FEED_GO_*` you
set), loopback listeners on free ports, and the local Next as its fallback. Next's
`/api/trpc-go/<procedure>` rewrite then points at a loopback proxy that hands each request to feed-go
while its `/healthz` answers (re-checked for as long as it runs, so a recovered feed-go is used
again), and to Next's own `/api/trpc/<procedure>` otherwise; a GET feed-go answers with a 5xx is
re-sent to Next too. So with feed-go missing, broken or exited the app behaves exactly as it did
without it. In dev the launcher also
switches the client's Go-transport flags on (`FLIPT_LOCAL_OVERRIDES` gets
`feed-go-transport=on,feed-go-transport-model-getall=on` unless you name either key yourself), so a
signed-in gallery feed actually reaches feed-go. feed-go is read-only here (write-back off) and answers
nothing it has not ported, so what you see is still Node's answer for everything else.

`FEED_GO_LOCAL` (real env or `.env`) picks the mode: unset or `auto` (release binary, else
`go build`), `source` (always build this directory: use it when changing the Go code), or `off`
(`next dev` alone, today's behaviour; a `FEED_GO_LOCAL_URL` you set yourself, e.g. to a feed-go in
Docker, is then left in place). If Next's port (`-p`, `PORT`, else 3000) is already taken, feed-go
is skipped for that run, since Next would move to another port.

Troubleshooting: every launcher line starts with `[feed-go]`.

| Line                                            | Meaning                                                                                                                                       |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `… ready; /api/trpc-go → feed-go`               | serving                                                                                                                                       |
| `download of feed-go-v<x.y.z> failed: HTTP 404` | no release binaries for that tag yet (a maintainer runs the `feed-go release binaries` workflow on it); install Go or set `FEED_GO_LOCAL=off` |
| `checksum mismatch …; refusing to run it`       | the download does not match `SHA256SUMS`; nothing was written. Retry; if it persists, report it                                               |
| `not started: port <n> is in use …`             | something already listens on Next's port; free it or pass `-p <port>` (or use the dev-server daemon, which picks a free one)                  |
| `not started: the app env has no …`             | the named variables are missing from your `.env` (values are never printed)                                                                   |
| `unhealthy; … until it recovers`                | `/api/trpc-go` is served by Next until `/healthz` answers again                                                                               |
| `exited (…)`                                    | feed-go stopped; `/api/trpc-go` is served by Next until `pnpm dev` restarts                                                                   |
| `answered 5xx; re-sent to Next`                 | feed-go failed one request; Next answered it                                                                                                  |

You are editing Node's `image.getImagesAsPostsInfinite` and see no change while signed in? That
request is answered by feed-go: run with `FEED_GO_LOCAL=off`, or set
`FLIPT_LOCAL_OVERRIDES=feed-go-transport=off`.

To run it by hand instead (needs Go, the version in `go.mod`, a Postgres with the app schema, a Redis
for the cache and one for the system keys, and the auth hub's JWKS), copy `.env.example`, fill it in,
then:

```bash
cd apps/feed-go
set -a; . ./.env; set +a
go run ./cmd/feed-go
```

Tests run in CI (`feed-go vet + test + build`). Unit tests sit next to the code and need no services
(`internal/testkit` holds the in-memory Redis and `pgx.Rows` fakes); the golden tests compare whole
answers with Node's for fixed inputs (`testdata/golden/`). The integration tier carries the
`integration` build tag and runs only in CI, against a real Redis Cluster and Postgres
(`testdata/integration/schema.sql`); under the tag a missing `FEED_GO_TEST_REDIS_CLUSTER` /
`FEED_GO_TEST_PG_URL` fails the run.

## Config

See `.env.example`. Variable names match the main app's where the value is the same thing. The
`FEED_GO_*` flag mirrors default to ON (`FEED_GO_FRAME_CACHE_NEGATIVE` and `FEED_GO_PRIORITIZED_VERSION_CACHE` to off); set each to its Flipt flag's real value (DESIGN.md §8).
The per-entity cache misses of DESIGN.md §3.1 (and model.getAll's official-models entry, §15.2.2)
are computed with the Node lookup's own query (`FEED_GO_COMPUTE_MISSES`, default on) and written back only for the
caches `FEED_GO_CACHE_WRITEBACK` lists (default none), e.g. `FEED_GO_CACHE_WRITEBACK=metrics,tag-ids`; the names
are the `cache` labels of `feed_go_cache_miss_total` (`user-cosmetics`, `image-frames`, `event-decorations`,
`tag-ids`, `model-frames`, `model-decorations`, `version-images`, `model-data`, `model-tags`,
`official-models`, `metrics`), and an unknown name, the old `true`/`false` included, fails startup. Listing a frame, decoration, `version-images` or
`model-data` cache also needs `DATABASE_URL`, the primary. Each write is counted in
`feed_go_cache_writes_total{cache,result}` (`written` | `nx_lost` | `error`; not per endpoint), and
`FEED_GO_CACHE_WRITE_LOG_PER_MIN` (default 0) logs each written key, rate-limited, never its value
(DESIGN.md §3.1). `FEED_GO_IMAGE_INDEX_FEED` (on by default, as in production) also needs
`FEED_SERVICE_URL`, the image feed service the Node app reads its pages from; without it every request
falls back (`index-feed-unconfigured`). The public `/api/v1/models` routes hand their fallbacks to
`FEED_GO_V1_FALLBACK_URL`, the Node app that serves `/api/v1` (a different upstream from
`FEED_GO_FALLBACK_URL`'s; deployment config, not set here); `FEED_GO_SERVE_V1_MODELS=true` without it
fails startup. The kill is the switch: off, every request there is proxied (DESIGN.md §16.8). Both
routes hand every API credential to the Node app (`bearer-token`); `GET /api/v1/models/{id}` stops
doing so with `FEED_GO_V1_BEARER_AUTH` on (default off; needs `FEED_GO_BEARER_AUTH`): a credential
Node answers with the body any caller gets is computed here, and every other one falls back with
its own reason (DESIGN.md §16.10). The list keeps every API credential a fallback. Credentialed
requests reach this service only once the deployment's routing sends them here: the bypass that
sends them to the Node app is narrowed to the list path (not removed) when `[id]` serves them. The
REST endpoint's shadow also needs
`NEXT_PUBLIC_IMAGE_LOCATION` (the same edge URL prefix the Node app publishes); it builds
`metadata.nextPage` as the production Node app does (`https://<host>`).

Every `feed_go_*` series carries `feed_endpoint` (`as-posts` | `v1-images` | `infinite` |
`model-getall` | `v1-models` | `v1-models-id` | `model-associated`), so parity and CPU per call read per endpoint (DESIGN.md §10, §13, §14, §15). The Node
samplers for `image.getInfinite` and `model.getAll` are their own Flipt flags,
`feed-go-shadow-infinite` and `feed-go-shadow-model-getall` (both default off), sharing
`FEED_GO_SHADOW_URL` and the rate and in-flight knobs with the other routes; `model.getAll`'s own flags
are mirrored by the `FEED_GO_*` variables in `.env.example` (DESIGN.md §15.3). The `feed_endpoint`
label is not called `endpoint` because that is a reserved scrape target label: the scraper's own
`endpoint` would overwrite it.

Traces, exemplars and the fallback log lines are off by default (DESIGN.md §10.3); the compute- and
proxy-error lines log the error's class and type (not its text), capped per minute, and
`feed_go_errors_total{feed_endpoint,mode,class}` counts every error. Tracing
reads the Node app's variables where they mean the same thing — `OTEL_EXPORTER_OTLP_ENDPOINT`
(OTLP/HTTP, `<it>/v1/traces`), `OTEL_SERVICE_NAME` (default `feed-go`), `OTEL_TRACES_SAMPLE_RATIO`
(default 0.1, the same ParentBased trace-id-ratio sampling, so a trace continues browser → feed-go →
Node) — and is switched on by feed-go's own `FEED_GO_OTEL_ENABLED=true`, not the app's
`OTEL_ENABLED` (the shared app config is in feed-go's environment). Set `OTEL_SERVICE_NAME=feed-go`
explicitly on the deployment when enabling it, for the same reason. With tracing on, the fallback
proxy hands feed-go's sampling decision to Node (its `traceparent`), so Node's traces of proxied
requests are capped at min(feed-go ratio, Node ratio): keep feed-go's `OTEL_TRACES_SAMPLE_RATIO` at or
above Node's (normally equal; DESIGN.md §10.3). With it on, `/metrics` serves
OpenMetrics to a scrape that asks, carrying trace-id exemplars on `feed_go_request_duration_seconds`
and `feed_go_shadow_phase_seconds`. `FEED_GO_FALLBACK_LOG_PER_MIN` (default 0) logs one line per
fallback with its reason and safe detail, rate-limited per endpoint and reason;
`FEED_GO_ERROR_LOG_PER_MIN` (default 60) bounds the error lines the same way.
