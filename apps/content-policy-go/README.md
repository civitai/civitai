# content-policy-go

The SFW/NSFW and region decision, in one place: given who is asking (a user id, or none), what the
edge stamped on their request (country, region, `x-isuk`) and the domain color, it answers which
content ratings they may be sent, their browsing level, and whether their region holds them to SFW
content or refuses them. Each caller context keeps its own rules where today's callers disagree.

The contract, the caller contexts and every divergence between today's copies of this logic, the
trust model, caching and how a caller migrates are in [DESIGN.md](DESIGN.md).

```
POST /v1/decide  {"context":"registry-subscription","userId":7,"country":"GB"}
→ {"ratings":["g","pg","pg13"],"unknownRating":false,"browsingLevel":3,"regionHold":"blocked",
   "reason":"region-blocked","context":"registry-subscription","policyVersion":"…","fallback":false}
GET  /healthz  /readyz  /metrics
```

Today it runs in shadow for the registry adapter (`REGISTRY_ADAPTER_POLICY_URL`,
`src/server/registry-adapter/policy-shadow.ts`); no caller's decision comes from it yet.

## Layout

| path                       | what                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------- |
| `cmd/content-policy-go`    | the binary: config, the database pool, the HTTP server                                  |
| `internal/policy`          | the decision: the port of the Node rules, the context rules, `policydata.json`          |
| `internal/users`           | the one user settings read, and its in-process cache                                    |
| `internal/api`             | `POST /v1/decide`, `/healthz`, `/readyz`, `/metrics`; the fail-closed fallback          |
| `internal/config`          | the environment (`.env.example`)                                                        |
| `internal/dbpool`          | feed-go's bounded read-replica pool                                                     |
| `internal/metrics`         | the Prometheus series                                                                   |
| `testdata/golden`          | `gen.ts`, which runs the real Node code, and the `vectors.json` it writes               |
| `ci`                       | the coverage gate and its floors                                                        |

## Develop

```
cd apps/content-policy-go
go test ./...                                   # unit tests, the golden vectors included
CONTENT_POLICY_TEST_PG_URL=postgres://… go test -tags integration -run Integration ./...
```

After a change to the Node rules, from the repo root:

```
pnpm exec tsx --tsconfig tsconfig.json apps/content-policy-go/testdata/golden/gen.ts
pnpm exec tsx scripts/content-policy-go-data.ts
```

then `go test ./...` here says whether the port still agrees. CI checks both generated files on every
PR (`*.schema-drift.test.ts` in lint.yml) and runs this module's gates in
`.github/workflows/content-policy-go.yml`.

## Build and release

```
docker build -f apps/content-policy-go/Dockerfile -t civitai-content-policy-go apps/content-policy-go
pnpm run release:content-policy-go   # bumps package.json and cuts content-policy-go-vX.Y.Z
```

The image listens on 8080 (`CONTENT_POLICY_ADDR`) and needs a database URL; see `.env.example`.
