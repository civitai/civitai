# Web Push Notifications

How browser push works here: architecture, the invariants that must not move, what to change for
common tasks, and a runbook that takes a fresh checkout to a delivered OS notification.

Origin: ClickUp 868m637gh. Sibling doc: [notifications.md](notifications.md) (the in-app system
push rides on).

## Architecture in one pass

A notification reaches a device like this:

```
producer → apps/notifications POST /notifications     (opt-out filter, queue row)
         → fan-out worker poll loop                    (PendingNotification → UserNotification)
         → push dispatcher (worker/push.ts)            (per fanned row, after DB commit)
             ├─ target query: affected users ∩ UserPushSetting(type) ⋈ PushSubscription
             ├─ daily cap:    redis system:push-quota:<userId>:<YYYY-MM-DD>
             ├─ render:       POST main-app /api/internal/notifications/render-push
             └─ web-push:     VAPID-signed, RFC 8291-encrypted → browser vendor's push service
         → public/sw.js `push` handler → OS notification → `notificationclick` → deep link
```

| Piece              | Where                                                                          | Notes                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `PushSubscription` | main DB                                                                        | one row per browser; `endpoint` unique; `userAgent` for the device list                                 |
| `UserPushSetting`  | main DB                                                                        | PK `(userId, type)`; **row = push ON, absence = no push**                                               |
| Dispatcher         | `apps/notifications/src/worker/push.ts`                                        | called from `run()` in `poll-loop.ts`, never throws                                                     |
| Render endpoint    | `src/pages/api/internal/notifications/render-push.ts`                          | `WEBHOOK_TOKEN`-gated; the processor registry (`prepareMessage`) only exists in the monolith            |
| Service worker     | `public/sw.js`                                                                 | `push`, `notificationclick`, `pushsubscriptionchange` — nothing else                                    |
| Client state       | `src/components/Notifications/usePushSubscription.ts`                          | the only caller of subscribe/unsubscribe; reads and writes the store below                              |
| Browser push state | `src/store/push-subscription.store.ts`                                         | module-level singleton — permission/subscribed/endpoint/busy, shared by all five mounting components    |
| UI                 | `PushSoftAsk`, `PushDeviceToggle`, `PushDeviceList`, `NotificationTypeControl` | rendered by BOTH `NotificationsCard` (legacy) and `NotificationsPane` (accountSettingsV2)               |
| tRPC               | `notification.router.ts`                                                       | `subscribePush` / `unsubscribePush` / `getPushSubscriptions` / `getPushSettings` / `updatePushSettings` |
| SW re-subscribe    | `src/pages/api/push/resubscribe.ts`                                            | session-authed REST — a SW can't speak tRPC                                                             |
| Cleanup            | `src/server/jobs/push-subscription-cleanup.ts`                                 | weekly; no successful delivery in 180 days                                                              |
| Metrics            | `notifications_push_delivery_total{outcome}`                                   | `accepted` = push service took it — **not** that a user saw it                                          |

Delivery response table (dispatcher, pinned by `worker/push.test.ts`): 404/410 → delete the row
(normal churn, not an incident) · 429 → keep the row, drop the send · 413 → log + retry truncated ·
5xx/network → failure streak, delete at 10 consecutive (see invariant 9 — this was inert until
2026-09-24) · 201 → `lastSuccessAt = now()`, streak reset.

## Invariants — do not move these

1. **`UserPushSetting` has one polarity: row = on, absence = off, for every type, forever.** Never
   add an `enabled` column, and never touch `UserNotificationSettings` for push — its ~40 bare
   `NOT EXISTS` clauses would read any push row there as a mute. History: that polarity has already
   produced a production bug once (see `notification-settings-polarity.test.ts`).
2. **The service worker gets no fetch handler.** A caching SW on a Next.js app can serve stale
   HTML/JS to every visitor and keeps running after the fix ships. Push only.
3. **Default push types are materialized, not implied.** `DEFAULT_PUSH_TYPES`
   (`src/server/notifications/push.constants.ts`) is inserted as rows in the same transaction as a
   user's first subscription — and only while they hold zero subscriptions. Editing the list reaches
   **new subscribers only**; that is deliberate (silently pushing a new type to existing users is
   how permission grants get revoked). `push-defaults.test.ts` pins every entry to a real,
   toggleable, non-opt-in processor.
4. **The VAPID keypair couples the two apps.** `NEXT_PUBLIC_VAPID_PUBLIC_KEY` (monolith) and
   `VAPID_PRIVATE_KEY` (worker) must be halves of one pair — a subscription minted under key A is
   forever undeliverable by key B. Rotating the pair strands every existing subscription.
5. **The server list is the truth about a browser's subscription.** `usePushSubscription` computes
   `active` by checking the browser's endpoint against `getPushSubscriptions`; the browser alone
   can hold an orphaned subscription (failed subscribe call, device revoked elsewhere) and will
   happily report "on" while nothing delivers.
