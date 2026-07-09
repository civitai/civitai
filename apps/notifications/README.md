# apps/notifications

The notification domain, in-repo. Folds the external `civitai/notification-server` repo into the
monorepo as a peer of `apps/auth` / `apps/orchestrator-gateway`, consuming the shared `@civitai/*`
packages instead of its own forked DB/redis/axiom plumbing. See the plan:
[`docs/plans/notifications-monorepo-migration.md`](../../docs/plans/notifications-monorepo-migration.md).

## What it does

One process owns the whole notification write side:

- **(A) Producer API** — `POST /notifications`, authed (shared secret, internal-only ingress).
  Validates the [`@civitai/notifications`](../../packages/civitai-notifications) schema, filters opted-out
  recipients against the **main DB** `UserNotificationSettings` (reachable now that we're in-repo), and
  UPSERTs the `PendingNotification` queue row. This is net-new surface — the external server was
  GET-only.
- **(B) Fan-out worker** — the ported ~5s poll loop. Claims `PendingNotification` rows, fans each into
  `Notification` + `UserNotification` rows (normal / debounced), deletes/reschedules the pending row,
  and POSTs a realtime `notification:new` signal per affected user while bumping the redis unread
  counter.
- **Ops routes** — `GET /health` (no-dep liveness), `GET /pool-stats` (notif pool snapshots),
  `GET /metrics` (Prometheus, private-by-XFF).

The producer↔consumer contract is the `PendingNotification` table, not HTTP — so the monolith's
existing direct writes and this app's producer API can coexist during the transition (plan R3).

## Shape

Node + Fastify + tsup, same as `apps/orchestrator-gateway`. `src/app.ts` is the testable Fastify
factory; `src/server.ts` adds `listen()` + `startWorker()`. Clients are thin shims over the shared
packages (`src/lib/server/clients/{db,redis,axiom}.ts`).

## Dev

```bash
cp .env.example .env      # fill in the DB / redis / signals values
pnpm --filter @civitai/notifications-app dev        # tsx watch (API + worker)
pnpm --filter @civitai/notifications-app typecheck
pnpm --filter @civitai/notifications-app build      # tsup → dist/server.js
pnpm --filter @civitai/notifications-app test
```

Unlike the auth/gateway images, this app imports `@civitai/db`'s Prisma-backed helper, so a Docker
build needs the generated Prisma client — the Dockerfile does a full frozen install so the root
`postinstall` runs `db:generate` (see the Dockerfile header).

## Not done here (follow the plan)

Deploy wiring (datapacket-talos app dir, Tekton `APP_CONFIG` entry, lockfile refresh, worker cutover
soak/canary) and the read-path move (C) are separate, sequenced steps — see §5 of the plan.
