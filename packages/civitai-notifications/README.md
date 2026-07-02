# @civitai/notifications

The **stable seam** for creating notifications. Producers (the monolith, the orchestrator gateway,
future spun-out apps) depend only on this package's schema + `createNotification()` — never on the
notification DB layout or the app's HTTP shape directly. That indirection is what lets the fan-out
server move from the external `notification-server` repo into `apps/notifications/` without touching a
single caller (see [`docs/plans/notifications-monorepo-migration.md`](../../docs/plans/notifications-monorepo-migration.md)).

## What it owns

- **`CreateNotificationPendingRow`** (`./schema`) — the zod contract for a producer payload. The
  `apps/notifications` producer API validates against it; callers type against it. Single source of
  truth, moved out of the monolith's `notification.schema.ts`.
- **Category + signal constants** (`./constants`) — `NotificationCategory` / `notificationCategories`
  and `newNotificationSignal` (`'notification:new'`), shared with the fan-out worker.
- **`createNotificationsClient(config)`** (`./client`) — the client seam. Build one client bound to your
  endpoint/token/retry + failure sink; it validates then POSTs to the app's authed, internal-only API
  (create / bulk / query / count / mark / exists / cleanup). Swapping it for a direct write is a change
  *behind* the client.

## Usage

Build one configured client (in the monolith this lives in `~/server/notifications/client.ts`), then
call its methods:

```ts
import { createNotificationsClient } from '@civitai/notifications';

const notifications = createNotificationsClient({
  endpoint: process.env.NOTIFICATIONS_ENDPOINT, // e.g. http://notifications.civitai-app.svc
  token: process.env.NOTIFICATIONS_TOKEN, // shared secret for the internal ingress
  // Called once per FINAL request failure (after retries) — wire it to your logger for a single event.
  onFailure: (f) => logToAxiom({ name: 'notifications-request-failed', ...f }),
});

await notifications.createNotification({
  key: `new-comment:model:${modelId}`,
  type: 'new-comment',
  category: 'Comment',
  details: { modelId },
  userIds: recipientIds,
  // debounceSeconds: 60, // optional settle window
});
```

`endpoint` / `token` fall back to `NOTIFICATIONS_ENDPOINT` / `NOTIFICATIONS_TOKEN` when omitted. On a
hot path treat delivery as best-effort: the methods throw `NotificationsClientError` on a non-2xx or
transport failure (transient failures are retried with backoff first), so wrap-and-log rather than
letting it break the request.

## Consuming (transpile requirement)

This package ships **raw TypeScript** (`main: ./src/index.ts`). Every consumer's bundler must
transpile it:

- **Next.js** (monolith) — add `'@civitai/notifications'` to `transpilePackages` in `next.config.mjs`.
- **tsup** (apps) — already covered by `noExternal: [/^@civitai\//]`.