6. **A type set Off never pushes even if a stale `UserPushSetting` row exists** — the dispatcher
   receives the recipient list _after_ the opt-out filter. Don't "optimize" the dispatcher onto a
   pre-filter list.
7. **Registration only happens inside `enable()`** (and `PushRegistrationManager` only calls
   `update()` on an already-existing registration). Never register a SW on page load.
8. **On resubscribe, the upsert runs BEFORE the old endpoint is reaped.** `upsertPushSubscription`
   materializes `DEFAULT_PUSH_TYPES` only while the user holds zero subscriptions, so deleting
   first makes a rotating browser that held exactly one subscription look brand new and silently
   re-creates every type the user had turned off — the failure invariant 3 exists to prevent,
   reached by a different route. The ordering is asserted in
   `src/server/__tests__/push-resubscribe-endpoint.test.ts`; nothing about the handler reads as
   order-dependent, which is exactly why it is pinned.
9. **The failure-streak reap is TWO statements and must stay that way.** A data-modifying CTE
   cannot delete the row its own `UPDATE` just modified — sub-statements share one snapshot and one
   command id, so Postgres skips it and reports `DELETE 0`. It was one statement until
   2026-09-24 and the ceiling therefore never reaped anything.

## What to change, per task

- **Add a default push type** → append to `DEFAULT_PUSH_TYPES`; the guard test validates it.
  Remember invariant 3: existing subscribers do not get it.
- **Change the daily cap** → `PUSH_DAILY_CAP` env on the worker (default 20; anything that is not a
  non-negative integer falls back to that default rather than disabling push). Past the cap: exactly
  one summary push, then silence until the UTC day rolls. No redis → cap fails open (send).
