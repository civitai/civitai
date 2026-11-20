---
paths:
  - 'src/server/**'
  - 'src/pages/api/**'
---

# Server

## Architecture map (`src/server/`)

The most-edited and largest code in the repo. Read the specific file before changing it; grep within the big ones instead of reading end to end.

- **tRPC API:** `trpc.ts` (root router + procedure helpers), `createContext.ts`, `middleware.trpc.ts`, `routers/` (~100 per-domain), `controllers/`, `schema/` (zod input contracts), `selectors/` (Prisma `select` fragments).
- **Images:** `services/image.service.ts` (8K+ lines, hot feed path: `getInfiniteImages`, `getAllImages`, NSFW/own-content merge). API `src/pages/api/v1/images/index.ts`; image search is the semantic search (`services/semantic-image-search.service.ts`).
- **Models:** `services/model.service.ts`, `search-index/models.search-index.ts`.
- **Search (Meilisearch):** `meilisearch/client.ts`, `meilisearch/cleanup.ts`, `search-index/base.search-index.ts` (shared sync engine).
- **Cache:** `redis` from `redis/client.ts` (keys in `REDIS_KEYS`) via `createCachedObject` (defs + TTLs in `redis/caches.ts`, e.g. `imageMetaCache`, `tagIdsForImagesCache`) or `fetchThroughCache` (`utils/cache-helpers.ts`). Always set a TTL.
- **Durable state:** `sysRedis` (keys in `REDIS_SYS_KEYS`) is not a cache. It holds existing durable state (revocations, idempotency markers, spend reservations, ledgers, job and game state). New durable data goes in Postgres (`dbKV`, or `getJobDate` for a job cursor). A new `REDIS_SYS_KEYS` entry needs explicit sign-off and an entry in `packages/civitai-redis/src/__tests__/sys-key-ledger.test.ts`; sitting next to an existing sys key is not a reason.
- **Orchestrator (generation):** `orchestrator/get-orchestrator-token.ts` (`getOrchestratorToken`), `services/orchestrator/orchestrator.service.ts`.
- **Auth:** `auth/get-server-auth-session.ts`, `auth/session-verifier.ts`, `auth/session-cache.ts`, `auth/session-invalidation.ts`, `auth/token-claims.ts`, `auth/civ-cookie.ts`, `auth/oauth-bridge.ts`, `auth/route-guard.ts`, `auth/bearer-token.ts`. Shared logic is in `packages/civitai-auth`; the hub is `apps/auth`.
- **Jobs (cron):** `jobs/job.ts` (runner) + `jobs/*.ts` (e.g. `entity-moderation.ts`, `search-index-sync.ts`). Scheduling: see below.
- **Metrics / analytics:** `metrics/*.metrics.ts` (ClickHouse-backed), `clickhouse/`.
- **DB:** which client to use is in the table below; `db/db-helpers.ts` holds the raw pg-pool config (`connectionTimeoutMillis`, labeled pool gauges). Schema and migration rules: `.claude/rules/database.md`.
- **Telemetry:** `src/instrumentation.node.ts` (OTEL auto-instrumentation + `withSpan()` from `utils/otel-helpers.ts`), `schema/track.schema.ts` (ClickHouse action/event tags), `prom/client.ts`.
- **Health:** `src/pages/api/health.ts` runs sub-checks concurrently, each raced at `HEALTHCHECK_TIMEOUT` and the set raced against an overall deadline, reporting partial results as checks settle. Suppress or demote checks with the `HEALTHCHECK_DISABLED` env var and the Redis-backed `DISABLED_HEALTHCHECKS` / `NON_CRITICAL_HEALTHCHECKS` keys.
- **Other domains:** `games/` (new-order/ratings), `webhooks/`, `paddle/` + `coinbase/` (payments), `notifications/`, `signals/`, `rewards/`; S3 in the main app goes through `src/utils/s3-utils.ts` (clients from `src/utils/s3-client-factory.ts`). `@civitai/storage` is the HTTP client for the storage service, not an S3 wrapper.

## Use X for Y

The shared helper for each recurring need. When the nearest existing code does it another way, follow
this table, not the nearby example.

