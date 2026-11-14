# feed-go (apps/feed-go)

A Go port of the tRPC procedure `image.getImagesAsPostsInfinite` (the model / Model3D gallery feed),
built to measure CPU per request against the Node path on the same traffic. It answers the request
shapes it has ported and proxies everything else to the Node app unchanged. **Read
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

## Run locally

Needs Go (the version in `go.mod`), a Postgres with the app schema, a Redis for the cache and one for
the system keys, and the auth hub's JWKS. Copy `.env.example`, fill it in, then:

```bash
cd apps/feed-go
set -a; . ./.env; set +a
go run ./cmd/feed-go
```

Tests run in CI (`feed-go vet + test + build`). Unit tests sit next to the code and need no services.

## Config

See `.env.example`. Variable names match the main app's where the value is the same thing. The
`FEED_GO_*` flag mirrors default to ON; set each to its Flipt flag's real value (DESIGN.md §8). `FEED_GO_IMAGE_INDEX_FEED` (on by default, as in production) also needs
`FEED_SERVICE_URL`, the image feed service the Node app reads its pages from; without it every request
falls back (`index-feed-unconfigured`).
