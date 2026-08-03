import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';

/**
 * App Blocks (on-site) — submitter-facing moderation notifications.
 *
 * The ON-SITE App Block publish flow (submit a version → a moderator approves it,
 * which kicks the build/deploy, or rejects it with a reason) previously sent the
 * submitting developer NOTHING — only moderators got a Discord alert on a new
 * submission. These two IMPERATIVE notification types close that gap: they are
 * emitted directly from `approveRequest` / `rejectRequest` (via `createNotification`,
 * behind the `notifyAppBlockSubmitter` helper) POST-COMMIT — NOT from a scheduled
 * `prepareQuery` scan — so they carry NO `prepareQuery`, only a `prepareMessage`
 * (mirrors the off-site app-store-listing imperative notifications, and the
 * auction / challenge imperative types).
 *
 * DISTINCT from the off-site W13 `app-listing-*` types: the on-site App Block flow
 * is a different surface (a per-slug block that builds + deploys to <slug>.civit.ai),
 * so it gets its own copy + type strings rather than reusing the store-listing ones.
 *
 * The `type` strings are free-form (the notifications app stores them as text — no
 * DB enum), so adding these needs NO notifications-DB migration (same as the
 * off-site / auction / challenge imperative types). Registered in
 * `utils.notifications.ts`.
 */

export type AppBlockModerationNotificationDetails = {
  /** The block's public slug (identity + link hint; also serves <slug>.civit.ai). */
  slug: string;
  /** The block display name (best-effort — may be absent for a terse payload). */
  name?: string | null;
  /** The submitted version string (best-effort — for a future per-version deep-link). */
  version?: string | null;
  /** The moderator's rejection reason (reject only; approve carries none). */
  reason?: string | null;
};

/** Both submitter notifications point the developer at their submissions view. */
const SUBMITTER_SUBMISSIONS_URL = '/apps/my-submissions';

/** `Your app block "Name"` when a name is present, else a terse `Your app block`. */
function blockLabel(details: AppBlockModerationNotificationDetails): string {
  const name = details.name?.trim();
  return name ? `Your app block "${name}"` : 'Your app block';
}

/** Append ": <reason>" only when a non-empty reason is present, else a period. */
function withReason(base: string, reason?: string | null): string {
  const trimmed = reason?.trim();
  return trimmed ? `${base}: ${trimmed}` : `${base}.`;
}

export const appBlockNotifications = createNotificationProcessor({
  'app-block-approved': {
    displayName: 'App block approved',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: (notification) => {
      const details = notification.details as AppBlockModerationNotificationDetails;
      return {
        message: `${blockLabel(details)} was approved and is being built and deployed.`,
        url: SUBMITTER_SUBMISSIONS_URL,
      };
    },
  },
  'app-block-rejected': {
    displayName: 'App block not approved',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: (notification) => {
      const details = notification.details as AppBlockModerationNotificationDetails;
      return {
        message: withReason(`${blockLabel(details)} was not approved`, details.reason),
        url: SUBMITTER_SUBMISSIONS_URL,
      };
    },
  },
});
