import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';

/**
 * App Store Listings (W13) — owner-facing moderation notifications.
 *
 * The listing owner (an app developer) has no other signal today that a moderator
 * acted on their listing. These IMPERATIVE notification types are
 * emitted directly from the listing/moderation services (via
 * `createNotification`) — NOT from a scheduled `prepareQuery` scan — so they carry
 * NO `prepareQuery`, only a `prepareMessage` (mirrors the auction / challenge
 * imperative notifications). Each carries the acting reason (where a mod supplied
 * one) + a link to the owner's submissions view.
 *
 * The `type` strings are free-form (the notifications app stores them as text — no
 * DB enum), so adding these needs NO notifications-DB migration (same as the
 * auction/challenge imperative types). Registered in `utils.notifications.ts`.
 *
 * DARK: the emitting procs are all behind the App Blocks author/mod flags, so no
 * owner receives one until the App Blocks segment widens.
 */

export type AppListingModerationNotificationDetails = {
  /** The public store slug (identity + link hint). */
  slug: string;
  /** The listing display name (best-effort — may be absent for a terse payload). */
  name?: string | null;
  /** The moderator's rationale, where one was supplied (delist/reset always; approve none). */
  reason?: string | null;
  /** The listing id (`apl_<ULID>`) for a future deep-link. */
  listingId?: string | null;
};

/**
 * Every owner-facing app-listing notification points the owner at their submissions/history view.
 *
 * Exported because `new-app-listing-comment` (in `comment.notifications.ts`) is another such
 * notification and must land on the same page for the same reason: it is an AUTHOR surface,
 * whereas the public detail page gates on `hasAppsStoreAccess` alone and 404s for owners
 * outside it. One constant, so a route rename moves every one of them — which is exactly what
 * just happened.
 *
 * 🔴 REPOINTED `/apps/mine` → `/apps/build` (state C is the same table), AND THAT SLIGHTLY
 * NARROWS WHO CAN OPEN THESE NOTIFICATIONS. Stated rather than left to be discovered, because
 * the old `/apps/mine` header made the OPPOSITE promise explicitly: it gated on
 * `appBlocksAuthor` ONLY, "deliberately NOT on `appBlocks`", so that narrowing STORE access
 * would not hide an author's own apps from them. `/apps/build`'s gate
 * (`canAccessAppsBuild`) requires store access as well as authorship, so an author holding
 * `app-blocks-author` while ALL THREE store flags are off would now get a `notFound` from
 * their own approval notification.
 *
 * 🔴 THAT COHORT IS EMPTY TODAY, AND THE REASON IS A SEGMENT COINCIDENCE RATHER THAN
 * ANYTHING STRUCTURAL — so it is recorded here with the fact that would end it. An earlier
 * draft justified it as "every App-Blocks flag is staged mod-only and a moderator holds all of
 * them"; that is both weaker than the truth and, for the store flags, no longer true.
 *
 * Measured in Flipt v2, environment `civitai-app` (git-backed by `civitai/flipt-state`,
 * `civitai-app/default/features.yaml`): `app-blocks-author`, `app-listings` and
 * `app-blocks-enabled` are ALL base `enabled: false`, widened only by rollout, and all three
 * name the SAME two segments — `moderators` and `app-dev-testers`. So holding
 * `app-blocks-author` implies holding `app-listings`, which is one of the three disjuncts of
 * `hasAppsStoreAccess`. `{isAuthor, no store access}` therefore has no members: an author
 * always clears the store term, and the narrowing above cannot strand anyone.
 *
 * 🔴 WHAT WOULD BREAK IT: widening `app-blocks-author`'s segment set without widening a store
 * flag's — adding a segment there, or dropping one from `app-listings`/`app-blocks-enabled`.
 * The implication is a property of that YAML, not of this code, and nothing in this repo
 * enforces it. It is not hypothetical: `app-listings-public-external` already rolls out to a
 * DIFFERENT segment (`testers`), which is the live proof that these flags can and do diverge.
 *
 * The store term is required because `/apps/build` renders INSIDE the apps-store IA (the
 * `AppsSubNav` chrome, links into `/apps/listing/<id>/edit`), so a viewer with no store has a
 * page whose every onward link 404s; the trade was taken knowingly. If that cohort ever
 * becomes real, the fix is to widen `canAccessAppsBuild`, in ONE place — not to fork this URL.
 *
 * (Deliberately count-free: this comment said "the fifth" and "all five" until
 * `app-listing-purged` made it six, which is the doc-rot a stated total always eventually
 * becomes. The set is enumerable from the object below; the number is not worth maintaining.)
 */
export const OWNER_SUBMISSIONS_URL = '/apps/build';

function appLabel(details: AppListingModerationNotificationDetails): string {
  return details.name ? `"${details.name}"` : 'Your app';
}

/** Append ": <reason>" only when a non-empty reason is present. */
function withReason(base: string, reason?: string | null): string {
  const trimmed = reason?.trim();
  return trimmed ? `${base}: ${trimmed}` : `${base}.`;
}

export const appListingNotifications = createNotificationProcessor({
  'app-listing-approved': {
    displayName: 'App listing approved',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: (notification) => {
      const details = notification.details as AppListingModerationNotificationDetails;
      return {
        message: `${appLabel(details)} was approved and is now live in the app store.`,
        url: OWNER_SUBMISSIONS_URL,
      };
    },
  },
  'app-listing-rejected': {
    displayName: 'App listing not approved',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: (notification) => {
      const details = notification.details as AppListingModerationNotificationDetails;
      return {
        message: withReason(`${appLabel(details)} was not approved`, details.reason),
        url: OWNER_SUBMISSIONS_URL,
      };
    },
  },
  'app-listing-hidden': {
    displayName: 'App listing hidden',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: (notification) => {
      const details = notification.details as AppListingModerationNotificationDetails;
      return {
        message: withReason(
          `${appLabel(details)} was hidden from the app store by a moderator`,
          details.reason
        ),
        url: OWNER_SUBMISSIONS_URL,
      };
    },
  },
  /**
   * A moderator hard-deleted an unapproved store listing (`purgeListing`'s on-site
   * orphan-pre-approval-draft arm). The listing row, its screenshots and its slug are gone —
   * so unlike `hidden` this is not reversible by a relist, and the copy must not imply it is.
   *
   * The owner may already have had `app-block-rejected` for the SUBMISSION; this is about the
   * store listing itself, which is a different object and survived that rejection.
   */
  'app-listing-purged': {
    displayName: 'App listing removed',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: (notification) => {
      const details = notification.details as AppListingModerationNotificationDetails;
      return {
        message: withReason(
          `${appLabel(
            details
          )} store listing was removed by a moderator, and its store address is no longer reserved`,
          details.reason
        ),
        url: OWNER_SUBMISSIONS_URL,
      };
    },
  },
  'app-listing-reset-to-pending': {
    displayName: 'App listing needs re-review',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: (notification) => {
      const details = notification.details as AppListingModerationNotificationDetails;
      return {
        message: withReason(
          `${appLabel(details)} was sent back for another review by a moderator`,
          details.reason
        ),
        url: OWNER_SUBMISSIONS_URL,
      };
    },
  },
});
