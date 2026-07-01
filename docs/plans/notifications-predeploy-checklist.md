# Pre-Deploy Checklist — Notifications Monorepo Migration

**Status:** the code is merged/branch-ready and verified (typecheck, 28 unit tests, two code reviews,
a live smoke of the producer + read path scoped to user 5). It is **NOT** safe to deploy as a single
step. This is a **hard cutover**: the monolith no longer touches the notification DB — every notification
path routes through `@civitai/notifications` → HTTP → `apps/notifications`. Deploying the monolith before
the app is running and reachable breaks notifications **site-wide** (reads throw → the bell errors for all
users; writes are swallowed → notifications silently stop).

Work top-to-bottom. Do not skip the ordering — each phase gates the next.

---

## 0. Gaps to close BEFORE any deploy (code changes not yet done)

- [ ] **Add a `WORKER_ENABLED` env gate** to `apps/notifications/src/server.ts`. Today `startWorker()`
      runs unconditionally, so deploying the app = its poll-loop runs. During the soak the **external
      notification-server is still the fan-out worker**, and two workers on the same `PendingNotification`
      queue → double fan-out + duplicate signals to every user. The app must be deployable **API-only**.
      (Default the gate OFF; flip it ON only at the worker-cutover step.)
- [ ] **(Decide) monolith fallback.** As written there is no direct-DB fallback — the monolith depends
      entirely on the app. If you want the monolith to be able to deploy/rollback *independently*, add a
      flag so `createNotification`/reads fall back to a direct notif-DB path when the app is unreachable
      (this is what migration-plan R3 — "two paths during transition" — actually envisioned, and would
      mean **not** deleting `notifDb.ts` yet). Skip only if you accept the strict deploy ordering below.
- [ ] **Deploy wiring** (migration plan §5 steps 6–8), none of which is in this branch:
  - [ ] datapacket-talos app dir cloned from `civitai-auth` — namespace / deployment
        (image `ghcr.io/civitai/civitai-notifications`) / service / **internal** IngressRoute / image trio /
        hpa / pdb / servicemonitor; register the child Kustomization; add ns to the Kyverno deletion-
        protection policy.
  - [ ] Tekton `tag-webhook.py` `APP_CONFIG` entry
        (`"notifications": {"dockerfile": "apps/notifications/Dockerfile", ...}`); reload the `tag-webhook`
        pod after merge (it caches `APP_CONFIG` in memory).
  - [ ] `pnpm install --lockfile-only` committed (done in this branch — re-verify CI's frozen install).

---

## 1. Secrets / config (both sides)

- [ ] **App** SOPS secret populated (see `apps/notifications/.env.example`): `NOTIFICATION_DB_URL` +
      `NOTIFICATION_DB_REPLICA_URL` (same pooler as the external server), `DATABASE_URL` +
      `DATABASE_REPLICA_URL` (main-DB read for the opt-out filter), `REDIS_URL` + `REDIS_SYS_URL`
      (**both or neither**), `SIGNALS_ENDPOINT`, `AXIOM_*`, and **`NOTIFICATIONS_TOKEN`** (the shared
      secret — non-empty in prod, or the producer API is wide open).
- [ ] **Monolith** prod env has `NOTIFICATIONS_ENDPOINT` (internal cluster URL of the app) +
      `NOTIFICATIONS_TOKEN` (**same value** as the app). `NOTIFICATIONS_ENDPOINT` is `z.url()`-required in
      prod, so the monolith will **fail to boot** without it — that fail-fast is intentional; confirm it's
      set before shipping the monolith.
- [ ] The app's redis (`REDIS_URL`) is the **same cache cluster** the rest of prod uses. The unread-count
      cache (`system:notification-counts:{userId}`) is shared with producers; a divergent redis silently
      desyncs the badge. (This exact mismatch was observed in the local smoke test.)

---

## 2. Deploy the app — WORKER OFF (API-only soak)

- [ ] Build + deploy `apps/notifications` with `WORKER_ENABLED=false`.
- [ ] `GET /health` returns `{status:"ok"}`; `GET /pool-stats` shows the notif pools connected.
- [ ] `GET /metrics` is reachable **only** in-cluster (public request with `x-forwarded-for` → 404).
- [ ] Producer API auth works: a POST with the correct `Authorization: Bearer <token>` is accepted; a
      wrong/absent token → 401.
- [ ] The **external notification-server is still running and remains the fan-out worker.**

---

## 3. Deploy the monolith cutover

- [ ] Monolith boots (proves `NOTIFICATIONS_ENDPOINT`/`_TOKEN` are set).
- [ ] Producer path: trigger a real notification (e.g. a comment) → confirm a `PendingNotification` row is
      written **via the app** and the **external worker** fans it out → the recipient sees it.
- [ ] Read path: the notification bell loads for real users (`getUserNotifications`), unread counts render
      (`getUserNotificationCount`), mark-read works (`markNotificationsRead`).
- [ ] Producers that bypassed `createNotification` are exercised: `send-notifications` cron (bulk),
      club membership change, reaction milestone (`notificationExists` dedup).
- [ ] Watch Axiom `notifications` datastream + the monolith error rate. **Soak** (hours → a day).

---

## 4. Cut the fan-out worker over (the R1 danger step)

> Production-critical. NEVER run both workers at once — they double-process the queue.

- [ ] Flagger canary if available.
- [ ] **Atomically**: turn the external notification-server worker **OFF**, then flip the app's
      `WORKER_ENABLED=true` **ON**. (Order: off-then-on, with a brief gap is safer than any overlap.)
- [ ] Confirm exactly one consumer: `PendingNotification` rows drain, `Notification`/`UserNotification`
      rows are created once, one signal per affected user (no duplicates).
- [ ] Verify debounce + normal fan-out both work; check `notifications_worker_*` metrics + pool saturation.

---

## 5. Rollback plan (keep ready until soaked)

- [ ] **App worker misbehaves:** set `WORKER_ENABLED=false` on the app and re-enable the external
      notification-server worker (instant). Keep the external repo **deployable** until fully soaked.
- [ ] **App unreachable / producer+read broken:** if a monolith fallback was added (§0), it degrades to
      direct notif-DB; if not, roll the **monolith** back to the pre-cutover image (the app + external
      worker keep running).
- [ ] **DB-layer regression:** note this branch also refactored `@civitai/db` `getClient`
      (`createPool`/`createClients`) and `db-lag-helpers` — these touch **every** monolith pg pool and all
      lag routing, not just notifications. A rollback of the monolith image reverts them together.

---

## 6. Post-cutover cleanup (after soak)

- [ ] Decommission the external `notification-server` deploy.
- [ ] Remove the now-unused `NOTIFICATION_DB_URL`/`_REPLICA_URL` from the monolith env (already optional in
      schema).
- [ ] If a monolith fallback was added for the transition, remove it (delete `notifDb.ts` + the direct
      path) to reach true full domain ownership.

---

## Verification already done (for reference)

- `pnpm typecheck` (monolith) + `pnpm --filter @civitai/notifications-app typecheck` — clean.
- 28 unit tests green: `@civitai/db` lag tracker (5), app auth/routes/SQL-param-indexing (14),
  `@civitai/notifications` client hydration + bulk chunking (9).
- Two independent code reviews — no critical/high findings.
- Live smoke (scoped to user 5, prod): create → external-worker fan-out → `exists` flips false→true →
  query (base rows, `createdAt` hydrated to `Date`) → count → scoped mark-read. All passed.
- **Not** verified live: the app's own `poll-loop.ts` fan-out (can't run a second worker against the prod
  queue safely) — this is the piece the soak/canary in §4 must cover.
