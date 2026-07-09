# Notifications Migration — Post-Review Action Items

Consolidated from five review passes (3 broad: correctness/parity, prod-safety/ops, architecture/types;
2 focused on the lag helpers: parity+call-sites, design+edges). No **critical** findings; the migration
is a faithful port. Items below are hardening + deploy work. Companion to
[`notifications-predeploy-checklist.md`](./notifications-predeploy-checklist.md).

## Already applied (this session)
- [x] **H1** — auth can't be silently open in prod: app `assertRequiredEnv()` fails-fast on empty
      `NOTIFICATIONS_TOKEN` in prod (`apps/notifications/src/{env,server}.ts`); monolith schema makes
      `NOTIFICATIONS_TOKEN` `isProd`-required (`src/env/server-schema.ts`).
- [x] **H2** — boot-time validation of required connection strings (`NOTIFICATION_DB_URL`,
      `DATABASE_REPLICA_URL`) so a misconfigured pod fails startup instead of passing `/health` and
      erroring every request.
- [x] **`WORKER_ENABLED` gate** — the fan-out worker runs only when explicitly enabled.

## Recommended code fixes

- [x] **L1 — `NaN` lag delay guard** (`packages/civitai-db/src/lag.ts`). Now gated on
      `Number.isFinite(delaySeconds) && delaySeconds > 0`, so a non-numeric `REPLICATION_LAG_DELAY`
      disables routing instead of writing `{ EX: NaN }`. Protects both consumers.
- [x] **L2 — don't cache a `null` store** (`packages/civitai-db/src/lag.ts`). `getStore()` now memoizes
      only a non-null resolution; a thunk that returns null (store not ready) is retried on a later call.
- [x] **L6 — DB-scoped lag key for the notif flag**. App now uses `lag-helper:notif:{userId}`
      (`apps/notifications/src/lib/server/lag.ts`) — namespaced to the notif DB, can't collide with the
      monolith's main-DB flags. Removed the now-dead `'notification'` member from the monolith's
      `LaggingType` (`src/server/db/db-lag-helpers.ts`) so the collision class can't reappear.
- [x] **Lag tests** (`packages/civitai-db/src/lag.test.ts`): added `NaN`-delay (pins L1) and
      null-thunk-then-ready (pins L2). Suite now 7 tests.
- [x] **Client resilience — bounded backoff retry** (`packages/civitai-notifications/src/client.ts`).
      `post()` now retries transient failures (transport/timeout/5xx/429) with exponential backoff + jitter
      (default 2 retries → 3 attempts, base 200ms, capped 2s); 4xx (bad payload / auth) throws immediately.
      All ops are idempotent so retry is safe. Confirmed every monolith call site `await`s the package call
      (so the retry completes + errors are handled). +3 client tests. **Also:** the monolith's
      `markNotificationsRead` now catches+logs (best-effort) so a transient app outage — after the retries —
      can't surface as a tRPC error to the optimistic UI (restores the original fire-and-forget semantics).
      Chose retry over a redis outbox (would re-create a queue in front of the app's queue).
- [ ] **L4 — mark-read shouldn't fail on a lag-flag write error** (`apps/notifications/src/lib/server/operations.ts`).
      `preventReplicationLag` is `await`ed after the DB write; a redis blip there logs a *succeeded* mark-read
      as `nonTransientError`. `.catch(() => null)` it, matching the adjacent fire-and-forget cache calls.
      (Parity with the monolith — latent there too — so optional.)
- [ ] **L5 — document `REPLICATION_LAG_DELAY`** in `apps/notifications/.env.example` (defaults off; note
      that off means a post-mark-read count can read the stale replica within the lag window). Decide
      whether prod should match the monolith's value.

## Deploy-time / procedural (tracked in the pre-deploy checklist — not code)
- [ ] Deploy **ordering** (app healthy first, then monolith) is enforced only by the doc — needs per-phase
      operator sign-off.
- [ ] Verify the **internal-only IngressRoute** (datapacket-talos) and that the **readiness probe exercises
      a dependency** (not just the dependency-free `/health`), so a broken-DB pod doesn't report Ready.
- [ ] **Soak** the monolith cutover watching pg **pool-acquire latency + saturation** and lag routing —
      the `getClient`/`createLagTracker` refactors touch every monolith pool + all lag routing (parity
      verified, but whole-site blast radius).
- [ ] Run `clean-up-old-notifications` with a **conservative `before`** first — it's now one batched app
      call rather than the old date-chunked loop.
- [ ] The larger deploy wiring (datapacket-talos app dir, Tekton `APP_CONFIG`) — see pre-deploy §0.

## Reviewed & accepted — no action
- `club.service` `ON CONFLICT DO NOTHING` → `DO UPDATE`: intended, safer direction; club keys are
  UUID-unique so collisions are effectively impossible.
- **L3** — `isWritePool` identity check disables the count cache in single-DB setups: faithful to the
  monolith's prior single-client behavior; prod uses distinct read/write URLs so the cache works. Only
  dev/preview single-DB is affected.
- Cosmetic: client discards the `{ queued }` response; `/pool-stats` unauthenticated (trivial, behind
  internal ingress); Dockerfile pnpm pin vs `packageManager` cross-check; `{ EX }` deprecated in redis
  5.8.3 (works, structurally valid).
