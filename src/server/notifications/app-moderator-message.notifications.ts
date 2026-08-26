import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';
import { OWNER_SUBMISSIONS_URL } from '~/server/notifications/app-listing.notifications';

/**
 * App Store Listings — the MODERATOR-INITIATED, FREE-TEXT message to an app's owner.
 *
 * 🔴 HOW THIS DIFFERS FROM THE OTHER ELEVEN APP NOTIFICATIONS, and why it needed a
 * twelfth type rather than a reused one. All eleven existing app types
 * (`app-block-*`, `app-listing-*`, `app-collaborator-*`, `app-ownership-transfer-*`)
 * are EVENT-TRIGGERED with FIXED copy: a state transition happened, and
 * `prepareMessage` renders a sentence the platform wrote. Four of them additionally
 * splice a moderator-supplied `reason` into that fixed sentence — but the sentence,
 * and therefore the SUBJECT of the message, is chosen by the code path, not by the
 * moderator. There was no way for a moderator to say a thing the platform has no
 * event for ("your listing claims it asks before spending; it does not"), which left
 * the only routes as editing a third party's app or contacting them off-platform.
 *
 * This type carries the moderator's own SUBJECT and BODY and renders them verbatim.
 *
 * 🔴 IT IS NOT AN INBOX, AND THE COPY SAYS SO. A notification is one-way — there is
 * no thread, no reply affordance, and nothing on the recipient's side that would
 * route a reply anywhere. Leaving that implicit would strand a developer who WANTS to
 * answer ("we shipped the estimate last week"), so {@link MODERATION_REPLY_URL} is
 * appended to every rendered message. If a real two-way channel is ever built, this
 * clause is the thing to delete — deliberately part of the string rather than a
 * separate optional field, so it cannot be forgotten on one code path.
 *
 * 🔴 THE ACTING MODERATOR IS NOT NAMED TO THE RECIPIENT. Attribution lives in
 * `AppListingModerationEvent.actorUserId` (durable, mod-visible, survives an account
 * delete), which is where accountability belongs. Naming the individual on the wire
 * would make "who delisted my app" answerable by a developer, which is a retaliation
 * vector the rest of the moderation surface already declines to open: `delistListing`
 * / `rejectRequest` both carry the mod's REASON to the user and never the mod's
 * identity. This type matches that posture rather than inventing a second one.
 *
 * Imperative like its siblings: emitted directly via `createNotification`, so NO
 * `prepareQuery` and no notifications-DB migration (`type` is free-form text).
 * Registered in `utils.notifications.ts`.
 *
 * DARK on arrival: the only emitter is a `moderatorProcedure`, so nothing reaches a
 * developer until a moderator sends one.
 */

export type AppModeratorMessageNotificationDetails = {
  /**
   * The public store slug — the app's identity in the rendered message.
   *
   * 🔴 THE SLUG, NOT THE DISPLAY NAME, and that is a decision rather than an
   * omission. The sibling families carry `name` with a `'Your app'` fallback because
   * they are emitted from paths that already hold the row. Here the recipient may own
   * several apps, so a terse fallback is genuinely ambiguous — and one of the two
   * listings that motivated this feature has an ENTIRELY EMPTY listing, i.e. a null
   * name, which is precisely the case where a fallback would fire. The slug is NOT
   * NULL, is the app's public identity (`<slug>.civit.ai`), and is already resolved
   * by the owner lookup — so it identifies the app in every case at no extra read.
   */
  slug: string;
  /** The PARENT listing id (`apl_<ULID>`) for a future deep-link. */
  listingId?: string | null;
  /** The moderator's free-text subject line. Rendered VERBATIM. */
  subject: string;
  /** The moderator's free-text body. Rendered VERBATIM. */
  body: string;
};

/**
 * Where a recipient who wants to answer should actually go.
 *
 * A bare path would be ambiguous inside a sentence that already contains a slug and a
 * quoted app name, so this is written host-first. It is TEXT, not the notification's
 * `url` — that stays {@link OWNER_SUBMISSIONS_URL}, because the developer's first move
 * on a message about their listing is to open the listing.
 */
export const MODERATION_REPLY_URL = 'civitai.com/support';

/** `your app "<slug>"`. */
function appLabel(details: AppModeratorMessageNotificationDetails): string {
  return `your app "${details.slug}"`;
}

export const appModeratorMessageNotifications = createNotificationProcessor({
  'app-moderator-message': {
    displayName: 'Message from Civitai moderation',
    category: NotificationCategory.System,
    // Not toggleable, for the same reason the moderation-decision types are not: a
    // developer must not be able to opt out of being told their app has a problem.
    toggleable: false,
    prepareMessage: (notification) => {
      const details = notification.details as AppModeratorMessageNotificationDetails;
      return {
        message:
          `Civitai moderation sent you a message about ${appLabel(details)} — ` +
          `${details.subject}: ${details.body} ` +
          `(Replies to this notification are not delivered; contact the team at ${MODERATION_REPLY_URL}.)`,
        url: OWNER_SUBMISSIONS_URL,
      };
    },
  },
});
