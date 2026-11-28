# beacon-go (apps/beacon-go)

A Go service for the browser beacons `POST /api/internal/ping` (page views),
`POST /api/internal/pulse` (entity views) and `POST /api/track/batch` (search and action telemetry,
behind `BEACON_GO_TRACK_BATCH_SERVE`; other batches fall back whole): the same responses and the same
tracker rows as the Node handlers, without the Node framework overhead per request. **Read [DESIGN.md](DESIGN.md) first** — it
is the contract (what each endpoint answers and writes), what is reproduced and what falls back, the
two modes and the shadow comparison.

It is a Go module of its own; it is not a pnpm workspace member and none of the Node suites see it.
Its CI is `.github/workflows/beacon-go.yml`.

## Endpoints

| Listener | Path | Purpose |
|---|---|---|
| `BEACON_GO_ADDR` (`:8080`) | `/api/internal/ping`, `/api/internal/pulse`, `/api/track/batch` | the beacons; only listens with `BEACON_GO_MODE=serve`; `/api/track/batch` is proxied to Node unless `BEACON_GO_TRACK_BATCH_SERVE=true` |
| `BEACON_GO_INTERNAL_ADDR` (`:9090`) | `GET /healthz` | liveness / readiness |
| | `GET /metrics` | Prometheus (`beacon_go_*`, Go runtime, process) |
| | `POST /internal/shadow/api/internal/ping`, `.../pulse`, `/internal/shadow/api/track/batch` | shadow comparison (DESIGN.md §4) |

## Run locally

Needs Go (the version in `go.mod`), a Redis for the cache and one for the system keys, and the auth
hub's JWKS. Copy `.env.example`, fill it in, then:

```bash
cd apps/beacon-go
set -a; . ./.env; set +a
go run ./cmd/beacon-go
```

Tests run in CI (`beacon-go vet + test + build`); they need no services. The golden fixtures
(`testdata/golden/`) are generated from the Node code by `testdata/golden/gen.ts`.

## Release

`pnpm run release:beacon-go` bumps `package.json` and cuts a `beacon-go-vX.Y.Z` tag
(`scripts/release-app.mjs`), which the tag webhook builds into an image.
