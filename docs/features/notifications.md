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

**The monolith cannot reach the notification database.** Only `UserNotificationSettings` is in the
main Prisma schema. `Notification`, `UserNotification` and `PendingNotification` live in a
physically separate database reached exclusively by `apps/notifications`, over its own pool
(`NOTIFICATION_DB_URL`). Those env vars are optional in the monolith precisely because it no longer
connects.

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
`utils.notifications.ts` registry. Each defines query preparation, message formatting, and its
category/settings.

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

`src/components/Account/NotificationsCard.tsx`. Settings are stored in `UserNotificationSettings`
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
in `pnpm run test:lint-rules`. Its `KNOWN_INERT` list is empty and pinned, so a new inert type fails
there rather than shipping unmuteable.

## Caching

Unread counts are cached per user in Redis, keyed by category, by
`apps/notifications/src/lib/server/cache.ts`. The monolith's old `notification-cache.ts` was deleted
in the extraction.

## API

tRPC routes in `src/server/routers/notification.router.ts` — three procedures, all scope-gated:

- `getAllByUser` — paginated notifications
- `markRead` — mark as read
- `updateUserSettings` — notification preferences

**Counts do not come from this router.** The unread count is `trpc.user.checkNotifications`.

## Debugging

- **Missing notifications** — check the user's settings opt-out and the dedupe key. Remember create
  is best-effort, so a silent failure is logged, not thrown.
- **Duplicates** — verify `key` generation, and whether `dedupeKey`/`debounceSeconds` are being
  combined.
- **Counts wrong** — the cache is in `apps/notifications`, not this codebase.
- **Nothing fanning out** — the worker is env-gated and defaults off; confirm it's enabled in the
  environment you're looking at before assuming a code bug.
