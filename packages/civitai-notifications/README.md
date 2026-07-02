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
- **`createNotification(data, config)`** (`./client`) — the client seam. Today it validates then POSTs
  to the app's authed, internal-only producer API. Swapping it for a direct write is a change *behind*
  this function.

## Usage

```ts
import { createNotification } from '@civitai/notifications';

await createNotification(
  {
    key: `new-comment:model:${modelId}`,
    type: 'new-comment',
    category: 'Comment',
    details: { modelId },
    userIds: recipientIds,
    // debounceSeconds: 60, // optional settle window
  },
  {
    endpoint: process.env.NOTIFICATIONS_ENDPOINT, // e.g. http://notifications.civitai-app.svc
    token: process.env.NOTIFICATIONS_TOKEN, // shared secret for the internal ingress
  }
);
```

`endpoint` / `token` fall back to `NOTIFICATIONS_ENDPOINT` / `NOTIFICATIONS_TOKEN` when omitted. On a
hot path treat creation as best-effort: `createNotification` throws `CreateNotificationError` on a
non-2xx or transport failure, so wrap-and-log rather than letting it break the request.

## Consuming (transpile requirement)

This package ships **raw TypeScript** (`main: ./src/index.ts`). Every consumer's bundler must
transpile it:

- **Next.js** (monolith) — add `'@civitai/notifications'` to `transpilePackages` in `next.config.mjs`.
- **tsup** (apps) — already covered by `noExternal: [/^@civitai\//]`.