- **Change payload contents** → three places move together: the render endpoint (what's produced),
  `worker/push.ts` `PushPayload` (what's sent), `public/sw.js` (what's displayed). The SW ships via
  browser SW-update semantics, so old SWs will receive new payloads — keep fields optional.
- **New surface showing push controls** → compose the existing pieces (`NotificationTypeControl`,
  `PushSoftAsk`, `PushDeviceToggle`, `PushDeviceList`); they own the transition logic and the
  server-reconciled state. Don't re-derive Off/On/Push from raw queries.
- **iOS work** → the mechanism already works for installed PWAs (iOS 16.4+): `needs-standalone`
  detection shows the Add-to-Home-Screen card, manifest is `display: standalone`, apple-touch-icon
  is set. What's missing is install-prompting UX, deliberately deferred.

## Runbook: fresh checkout → delivered notification

Everything no-ops safely while unset, so these steps can be done in any order; delivery needs all
of them. Prereqs: repo dev setup working (dev server, signed-in user), node per `.nvmrc`.

### 1. Keys

```bash
npx web-push generate-vapid-keys
```

### 2. Main app

- Add `NEXT_PUBLIC_VAPID_PUBLIC_KEY=<public key>` to the root `.env`.
  ⚠️ Put it in `.env`, not `.env.development` — the dev-server daemon injects `.env` into the
  child's environment and real env beats dotenv. `NEXT_PUBLIC_*` is inlined at server start, so
  **restart the dev server** after adding it.
- Apply `packages/civitai-db-schema/prisma/migrations/20260921120000_web_push/migration.sql` to the
  database your `DATABASE_URL` points at (manually — this repo never auto-applies migrations), then
  `pnpm run db:generate` and restart the dev server again (the running process caches the old
  Prisma client and will throw "unknown field" on the new columns).

**Client-only verification** (no worker needed): sign in → notification settings (`/user/account`
or the settings pane) → soft-ask card → Enable → grant. Expect: one `PushSubscription` row with
`userAgent` set, the four `DEFAULT_PUSH_TYPES` rows in `UserPushSetting`, per-type controls now
three-state, and a device list showing "This device". Then send a push straight at the row:

```bash
npx web-push send-notification \
  --endpoint="<PushSubscription.endpoint>" --key="<p256dh>" --auth="<auth>" \
  --vapid-pubkey="<public>" --vapid-pvtkey="<private>" --vapid-subject="mailto:dev@civitai.com" \
  --payload='{"title":"Test","body":"Hello","url":"/user/notifications"}'
```

`localhost` counts as a secure context in Chrome — no HTTPS needed on desktop. A phone hitting your
dev box over LAN is NOT exempt; test mobile against a deployed environment.

### 3. Worker (full pipeline)

```bash
docker compose -f docker-compose.base.yml up -d notification-db   # DDL ships in the image, port 15434
cd apps/notifications && cp .env.example .env
```

Set in `apps/notifications/.env`:

| Key                                      | Value                                                                                                                                                                                         |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                                   | `3010` (default 3000 collides with the main app)                                                                                                                                              |
| `WORKER_ENABLED`                         | `true` — safe locally; it polls only your local queue                                                                                                                                         |
| `NOTIFICATION_DB_URL` (+`_REPLICA_URL`)  | `postgres://postgres:postgres@localhost:15434/postgres`                                                                                                                                       |
| `NOTIFICATION_DB_SSL`                    | `disable` — the compose container has no SSL and `@civitai/db` forces `sslmode=no-verify` otherwise; every create then fails, **swallowed**, as "The server does not support SSL connections" |
| `DATABASE_URL` / `DATABASE_REPLICA_URL`  | same values as the root `.env` (push tables + opt-out filter live in the main DB)                                                                                                             |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | the pair from step 1 — public half must equal `NEXT_PUBLIC_VAPID_PUBLIC_KEY`                                                                                                                  |
| `MAIN_APP_URL`                           | `http://localhost:3000`                                                                                                                                                                       |
| `MAIN_APP_WEBHOOK_TOKEN`                 | the root `.env`'s `WEBHOOK_TOKEN`                                                                                                                                                             |
| `NOTIFICATIONS_TOKEN`                    | empty (disables producer auth; dev only)                                                                                                                                                      |

🔴 **Run the built bundle, not `tsx watch`:**

```bash
pnpm --filter @civitai/notifications-app build
node --env-file=apps/notifications/.env apps/notifications/dist/server.js
```

The `dev` script (`tsx watch`) currently fails at boot with
`The requested module '@civitai/db' does not provide an export named 'createClients'` on node 20
**and** 24: the workspace `@civitai/*` packages have no `"type": "module"`, so tsx compiles them as
CJS and their named ESM exports vanish. Production never sees this because tsup bundles them
(`noExternal: [/^@civitai\//]`). Expect the same in `apps/orchestrator-gateway`.

Verify boot: `curl localhost:3010/health` → `{"status":"ok"}` and the log line
`notifications fan-out worker started`.

### 4. End-to-end injection

The recipient must hold a `UserPushSetting` row for the type (the defaults from step 2 include
`new-mention`). Vary `key` per send — repeats dedupe silently.

```bash
curl -X POST http://localhost:3010/notifications -H 'Content-Type: application/json' -d '{
  "type": "new-mention", "key": "new-mention:e2e-1", "category": "Comment", "userId": <id>,
  "details": {"version": 2, "mentionedIn": "description", "username": "tester",
              "modelName": "Test Model", "modelId": 1}}'
```

Expect: `{"status":"queued","queued":1}` → within ~5s an OS notification titled "New @mentions" →
`notifications_push_delivery_total{outcome="accepted"} 1` on `localhost:3010/metrics` →
`lastSuccessAt` freshly stamped on the subscription row.

**`queued: 0` means a swallowed failure or a filtered recipient** — create is best-effort by
contract. Read the worker log; the SSL misconfiguration above is the most likely cause, an opt-out
row for that type the second.

Expected noise: a `fetch failed` logged per fan-out is the fire-and-forget signals POST when no
signals service runs locally. Harmless, and unrelated to push.

## Debugging a push that "sent" but never showed

A 201 means the push service accepted it — nothing more. The gap to the screen, in the order it
usually resolves on desktop Linux:

1. **OS tray** — GNOME/KDE often deliver Chrome notifications silently into the notification drawer
   with no banner. Check there first, then per-app banner settings and Do-Not-Disturb.
2. **DevTools → Application → Service Workers** — `sw.js` should be "activated and running". The
   **Push** button there fires a synthetic push locally, splitting display problems from FCM
   problems in one click.
3. **`chrome://settings/content/notifications`** — the origin must be in Allow.

Also: toggling the device off and on re-materializes defaults if it was the user's only
subscription (by design — the "no other subscription" rule), and a revoked remote device keeps
showing "on" in its own UI until it next loads settings and reconciles.

## Production env (names only — values live in the infra repo's sealed secrets)

Monolith: `NEXT_PUBLIC_VAPID_PUBLIC_KEY`. Worker: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
`VAPID_SUBJECT`, `MAIN_APP_URL`, `MAIN_APP_WEBHOOK_TOKEN`, optional `PUSH_DAILY_CAP`.
`NOTIFICATION_DB_SSL` is a local-dev knob — never set it in production.

Push code no-ops until its side's variables are set, so code can deploy ahead of keys — with one
exception on the worker: once the VAPID pair, `MAIN_APP_URL` and `MAIN_APP_WEBHOOK_TOKEN` are all
set, `DATABASE_URL` becomes REQUIRED and `assertRequiredEnv()` throws at boot without it. That is
deliberate (bookkeeping writes go to the main DB and every one of them is best-effort, so a missing
URL would otherwise be invisible), but it means the worker's keys and its `DATABASE_URL` must land
together.

⚠️ The monolith's half is **build-time**: `NEXT_PUBLIC_VAPID_PUBLIC_KEY` is inlined by Next into the
client bundle, so setting it only in the runtime environment does nothing — it has to be present
when the image is built, and a rebuild is required to change it.
