# Notifications System

How notifications are produced, fanned out, read and displayed.

## Where things live

The notification domain was moved out of the monolith (and out of the old external
`notification-server` repo) into an in-repo app plus a shared package. Three places now split the
work, and "which of the three owns this?" is the first question to answer for any change:

| Location | Owns |
|---|---|
| `apps/notifications/` | The notification database (sole owner), the settings opt-out filter on the single-row create path (the bulk path does not filter — see User settings), the fan-out poll worker, the read/count/mark queries, the per-user unread cache, and signal emission |
| `packages/civitai-notifications/` | The zod contracts, `NotificationCategory` and the signal constants, and the HTTP client — the single source of truth shared by every producer |
| `src/server/notifications/` | Only the per-feature **processors** (`prepareQuery`/`prepareMessage`), the `detail-fetchers/` main-DB enrichment, and the configured client instance in `client.ts` |

The external `notification-server` repo is retired.

## Database

**The monolith cannot reach the notification database.** Only `UserNotificationSettings` and the
web-push tables (`PushSubscription`, `UserPushSetting`) are in the main Prisma schema.
`Notification`, `UserNotification` and `PendingNotification` live in a physically separate database
reached exclusively by `apps/notifications`, over its own pool (`NOTIFICATION_DB_URL`). Those env
vars are optional in the monolith precisely because it no longer connects.

If you need notification rows, add an endpoint to `apps/notifications` — do not add a Prisma model.

### Key fields

- `type` — notification type (e.g. `model-download-milestone`)
- `category` — grouping, see below
- `details` — JSON payload
- `key` — dedupe identifier
- `dedupeKey` / `debounceSeconds` — first-class since the extraction; a cross-schema refine forbids
  combining them

## Categories

Defined once in `packages/civitai-notifications/src/constants.ts` and re-exported from
`src/server/common/enums.ts`. It is a `const` tuple plus a derived union, **not** a TypeScript
`enum`, so import it rather than restating the members — the list has grown before and will again.

## Processors

Processors live in `src/server/notifications/*.notifications.ts`, are built with
`createNotificationProcessor()` from `base.notifications.ts`, and are collected in the
`utils.notifications.ts` registry. Each defines query preparation, message formatting, and its category/settings. An optional `section` groups a type under its own heading in the settings UI instead of its category's (the Knights of New Order types); the notification itself keeps its `category`.

The registry is large and covers far more than the obvious feature areas — read it rather than
assuming a notification type doesn't exist yet.

Processors marked **"Moveable"** are ones that could become on-demand creation instead of job-based.
Only genuinely time-based notifications — milestones, hourly/daily aggregations — need to stay in
the `send-notifications` job.

## Creating a notification

`createNotification()` in `src/server/services/notification.service.ts` is still the entry point,
but its contract changed with the extraction: it is now an **HTTP call to `apps/notifications` that
never throws on transport failure**. Client errors are swallowed and logged centrally.

That means a caller cannot treat a successful return as proof the notification was stored, and
must not put it inside a transaction expecting rollback semantics. The same applies to
`markNotificationsRead`.

## Client

| Component | Responsibility |
|---|---|
| `NotificationBell.tsx` | Unread indicator; opens the drawer; hides on notification pages |
| `NotificationsDrawer.tsx` | Mantine `Drawer` shell only — delegates to `NotificationsComposed` |
| `NotificationsComposed.tsx` | The real behavior: infinite scroll, category filtering, mark-as-read |
| `NotificationList.tsx` | Presentational render only; takes an `onItemClick` prop |

Changes to list behavior almost always belong in `NotificationsComposed.tsx`, not in the drawer or
the list.

Realtime delivery is via Signals — the fan-out worker POSTs per affected user, and
`notifications.utils.ts` subscribes.

## User settings

`src/components/Account/NotificationsCard.tsx` (legacy page) and
`src/components/Account/NotificationsPane.tsx` (the `accountSettingsV2` pane) — **both**, until the
flag is retired. Settings are stored in `UserNotificationSettings`
(the one table still in the main schema); a row means opted **out**, except for `optIn` types — see
`NotificationProcessor.optIn` in `base.notifications.ts`.

