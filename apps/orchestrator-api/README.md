# @civitai/orchestrator-api

**Status: P0 skeleton.** A standalone Fastify + tRPC-over-HTTP Node service — the target for the
generation slice of the orchestrator subdomain, spun out of the Next.js monolith (strangler-fig).

See the full plan: `datapacket-talos:claudedocs/plan-orchestrator-api-spinout-2026-06-30.md`.

## Why this exists

The `civitai-dp-prod-api` pool is pinned at HPA min 80 as a reliability buffer because bursty **orchestrator
parks** (img2img whatIf/generate source-download hangs) head-of-line-block the *shared* api pool at the
connection layer. Moving `orchestrator.*` generation onto its own pod pool contains a park burst to this
service, so the api pool's tail becomes predictable, its floor can be cut, and a civitai-web node can be
drained (5→4). Success is **isolation + node-drain**, not raw CPU reduction.

## What P0 ships (this skeleton)

- Fastify HTTP server on `:3000`.
- `GET /health` — no-auth liveness+readiness (zero external deps, so a DB/redis blip can't flap the pod).
- `GET /metrics` — Prometheus scrape (prom-client), private-by-`x-forwarded-for` guard (mirrors the auth hub).
- tRPC mounted at `/api/trpc` (fetch adapter) with:
  - `orchestrator.health` — public liveness echo.
  - `orchestrator.ping` — **protected**; verifies the incoming `__Secure-civ-token` / `Bearer` token
    LOCALLY via `@civitai/auth` (ES256/JWKS + injected sysRedis revocation, fail-open) and returns `{ userId }`.
- Wired-but-unused clients (construct + connect-config, no features on them yet): `@civitai/db` (Prisma via
  the shared pooler), `@civitai/redis` (cache + sysRedis), `@civitai/client` (external orchestrator SDK).

## What P0 deliberately does NOT do

- No generation code moved (`workflows.ts`, `orchestration-new.service.ts`, ecosystems) — that's P1/P2.
- No `@civitai/prompt-audit` / `@civitai/generation-graph` carve-outs — next P0 increment, separate PR.
- No live traffic routing — the monolith still serves `/api/trpc/orchestrator`. The same-origin
  `PathPrefix(/api/trpc/orchestrator)` Traefik cutover is P2. In prod this is ClusterIP + ServiceMonitor
  only, reachable via port-forward.

## Layout

```
src/
  server.ts              entrypoint (listen)
  app.ts                 buildServer() factory — /health, /metrics, tRPC mount (testable, no listen)
  trpc/
    context.ts           per-request ctx: local token verify → { claims, userId }
    trpc.ts              initTRPC, publicProcedure, protectedProcedure (auth gate)
    router.ts            appRouter — orchestrator.health (public) + orchestrator.ping (protected)
  lib/server/
    metrics.ts           prom-client registry + counters/histograms
    auth/
      verifier.ts        createAuthVerifier (spoke: JWKS + injected revocation)
      registry.ts        createSessionRegistry (sysRedis revocation read, fail-open no-op fallback)
    clients/
      redis.ts           getRedis / getSysRedis (lazy, memoized)
      db.ts              getDb (lazy dynamic import behind DATABASE_URL guard)
      orchestrator.ts    createOrchestratorClient / getInternalOrchestratorClient
  __tests__/
    health.test.ts       /health 200, /metrics served + XFF-guarded 404
    ping.test.ts         ping rejects unauthenticated (401), returns userId for a valid token (mocked verifier)
```

## Local dev

```bash
cp .env.example .env   # fill secrets for a real run
pnpm --filter @civitai/orchestrator-api dev        # tsx watch
pnpm --filter @civitai/orchestrator-api typecheck  # tsc --noEmit
pnpm --filter @civitai/orchestrator-api test       # vitest
pnpm --filter @civitai/orchestrator-api build      # tsup → dist/server.js
```

## Build / release

Built by the shared Tekton `tag-webhook` → `build-and-push` pipeline (auth is its first user). Push a
git tag `orchestrator-api-vX.Y.Z` on `civitai/civitai` → the webhook matches the prefix in `APP_CONFIG`
(`datapacket-talos:clusters/production/apps/tekton-builds/tag-webhook.py`) → buildkit builds this
`Dockerfile` → pushes `ghcr.io/civitai/civitai-orchestrator-api:X.Y.Z` → Flux ImagePolicy picks it up.
