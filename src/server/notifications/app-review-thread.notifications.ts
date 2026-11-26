import { NotificationCategory } from '~/server/common/enums';
import {
  APP_REVIEW_TEAM_NAME,
  type AppReviewActor,
} from '~/server/notifications/app-review-attribution';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';
import {
  reviewThreadDeveloperUrl,
  reviewThreadModeratorUrl,
} from '~/shared/utils/app-review-thread';

/**
 * The reply thread on an app review decision: a new message notifies the other side, on-site and
 * by email, with a link to the thread. Imperative (emitted by `postReviewMessage` after the
 * message is stored, keyed by message id), so no `prepareQuery` and no notifications-DB migration.
 *
 * `app-review-reply-to-moderator` goes to the moderator who decided the request. A reply that
 * nobody individual can take is not notified at all: it waits in the queue's Replies tab.
 * `app-review-reply-to-developer` goes to the developer side and names the moderator who wrote it
 * ("From @name, Civitai App Review"), resolved at read time by `appReviewReplyDetailFetcher`.
 */

export type AppReviewReplyNotificationDetails = {
  /** The request id (`pubreq_…` / `alpr_…`) the thread hangs on. */
  subjectId: string;
  slug: string;
  name?: string | null;
  /** The message, trimmed to one line (`reviewReplyExcerpt`). */
  excerpt: string;
  /** To-developer only: the moderator who wrote it. Resolved into `actor` at read time. */
  authorUserId?: number | null;
  /** Filled by `appReviewReplyDetailFetcher`; never stored. */
  actor?: AppReviewActor | null;
};

function appName(details: AppReviewReplyNotificationDetails): string {
  const name = typeof details.name === 'string' ? details.name.trim() : '';
  return name || details.slug;
}

/** "From @name, Civitai App Review", or "From Civitai App Review" once the account is gone. */
export function appReviewReplyByline(details: AppReviewReplyNotificationDetails): string {
  const actor = details.actor;
  const username = typeof actor?.username === 'string' ? actor.username.trim() : '';
  if (username && !actor?.deletedAt) return `From @${username}, ${APP_REVIEW_TEAM_NAME}`;
  return `From ${APP_REVIEW_TEAM_NAME}`;
}

export const appReviewThreadNotifications = createNotificationProcessor({
  'app-review-reply-to-moderator': {
    displayName: 'Developer replied to your app review',
    category: NotificationCategory.System,
    toggleable: false,
    defaultEmail: true,
    prepareMessage: (notification) => {
      const details = notification.details as AppReviewReplyNotificationDetails;
      return {
        message: `A developer replied about your review of "${appName(details)}": ${
          details.excerpt
        }`,
        url: reviewThreadModeratorUrl(details.subjectId),
        emailButtonLabel: 'Open the conversation',
      };
    },
  },
  'app-review-reply-to-developer': {
    displayName: 'Reply from Civitai App Review',
    category: NotificationCategory.System,
    toggleable: false,
    defaultEmail: true,
    prepareMessage: (notification) => {
      const details = notification.details as AppReviewReplyNotificationDetails;
      return {
        message: `${APP_REVIEW_TEAM_NAME} replied about "${appName(details)}": ${details.excerpt}`,
        url: reviewThreadDeveloperUrl(details.subjectId),
        emailButtonLabel: 'Open the conversation',
        byline: appReviewReplyByline(details),
      };
    },
  },
});