**Only the single-row producer path filters on them.** `createNotification`
(`apps/notifications/src/lib/server/create.ts`) drops opted-out recipients before queueing.
`createNotificationsBulk` (`operations.ts`) — the path every `send-notifications` processor takes —
receives pre-resolved recipients and applies **no** filter. So a job-based processor must write its
own clause:

```sql
WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = <recipient> AND type = '<type>')
```

Omit it and the toggle renders, saves, and does nothing.
`src/server/notifications/__tests__/notification-settings-polarity.test.ts` is the guard, and it runs
in `pnpm run test:lint-rules`. Its file lists name `NotificationsCard.tsx` only — the
`accountSettingsV2` pane is not yet covered. Its `KNOWN_INERT` list is empty and pinned, so a new inert type fails
there rather than shipping unmuteable.

An `optIn` type inverts this: a row means subscribed, and the processor's `prepareQuery` must derive
recipients by joining `UserNotificationSettings` (the polarity test checks it). An `externalProducer`
type is the exception: another app (today `apps/knights`, `/api/jobs/notify`) picks the recipients
itself, applies the settings rows with the polarity the type declares (the Knights types are opt-out:
default on for players who joined, a row turns one off) and sends through the bulk path. The processor
has **no** `prepareQuery`; a query there would run a second recipient derivation, and
`createNotification` must never be called for the type (a guard test scans for it).

## Knights of New Order daily notifications

`apps/knights` sends three `externalProducer` types (`knights-verdicts-in` > `knights-streak-ends-soon` > `knights-new-images`, settings section "Knights of New Order") from `POST /api/jobs/notify` (`Authorization: Bearer $JOBS_TOKEN`; schedule at least hourly so the streak warning goes out within the hour of `streakWarningHourUtc`). Code: `apps/knights/src/lib/server/notify`; table `KnightsNotificationSend` (migration `20261217120000_knights_v2_notify`, applied by hand before the job first runs); env `NOTIFICATIONS_ENDPOINT` / `NOTIFICATIONS_TOKEN`.

- A player gets the best type they are eligible for and have not turned off, at most one per UTC day. Eligibility and ordering: `planNotifications` in `notify.service.ts`; thresholds in `notify/config.ts`.
- Recipients: players who joined the game (a `NewOrderPlayer` row) and are not blocked (see below), minus those with a `UserNotificationSettings` row for the type (a row means off), who can open the app today: moderators, or the access flag evaluated locally with `{ id, isModerator }` only (`accessibleIds`), so a rule on tier, membership or early-adopter status can differ from sign-in.
- Turned everything off: the settings page writes a row only for each type that exists then, so a player is judged against the types that existed at their latest change. Silenced means a row for every opt-out type whose first-seen time (earliest `disabledAt` of any row for it) is at or before their own latest row. The main app lists those types at `GET /api/mod/knights/notification-types` (`x-webhook-token`; cached an hour in the process, as `UserNotificationSettings` has no index on `type`); the job fetches it at the start of each run, and if it cannot be read or is empty the run sends nothing (`skipped`, route 500). A type added later does not undo an earlier silencing. The settings page shows the master switch on for such a user when a type is new, as for every new opt-out type.
- Sending: a send claims the player's `(playerId, day)` row first, then sends through the bulk path (which does no settings lookup) with `retries: 0`. A refused batch (4xx) gives its claims back; an unknown outcome (timeout, network, 5xx, any error not known to precede the send) keeps them and ends the run, so a retry can never send a second notification that day; a 429 releases its claims and also ends the run. A claim is `confirmedAt` only once the app accepted the send; an unconfirmed claim holds its day but does not count as having told the player about verdicts. A run with `NOTIFICATIONS_*` unset claims nothing and answers 500, as does one with a failed confirmation (`confirmFailed`). A crash between claim and send loses that player's day and never double-sends. The batch key is derived from the day, kind and sorted player ids. Messages are the same for everyone in a batch.

## Caching

Unread counts are cached per user in Redis, keyed by category, by
`apps/notifications/src/lib/server/cache.ts`. The monolith's old `notification-cache.ts` was deleted
in the extraction.

