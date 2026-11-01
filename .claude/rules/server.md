---
paths:
  - "src/server/**"
  - "src/pages/api/**"
---

# Server

## Architecture map (`src/server/`)

The most-edited and largest code in the repo. Read the specific file before changing it; grep within the big ones instead of reading end to end.

- **tRPC API:** `trpc.ts` (root router + procedure helpers), `createContext.ts`, `middleware.trpc.ts`, `routers/` (~100 per-domain), `controllers/`, `schema/` (zod input contracts), `selectors/` (Prisma `select` fragments).
- **Images:** `services/image.service.ts` (8K+ lines, hot feed path: `getInfiniteImages`, `getAllImages`, NSFW/own-content merge). API `src/pages/api/v1/images/index.ts`; index sync `search-index/images.search-index.ts`.
- **Models:** `services/model.service.ts`, `search-index/models.search-index.ts`.
- **Search (Meilisearch):** `meilisearch/client.ts` (tags requests with `X-Search-Actor`), `meilisearch/cleanup.ts`, `search-index/base.search-index.ts` (shared sync engine).
- **Redis / caching:** `redis/client.ts` (incl. sysRedis), `redis/caches.ts` (`createCachedObject` defs + TTLs, e.g. `imageMetaCache`, `tagIdsForImagesCache`), `utils/cache-helpers.ts`.
- **Orchestrator (generation):** `orchestrator/get-orchestrator-token.ts` (`getOrchestratorToken`), `services/orchestrator/orchestrator.service.ts`.
- **Auth:** `auth/get-server-auth-session.ts`, `auth/session-verifier.ts`, `auth/session-cache.ts`, `auth/session-invalidation.ts`, `auth/token-claims.ts`, `auth/civ-cookie.ts`, `auth/oauth-bridge.ts`, `auth/route-guard.ts`, `auth/bearer-token.ts`. Shared logic is in `packages/civitai-auth`; the hub is `apps/auth`.
- **Jobs (cron):** `jobs/job.ts` (runner) + `jobs/*.ts` (e.g. `entity-moderation.ts`, `search-index-sync.ts`). Scheduling: see below.
- **Metrics / analytics:** `metrics/*.metrics.ts` (ClickHouse-backed), `clickhouse/`.
- **DB:** `db/db-helpers.ts` (raw pg-pool config: `connectionTimeoutMillis`, labeled pool gauges), Prisma client. Schema and migration rules: `.claude/rules/database.md`.
- **Telemetry:** `src/instrumentation.node.ts` (OTEL auto-instrumentation + `withSpan()` from `utils/otel-helpers.ts`), `schema/track.schema.ts` (ClickHouse action/event tags), `prom/client.ts`.
- **Health:** `src/pages/api/health.ts` runs sub-checks concurrently, each raced at `HEALTHCHECK_TIMEOUT` and the set raced against an overall deadline, reporting partial results as checks settle. Suppress or demote checks with the `HEALTHCHECK_DISABLED` env var and the Redis-backed `DISABLED_HEALTHCHECKS` / `NON_CRITICAL_HEALTHCHECKS` keys.
- **Other domains:** `games/` (new-order/ratings), `webhooks/`, `paddle/` + `coinbase/` (payments), `notifications/`, `signals/`, `rewards/`; S3 helpers in `src/utils/s3-utils.ts`.

## Scheduling a job

Add the job to the `jobs` array in `src/pages/api/webhooks/run-jobs/[[...run]].ts` with a real cron string in `createJob`. That is the whole registration.

- The cron string is load-bearing. A separate scheduler service reads names and crons from `src/pages/api/internal/get-jobs.ts` and registers a recurring trigger per entry, which calls `run-jobs` back.
- Nothing in this repo reads `Job.cron`, so grepping for a consumer finds none. The infra repo's hand-written Kubernetes CronJobs for specific jobs are exceptions, not the mechanism. Don't add a second scheduling path (another CronJob) for a new job.
- If a job needs a schedule the scheduler cannot express, say why in the job file.
