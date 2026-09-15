# metric-event-watcher → event-engine (monorepo migration)

This directory is the **`metric-event-watcher`** service relocated into the civitai monorepo as
`apps/event-engine` (**renamed** — see below), at its **clean committed HEAD** — none of the in-progress
outbox / delete-side-effects work (the `feat/image-delete-side-effects` branch) is included.

- **Worktree/branch:** `feat/metric-event-watcher-monorepo` (branched off `main`).
- **Source:** `metric-event-watcher` @ HEAD via `git archive` (so no uncommitted local changes came across).
- **event-engine-common:** vendored under `src/common/` at its clean submodule HEAD (`49b0d4f`) — no longer a
  git submodule here. **Not** yet extracted into a shared package (deferred — see below); the standalone
  `event-engine-common` submodule/repo will be examined separately.

## Renamed to `event-engine`
The app now reflects its broader scope (metrics + signals + CDC side effects), not just metrics. **Only the
packaging/deploy-facing name was changed** — dir `apps/event-engine`, package `@civitai/event-engine`, and the
Dockerfile filter/paths. **Runtime identifiers were intentionally left unchanged for continuity:**
- Kafka **consumer group** default `metric-event-watcher` (`src/config/index.ts`, `scripts/reset-consumer-offsets.ts`)
  — so the cutover resumes from existing offsets rather than reprocessing.
- Prometheus **`app` label `metric-event-watcher`** + the **`mew_` metric prefix** (`src/metrics.ts`) — so existing
  dashboards/alerts keep working. (The dashboard that keys on these now lives in the ops repo; the
  legacy `k8s/grafana-dashboard.json` copy has since been deleted — see the note under "Removed".)
- Kafka `clientId` (`src/index.ts`) — cosmetic; left as-is.

Rename these later as a deliberate, separately-planned step (with an offset seed + dashboard update) if desired.

## Approach: lift-and-shift (deliberately minimal)

The goal was a faithful move, not a rewrite. So the app is **self-contained**: its own dependencies, its own
`tsc && tsc-alias` (CommonJS) build, its own `tsconfig.json` (`@/*` path aliases), and EEC vendored in-tree.
It drops into `apps/*` as a pnpm workspace and is auto-discovered — no `pnpm-workspace.yaml` / `turbo.json` /
root changes were needed.

### What changed vs. the standalone repo
- `package.json`: name → `@civitai/event-engine`, `"private": true`; dropped repo-level scripts
  (`sync:submodule`, `install:hooks`, `release*`). Deps/build/tsconfig kept as-is.
- Removed `.gitmodules` (submodule retired → vendored) and `package-lock.json` (npm → the monorepo is pnpm).
- `Dockerfile` rewritten to the monorepo pnpm-deploy pattern (see below) — **DRAFT, unverified**.
- `.github/` is kept **as legacy reference only** (the old CI) and is inert here — GitHub reads workflows
  only from the repo-root `.github/workflows/`, so this nested copy is never scheduled.
- `docker-compose.yml` is **NOT legacy and NOT inert**: it is the live local-dev Kafka/Debezium harness,
  driven by `README.md`, `scripts/produce-comic-event.ts` and `scripts/setup-digitalocean.ts`. Do not
  delete it as legacy.
- `k8s/` **was** kept on the same terms and has since been **DELETED** (2026-09-14). The relocation this
  section called for has happened: the Kafka/Debezium manifests, the Kafka UI and the app's own
  Deployment all live in the ops repo now and are what actually deploys. The copies here deployed
  nothing, were referenced by nothing outside this file, and had begun to read as the live source.

## Outbox reconciliation poller (ported in on top of the lift-and-shift)
A background **OutboxPoller** was ported in — a backstop that drains Outbox rows the live CDC path never
processed (created pre-connector, during downtime, or CDC misses), with retry/park/re-drive. Files:
`src/services/outbox-poller.ts`, wiring in `src/services/event-processor.ts` (`processOutboxRecord` +
start/stop), `OUTBOX_POLL_*`/`OUTBOX_MAX_ATTEMPTS` config, `outboxPollerMetrics` (`mew_outbox_*`), and
`scripts/redrive-outbox.ts` (`pnpm redrive:outbox`).
- **Single-active across autoscaled pods** via a Postgres *two-int* advisory lock
  (`pg_try_advisory_lock(25974, 1)`) — a separate key space from the main app's single-bigint
  `pg_advisory_xact_lock(articleId)`, so it can never collide. Self-healing on pod death; `FOR UPDATE SKIP
  LOCKED` + cursor paging are additional safety.