| Need                    | Use                                                                                                                                                               | Not                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Outbound HTTP           | `outboundFetch` / `fetchTimeoutSignal` (`utils/fetch-timeout.ts`); `safeFetch` (`utils/safe-fetch.ts`) for user-supplied URLs                                     | `AbortSignal.timeout`, a `fetch` with no deadline                                                |
| Rate limit              | tRPC: `.use(rateLimit(...))` (`middleware.trpc.ts`); outside tRPC: `claimRateLimitAttempt` (`utils/rate-limit-bucket.ts`), the same engine                        | a hand-written `INCR` + `EXPIRE` window                                                          |
| Lock                    | `withDistributedLock` (`utils/distributed-lock.ts`)                                                                                                               | a hand-written `SET NX`                                                                          |
| Cache                   | `createCachedObject` / `fetchThroughCache` on `redis`, with a TTL; `createTtlMemo` (`utils/ttl-memoize.ts`) only for a global value with a stated staleness bound | `sysRedis`, a module-scope `Map`                                                                 |
| DB read                 | `dbRead` / `kyselyRead`; read-after-write: `getDbWithoutLag` / `getKyselyWithoutLag` (`db/db-lag-helpers.ts`)                                                     | `dbWrite` for a plain read, unless commented `// primary: <reason>`                              |
| New query               | Kysely (`kyselyRead` / `kyselyWrite`) or `@civitai/db-queries`; Prisma ORM for simple CRUD                                                                        | a new `$queryRaw` / `$executeRaw`; raw SQL goes in `@civitai/db-queries` as a Kysely `sql` query |
| REST error (`/api/v1`)  | `restErrorBody` (`utils/rest-error-envelope.ts`)                                                                                                                  | `res.status(4xx).json({ error })`                                                                |
| Retry / backoff / sleep | `withRetries`, `sleep`, `abortableSleep` (`~/utils/errorHandling`); `backoffDelay` (`~/utils/backoff`)                                                            | an inline `setTimeout` promise, a hand-written `2 ** attempt`                                    |
| Logging                 | `logToAxiom` with `safeError(e)` (`~/server/logging/client`); it does not reject when ingest fails, so it needs no `.catch`                                       | `console.*` in services and jobs                                                                 |
| Env                     | `import { env } from '~/env/server'`                                                                                                                              | `process.env` (outside instrumentation, bootstrap and client-reachable modules)                  |
| Feature flag (server)   | add the key to `FLIPT_FEATURE_FLAGS`; read it with `isFlipt` / `isFliptSync` (`flipt/client.ts`)                                                                  | a server read of a key from anywhere but `FLIPT_FEATURE_FLAGS`                                   |
| Page-based pagination   | `getPagination` / `getPagingData` (`utils/pagination-helpers.ts`)                                                                                                 | hand-computed `skip` / `take` and totals                                                         |
| Moderator REST route    | `defineModeratorEndpoint` (`utils/moderator-endpoint.ts`); the file goes in `src/server/api-routes/mod/`, then `pnpm run generate:api-routes` (`docs/dev/api-routes.md`) | `ModEndpoint`                                                                                    |
| Client IP               | `resolveClientIp` (`utils/client-ip.ts`)                                                                                                                          | parsing forwarding headers yourself                                                              |

`feature-flags.service.ts` stays the client-exposed availability layer, and it is in the client bundle:
never import `flipt/client` there as a value (it pulls `~/env/server` into the client build, which typecheck
and tests do not catch). A flag there that is also read on the server takes its key from a client-safe
constant in `~/shared/constants/`, as `knightsApp` does with `KNIGHTS_APP_FLIPT_FLAG`, and its
`FLIPT_FEATURE_FLAGS` member carries a comment naming that constant.

## Scheduling a job

Add the job to the `jobs` array in `src/pages/api/webhooks/run-jobs/[[...run]].ts` with a real cron string in `createJob`. That is the whole registration.

- The cron string is load-bearing. A separate scheduler service reads names and crons from `src/pages/api/internal/get-jobs.ts` and registers a recurring trigger per entry, which calls `run-jobs` back.
- Nothing in this repo reads `Job.cron`, so grepping for a consumer finds none. The infra repo's hand-written Kubernetes CronJobs for specific jobs are exceptions, not the mechanism. Don't add a second scheduling path (another CronJob) for a new job.
- If a job needs a schedule the scheduler cannot express, say why in the job file.
