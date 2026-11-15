# feed-go (apps/feed-go)

A Go port of the tRPC procedure `image.getImagesAsPostsInfinite` (the model / Model3D gallery feed)
and, in shadow only, of the tRPC procedure `image.getInfinite` (the flat image feed) and the public
REST endpoint `GET /api/v1/images`, built to measure CPU per
request against the Node path on the same traffic. It answers the request shapes it has ported and
proxies everything else to the Node app unchanged. **Read
[DESIGN.md](DESIGN.md) first** — it covers scope, auth, wire format, routing, shadow comparison, the
measurement plan, the parity gaps and deploy prerequisites.

This is the repo's only Go module. It is not a pnpm workspace member and none of the Node suites or
scripts touch it; its CI is `.github/workflows/feed-go.yml`.

## Endpoints

| Listener | Path | Purpose |
|---|---|---|
| `FEED_GO_ADDR` (`:8080`) | `GET /api/trpc/image.getImagesAsPostsInfinite` | the procedure; only listens when `FEED_GO_FALLBACK_URL` is set |
| `FEED_GO_INTERNAL_ADDR` (`:9090`) | `GET /healthz` | liveness / readiness |
| | `GET /metrics` | Prometheus (`feed_go_*`, Go runtime, process CPU) |
| | `POST /internal/shadow/image.getImagesAsPostsInfinite` | shadow comparison (DESIGN.md §7) |
| | `POST /internal/shadow/api/v1/images` | shadow comparison of the REST endpoint (DESIGN.md §13); never served publicly |
| | `POST /internal/shadow/image.getInfinite` | shadow comparison of `image.getInfinite` (DESIGN.md §14); never served publicly |
| | `GET /debug/pprof/…` | `net/http/pprof`, only with `FEED_GO_PPROF=true` (default off; DESIGN.md §10.2) |

## Run locally

Needs Go (the version in `go.mod`), a Postgres with the app schema, a Redis for the cache and one for
the system keys, and the auth hub's JWKS. Copy `.env.example`, fill it in, then:

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
`FEED_GO_*` flag mirrors default to ON; set each to its Flipt flag's real value (DESIGN.md §8). `FEED_GO_IMAGE_INDEX_FEED` (on by default, as in production) also needs
`FEED_SERVICE_URL`, the image feed service the Node app reads its pages from; without it every request
falls back (`index-feed-unconfigured`). The REST endpoint's shadow also needs
`NEXT_PUBLIC_IMAGE_LOCATION` (the same edge URL prefix the Node app publishes); it builds
`metadata.nextPage` as the production Node app does (`https://<host>`).

Every `feed_go_*` series carries `feed_endpoint` (`as-posts` | `v1-images` | `infinite`), so parity
and CPU per call read per endpoint (DESIGN.md §10, §13, §14). The Node sampler for `image.getInfinite`
is its own Flipt flag, `feed-go-shadow-infinite` (default off), sharing `FEED_GO_SHADOW_URL` and the
rate and in-flight knobs with the other routes. The `feed_endpoint` label is not called `endpoint`
because that is a reserved scrape target label: the scraper's own `endpoint` would overwrite it.