- **DEFAULT ON (opt-out).** It requires an `attempts` int column on `"Outbox"`, added by
  `packages/civitai-db-schema/prisma/migrations/20260720120000_add_outbox_table/` — which also **models the
  pre-existing Outbox table + `OutboxEntity` enum** in `schema.full.prisma` (they existed in the DB but were
  not in the Prisma schema). **That migration has been applied**, so the poller now runs by default; set
  `OUTBOX_POLL_ENABLED=false` to disable. (Sequence was: apply migration → `pnpm db:generate` to regenerate
  the derived types `models.ts`/`kysely/*` — NOT hand-edited here → poller on.)

## Security
`.env.example` shipped real-looking production credentials in the source repo; they were **scrubbed to
placeholders** here. The underlying Postgres/ClickHouse/Redis credentials were committed upstream — **rotate
them** as an ops follow-up.

## Required before it builds
Run **`pnpm install` at the repo root** once, so `pnpm-lock.yaml` includes this new app. Until then the
Docker `--frozen-lockfile` install and any `pnpm --filter` build will fail. After that,
`pnpm --filter @civitai/event-engine typecheck && ... build` should pass (it builds clean as a
standalone repo today).

## Deferred follow-ups (not done here)
These are intentionally out of scope for the lift-and-shift; they turn it monorepo-*native* and are the
workstreams from `docs/plans/monorepo-migration.md` (in the watcher repo):

1. **Root lockfile** — `pnpm install` to register the app (prerequisite for everything below).
2. **Adopt `@civitai/*` packages** — replace this app's own Redis/ClickHouse/Axiom clients + env with
   `@civitai/redis`, `@civitai/clickhouse`, `@civitai/axiom` (recommend keeping raw `pg` rather than
   `@civitai/db`). Currently it ships its own clients.
3. **Convert build to tsup/ESM** — the siblings (`apps/orchestrator-gateway`, `apps/notifications`) bundle
   with tsup and run ESM. This app is still `tsc`/CJS. Convert when adopting `@civitai/*`.
4. **Retire the submodule properly** — fold `event-engine-common` into a shared `packages/*` workspace
   consumed by BOTH this app and the monolith, then delete the vendored `src/common` here and the monolith's
   root `event-engine-common` submodule. Note the two EEC copies are at **different commits** today
   (this app `49b0d4f`; the monolith submodule `7a0c4b0`) — reconcile before sharing.
5. **ClickHouse version** — `@clickhouse/client` is `1.12` here vs `0.2.2` at the monorepo root; only needs
   reconciling if adopting `@civitai/clickhouse`.
6. **Meilisearch** — keep this app's own client, or factor a `@civitai/meilisearch` package.
7. ~~**DevOps (Zach):** add a Tekton tag-webhook trigger + a `release-app.mjs`/`release:event-engine`
   entry + the k8s Deployment/HPA/secret (port from the legacy `k8s/09-metric-watcher-app.yml`). The
   **Kafka/Debezium k8s infra (`k8s/02-*`, `03-*`) stays as separate infra** regardless.~~ **DONE** —
   the app, the Kafka/Debezium infra and the Kafka UI are all deployed from the ops repo. The legacy
   `k8s/` copies that this item said to port from have been deleted. Still true and still the reason
   the runtime identifiers above were left alone: the app runs on the same Kafka **consumer group**, so
   the cutover did not reprocess or drop offsets.
8. **Node 20 → 22** — the monorepo standard is Node 22; bump `@types/node` and validate when convenient.
9. **Optional rename** — if this becomes the general events/signals/CDC app, rename the package/dir.
