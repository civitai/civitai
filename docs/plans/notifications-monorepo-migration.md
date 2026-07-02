# Plan — Bring the Notification Server into the Monorepo (`apps/notifications/`)

**Date:** 2026-07-01
**Status:** PROPOSAL — not started. Independent of, but informed by, the orchestrator-gateway spin-out
(same `apps/*` strangler-fig playbook; see the `orchestrator-gateway` branch's
`docs/plans/orchestrator-gateway-spinout.md`).
**Target repos:** `civitai/civitai` (monorepo) ← `civitai/notification-server` (external repo, folded in)
+ `datapacket-talos` (deploy).

---

## 1. Summary

Fold the standalone **notification-server** repo into this monorepo as **`apps/notifications/`**, a
peer of `apps/auth/` and `apps/orchestrator-gateway/`, so it consumes the shared `@civitai/*`
packages instead of carrying its own forked copies of the DB/redis/axiom plumbing. In the same
motion, introduce a **`@civitai/notifications`** package that owns the notification **schema** and the
**create logic** (settings-filter + `PendingNotification` upsert), so every producer — the monolith,
the orchestrator gateway, and any future spun-out app — creates notifications through one
implementation rather than a per-app copy.

This is a **domain consolidation**, not just a repo move: today the notification surface is split
three ways — create logic in the monolith, fan-out in the external repo, read/query API back in the
monolith. The target is one app that owns the whole domain.

---

## 2. Why (the concrete motivation)

### 2a. The DB layer is already a maintained fork across the repo boundary

The monolith's notif pool is now a **7-line shim** over the shared package:

```ts
// src/server/db/notifDb.ts
import { getClient, type AugmentedPool } from '@civitai/db/db-helpers';
// ...notifDbWrite = getClient({ instance: 'notification', log })
```

The notification-server's `src/db.ts` (external repo) is a **~150-line hand-maintained fork of that
exact code** — the same `AugmentedPool` type, the same `cancellableQuery`, the same
checked-out-client listener-leak handling and `pg_backend_pid` cancellation logic — re-derived only
because the separate repo cannot import `@civitai/db`. The monolith already did the
"consume the shared helper" refactor; the external server got left behind. Every future fix to that
pooling code has to be applied in two places or they drift. A monorepo app deletes the fork.

The same is true of the server's `redis-client.ts`, `shared.ts` (axiom logging), and `env.ts` — all
re-implementations of what `@civitai/redis`, `@civitai/axiom`, and the shared env plumbing already
provide.

### 2b. Notification "create" logic is duplicated by construction

`createNotification` (monolith, `src/server/services/notification.service.ts`) is the producer path.
It is ~40 lines that **span two databases**:

1. reads `userNotificationSettings` on the **main** DB (`dbRead`) to honor opt-outs, and
2. UPSERTs `PendingNotification` on the **notif** DB (`notifDbWrite`).

Any second producer (e.g. the orchestrator gateway sending `generation-muted`) either duplicates
those 40 lines or reaches back into the monolith. There is **no single shared DB-access layer** to
lean on — the monolith is Prisma + raw-pg (`notifDb`), the spun-out apps are Kysely via
`@civitai/db`. So a naive "shared direct-write helper" doesn't actually centralize anything; it just
relocates the Prisma-vs-Kysely-vs-pg heterogeneity into the helper. The clean fix is to put the write
in the **one process that owns the notif-DB pools** and expose it as an API — which is exactly what an
in-repo notifications app makes natural.

### 2c. Bringing it in-repo dissolves the cross-DB friction

The create endpoint needs to read `userNotificationSettings` (main DB) — which the external
notification-server **cannot reach today** (it only connects to `NOTIFICATION_DB_URL`). As a monorepo
app consuming `@civitai/db`, it has both the main-DB and notif-DB clients available for free. The
blocker evaporates.

---

## 3. Current state — what notification-server is today

A standalone Node/Express service (external repo `civitai/notification-server`). It is a **queue
consumer**, not a write API:

- **`src/app.ts`** — a self-rescheduling poll loop (every ~5s): claims rows from `PendingNotification`
  (`getPending`), fans each out into `Notification` + `UserNotification` rows
  (`handleNormal` / `handleDebounce`), deletes the pending row, then POSTs a realtime signal per
  affected user to `${SIGNALS_ENDPOINT}/users/{userId}/signals/{newNotificationSignal}`.
- **`src/healthcheck.ts`** — the entire HTTP surface: **GET `/health`** and **GET `/pool-stats`**.
  The router hard-codes `Access-Control-Allow-Methods: GET`. **There is no create endpoint.**
- **`src/db.ts`** — the forked `AugmentedPool` / `cancellableQuery` (see §2a).
- **`src/redis-client.ts`, `src/cache.ts`** — `notificationCache` (per-user unread counters).
- **`src/env.ts`** — `NOTIFICATION_DB_URL` / `_REPLICA_URL`, `SIGNALS_ENDPOINT`, `REDIS_URL`,
  `AXIOM_*`, `API_PORT`. No main-DB connection.
- **`src/shared.ts`, `src/constants.ts`, `src/db.sql`** — axiom helpers, signal-type constants, schema.

