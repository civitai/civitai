import { dbRead } from '~/server/db/client';
import type { BareNotification } from '~/server/notifications/base.notifications';
import { articleDetailFetcher } from '~/server/notifications/detail-fetchers/article.detail-fetcher';
import { buzzDetailFetcher } from '~/server/notifications/detail-fetchers/buzz.detail-fetcher';
import { commentDetailFetcher } from '~/server/notifications/detail-fetchers/comment.detail-fetcher';
import { followDetailFetcher } from '~/server/notifications/detail-fetchers/follow.detail-fetcher';
import { modelDetailFetcher } from '~/server/notifications/detail-fetchers/model.detail-fetcher';
import { modelFaceDetailFetcher } from '~/server/notifications/detail-fetchers/model-face.detail-fetcher';
import { placementDetailFetcher } from '~/server/notifications/detail-fetchers/placement.detail-fetcher';
import { reviewDetailFetcher } from '~/server/notifications/detail-fetchers/review.detail-fetcher';

const detailFetchers = [
  commentDetailFetcher,
  modelDetailFetcher,
  articleDetailFetcher,
  buzzDetailFetcher,
  followDetailFetcher,
  reviewDetailFetcher,
  placementDetailFetcher,
  modelFaceDetailFetcher,
];

/**
 * `showSfwFace` is the reader's: from their browsing level in the app, and `true` for email and push,
 * which have no site and are shown off-site, as link previews are.
 */
export async function populateNotificationDetails(
  notifications: BareNotification[],
  { showSfwFace }: { showSfwFace: boolean }
) {
  for (const { types, fetcher } of detailFetchers) {
    const targetNotifications = notifications.filter((n) => types.includes(n.type));
    await fetcher(targetNotifications, { db: dbRead, showSfwFace });
  }
}