## API

tRPC routes in `src/server/routers/notification.router.ts` — all scope-gated:

- `getAllByUser` — paginated notifications
- `markRead` — mark as read
- `updateUserSettings` — notification preferences
- `getPushSettings` / `updatePushSettings` — per-type web-push rows
- `subscribePush` / `unsubscribePush` — browser push subscription lifecycle
- `getEmailSettings` / `updateEmailSettings` — per-type email opt-outs

**Counts do not come from this router.** The unread count is `trpc.user.checkNotifications`.

## Web push

**Full doc: [web-push.md](web-push.md)** — architecture, invariants, per-task change map, and an
agent-executable local setup runbook. Summary:

Push is a third state on the per-type control (Off / On / Push), stored in two main-DB tables:
`PushSubscription` (one row per live browser subscription) and `UserPushSetting`, where **a row
means push ON and absence means no push — for every type, always**. Do not add an `enabled`
column or a `pushEnabled` column on `UserNotificationSettings`; the opt-out table's 40+ bare
`NOT EXISTS` clauses would read such a row as a mute.

- The processors that set `defaultPush: true` (`DEFAULT_PUSH_TYPES` in
  `src/server/notifications/push.constants.ts` is derived from them) are **materialized** into
  `UserPushSetting` rows on a user's first subscription. Changing a flag only reaches new
  subscribers — existing subscribers keep the rows they were granted with, deliberately (a new
  default for them needs a hand-run backfill, see web-push.md).
- The dispatcher is `apps/notifications/src/worker/push.ts`, called from the fan-out poll loop
  after the opt-out filter, so a type set Off never pushes. It renders title/body/url via the
  monolith's `POST /api/internal/notifications/render-push` (the processor registry lives there),
  enforces a per-user daily cap in Redis (`system:push-quota:<userId>:<day>`, then one summary
  push), and owns subscription rows: 404/410 deletes, 10 consecutive failures deletes.
- The service worker (`public/sw.js`) is push-only — **no fetch handler, ever**.
- Configured via VAPID env: `NEXT_PUBLIC_VAPID_PUBLIC_KEY` in the monolith and the matching
  private key in `apps/notifications` (see its `.env.example`). Unset = the push UI never renders
  and the dispatcher no-ops.
- Stale subscriptions (no successful delivery in 180 days) are reaped weekly by
  `push-subscription-cleanup`.

## Email

Only types whose processor sets `defaultEmail` send email (today: the nine `service-deal-*`
Creator Services notifications), and for those email is ON unless the user opts out.
`UserEmailNotificationOptOut` holds the opt-outs: **a row means email OFF**. The settings control
shows an Email checkbox for those types only, unavailable while the type itself is Off.

- The fan-out worker (`apps/notifications/src/worker/email.ts`) runs beside push, on the users a
  notification was newly delivered to, so a repeated key sends nothing. It gates on
  `emailNotificationTypes` in `@civitai/notifications`, which
  `notification-email-types.test.ts` pins to the processors with `defaultEmail`. Change both together.
- The monolith's `POST /api/internal/notifications/send-email` (`notification-email.service.ts`)
  renders, filters recipients, caps (20 per user per day, 500 per type per hour, nothing sent if
  Redis is down) and sends with a one-click `List-Unsubscribe` link
  (`/api/notifications/email-unsubscribe`; GET only shows a confirm button).
- **Off until switched on:** the `KeyValue` row `notification-email-enabled` must hold JSON `true`.
  Delete it (or set `false`) to stop all notification email within a minute, no deploy needed.

## Debugging

- **Missing notifications** — check the user's settings opt-out and the dedupe key. Remember create
  is best-effort, so a silent failure is logged, not thrown.
- **Duplicates** — verify `key` generation, and whether `dedupeKey`/`debounceSeconds` are being
  combined.
- **Counts wrong** — the cache is in `apps/notifications`, not this codebase.
- **Nothing fanning out** — the worker is env-gated and defaults off; confirm it's enabled in the
  environment you're looking at before assuming a code bug.