Producers write to the queue via the DB (the monolith's `createNotification` UPSERT). The
producer↔consumer contract is the **`PendingNotification` table**, not HTTP.

---

## 4. Target architecture

```
                         apps/notifications/   (owns the notification domain)
                         ┌──────────────────────────────────────────────┐
  producers ──create──►  │  (A) Producer API   POST /notifications        │
  (monolith, gateway,    │      authed, internal-only ingress             │
   future apps) via      │      validates CreateNotificationPendingRow    │
   @civitai/notifications │      settings-filter (main DB) + upsert (notif)│
                         │                                                │
                         │  (B) Fan-out worker  (today's poll loop)       │
                         │      PendingNotification → Notification +       │
                         │      UserNotification → signals POST            │
                         │                                                │
                         │  (C) Read API        getUserNotifications, etc. │
                         │      (moved off the monolith tRPC, later)       │
                         └──────────────────────────────────────────────┘
                              consumes @civitai/db /redis /axiom /telemetry

  @civitai/notifications (package)
     - CreateNotificationPendingRow zod schema  ← single source of truth (server validates, callers type)
     - createNotification(data)                 ← the client seam (HTTP wrapper, or direct-write)
     - notification category / signal-type enums
```

- **The app** is the same shape as `apps/auth` / `apps/orchestrator-gateway`: own `package.json`
  (`@civitai/notifications-app`), own multi-stage Dockerfile, `pnpm --filter` build, own Flux app +
  Traefik IngressRoute, own pod pool, built by the shared Tekton `tag-webhook` → `build-and-push`
  pipeline.
- **The package** (`@civitai/notifications`) is the **stable seam**: producers depend only on
  `createNotification(data)` + the shared schema. Whether that function does a direct notif-DB write or
  an HTTP POST to the app, and whether the server is external or in-repo, are all swaps *behind the
  package* that never touch a caller.

### The producer API (A)

A new **authed POST** endpoint. This is net-new surface — today the server is GET-only and unauthed.
It requires:

- **Auth** — a shared secret/token (the existing `WEBHOOK_TOKEN`-style pattern) on an
  **internal-only** (cluster-internal, not public) ingress.
- **Validation** — the `CreateNotificationPendingRow` zod schema from the package.
- **Main-DB read** — for the `userNotificationSettings` opt-out filter (free once in-repo, §2c). Or, for
  `System`-category notices that shouldn't be opt-out-able (e.g. "your account has been muted"), the
  endpoint may skip the filter.

---

## 5. Migration steps (mirror the `apps/auth` / gateway checklist)

**Package first (unblocks producers without the app move):**
1. Create `@civitai/notifications` with the `CreateNotificationPendingRow` schema + category/signal
   enums (moved/shared from the monolith's `notification.schema.ts` and the server's `constants.ts`).
2. Expose `createNotification(data)`. Initial impl can direct-write (monolith parity) OR call the
   endpoint once (A) exists — callers don't care.
3. Point the monolith and the orchestrator gateway at the package.

**App move (separate, sequenced effort):**
4. Scaffold `apps/notifications/` (use the `scaffold-civitai-app` skill; follow
   `docs/packages/new-app-integration.md`). Port `app.ts`'s poll loop; replace `db.ts` with the
   `@civitai/db/db-helpers` shim, `redis-client.ts`/`shared.ts`/`env.ts` with `@civitai/redis` /
   `@civitai/axiom` / shared env.
5. Add the producer API (A) — authed POST, internal ingress, zod validation, main-DB settings read.
6. **Deploy (datapacket-talos):** clone the `civitai-auth` app dir — namespace / deployment (image
   `ghcr.io/civitai/civitai-notifications`) / service / **internal** ingressroute / image trio / hpa /
   pdb / servicemonitor; register the child Kustomization; add the ns to the Kyverno
   deletion-protection policy.
7. **Build CI:** one entry in `tag-webhook.py` `APP_CONFIG`
   (`"notifications": {"dockerfile": "apps/notifications/Dockerfile", ...}`); reload the `tag-webhook`
   pod after merge (it caches `APP_CONFIG` in memory); release via git tag `notifications-vX.Y.Z`.
8. **Lockfile:** run `pnpm install --lockfile-only` and commit `pnpm-lock.yaml` when adding the app
   (CI's frozen install fails otherwise).
9. Cut over the fan-out worker with a soak (and ideally a Flagger canary — this is a production-critical
   path), then decommission the external repo's deploy.

**Read path (C), last / optional:**
10. Move `getUserNotifications` + the notification tRPC read surface off the monolith into the app once
    the write + worker are stable. This is the largest and least urgent piece; do it only if the full
    domain-ownership is worth it.

---

## 6. Risks

| # | Risk | Mitigation |
|---|------|------------|
| R1 | **Production-critical path** — every notification on the site flows through the worker | Soak + Flagger canary on the worker cutover; keep the external repo deployable as instant rollback until soaked |
| R2 | **New authed write surface** on a previously GET-only service | Internal-only ingress + shared token + zod validation; no public exposure |
| R3 | **Two create paths during transition** (monolith direct-write + app endpoint) | Acceptable — the package hides it; converge the monolith onto the package at leisure. Not worse than today |
| R4 | **Cross-DB settings read** in the endpoint | Free once in-repo (`@civitai/db`); or skip the filter for `System`-category notices |
| R5 | **Scope creep into the gateway spin-out** | Explicitly decoupled — see §7. The gateway needs only the package, not the app move |

---

## 7. Relationship to the orchestrator-gateway spin-out

The orchestrator gateway needs to send exactly **one** low-frequency `generation-muted` notification
on auto-mute (the `promptAuditing` mute tail). It must **not** wait on this whole migration.

- **What the gateway needs now:** the `@civitai/notifications` **package** (step 1–3). That is the
  stable seam; everything else here is behind it.
- **What this doc adds beyond that:** the app move + producer API + read-path consolidation — a
  separate, sequenced effort on the notification domain's own timeline.

Keep this migration **out-of-band** from the gateway's P0–P5 plan. It is enabled by the same
monorepo-app pattern, but it is its own project.
