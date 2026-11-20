import { MY_APPS_HREF } from '~/shared/constants/apps-build.constants';
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
  /** Approve only: the manifest declares a page, so `/apps/run/<slug>` resolves. */
  hasPage?: boolean;
};

/**
 * The rejected notification (and an approved one that has no slug) points the developer at their
 * submissions view — state C of `/apps/build`, which is the table `/apps/mine` used to be.
 * Repointed with the rest of the `/apps/build` consolidation; see the access-narrowing note on
 * `OWNER_SUBMISSIONS_URL` in `./app-listing.notifications`, which applies verbatim here.
 */
const SUBMITTER_SUBMISSIONS_URL = MY_APPS_HREF;

/**
 * The approved app's full-page run route. The run page 404s for an app that declares no page, so
 * only a notification that says `hasPage: true` links there. One without a slug, an app with no
 * page, and an older notification that predates `hasPage` all fall back to the submissions view.
 */
export function approvedAppUrl(details: AppBlockModerationNotificationDetails): string {
  const slug = typeof details.slug === 'string' ? details.slug.trim() : '';
  return slug && details.hasPage === true
    ? `/apps/run/${encodeURIComponent(slug)}`
    : SUBMITTER_SUBMISSIONS_URL;
}

/** `Your app "Name"` when a name is present, else a terse `Your app`. Users know these as apps. */
function appLabel(details: AppBlockModerationNotificationDetails): string {
  const name = details.name?.trim();
  return name ? `Your app "${name}"` : 'Your app';
}

/** Append ": <reason>" only when a non-empty reason is present, else a period. */
function withReason(base: string, reason?: string | null): string {
  const trimmed = reason?.trim();
  return trimmed ? `${base}: ${trimmed}` : `${base}.`;
}

export const appBlockNotifications = createNotificationProcessor({
  'app-block-approved': {
    displayName: 'App approved',
    category: NotificationCategory.System,
    toggleable: false,
    defaultEmail: true,
    prepareMessage: (notification) => {
      const details = notification.details as AppBlockModerationNotificationDetails;
      const url = approvedAppUrl(details);
      return {
        message: `${appLabel(details)} was approved and will be live in a few minutes.`,
        url,
        // Only the run page is "your app"; the submissions-view fallback keeps the default label.
        emailButtonLabel: url === SUBMITTER_SUBMISSIONS_URL ? undefined : 'Open your app',
      };
    },
  },
  'app-block-rejected': {
    displayName: 'App not approved',
    category: NotificationCategory.System,
    toggleable: false,
    defaultEmail: true,
    prepareMessage: (notification) => {
      const details = notification.details as AppBlockModerationNotificationDetails;
      return {
        message: withReason(`${appLabel(details)} was not approved`, details.reason),
        url: SUBMITTER_SUBMISSIONS_URL,
      };
    },
  },
});
