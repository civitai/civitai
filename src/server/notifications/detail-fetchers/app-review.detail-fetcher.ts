import { createDetailFetcher } from '~/server/notifications/detail-fetchers/base.detail-fetcher';
import { simpleUserSelect } from '~/server/selectors/user.selector';

/** The app-review types whose copy names the individual reviewer (`appReviewByline`). */
export const APP_REVIEW_ATTRIBUTED_TYPES = [
  'app-block-approved',
  'app-block-rejected',
  'app-listing-approved',
  'app-listing-rejected',
  // The owner's copy of a staff on-behalf submit's outcome
  // (`app-platform-update-submit.notifications`).
  'app-platform-update-approved',
  'app-platform-update-rejected',
  // NOT `app-listing-hidden`: a takedown names the team only, so its reviewer is never resolved.
] as const;

const isBlockType = (type: string) =>
  type.startsWith('app-block-') || type.startsWith('app-platform-update-');

/**
 * Resolves the reviewer into `actor`, the reviewer the byline names and the notification list
 * shows as the avatar. A deleted or missing account resolves to no actor, so the byline falls
 * back to "Civitai App Review".
 *
 * The reviewer is read server-side: from the stored `reviewRequestId`'s `reviewedByUserId`
 * (`AppBlockPublishRequest` for an `app-block-*` or `app-platform-update-*` type,
 * `AppListingPublishRequest` for an `app-listing-*` one), or, on a notification sent before that was stored, from its legacy
 * `reviewerUserId`.
 *
 * The details this returns go to the client verbatim (the notification list and
 * `/api/notification/getDetails`), so `reviewerUserId` and `reviewRequestId` are removed from
 * every notification in the batch, resolved or not; `reviewedByModerator` is all the byline needs
 * to fall back to the team when there is no actor.
 */
export const appReviewDetailFetcher = createDetailFetcher({
  types: [...APP_REVIEW_ATTRIBUTED_TYPES],
  fetcher: async (notifications, { db }) => {
    const requestIds = (block: boolean) => [
      ...new Set(
        notifications
          .filter((n) => isBlockType(n.type) === block)
          .map((n) => n.details.reviewRequestId)
          .filter((id): id is string => typeof id === 'string' && id.length > 0)
      ),
    ];
    const blockRequestIds = requestIds(true);
    const listingRequestIds = requestIds(false);
    const select = { id: true, reviewedByUserId: true } as const;
    const [blockRequests, listingRequests] = await Promise.all([
      blockRequestIds.length === 0
        ? []
        : db.appBlockPublishRequest.findMany({ where: { id: { in: blockRequestIds } }, select }),
      listingRequestIds.length === 0
        ? []
        : db.appListingPublishRequest.findMany({
            where: { id: { in: listingRequestIds } },
            select,
          }),
    ]);
    const reviewerOf = (n: (typeof notifications)[number]): number | undefined => {
      const legacy = n.details.reviewerUserId;
      if (typeof legacy === 'number') return legacy;
      const requestId = n.details.reviewRequestId;
      if (typeof requestId !== 'string') return undefined;
      const rows = isBlockType(n.type) ? blockRequests : listingRequests;
      return rows.find((r) => r.id === requestId)?.reviewedByUserId ?? undefined;
    };

    const userIds = [
      ...new Set(
        notifications.map(reviewerOf).filter((id): id is number => typeof id === 'number')
      ),
    ];
    const users =
      userIds.length === 0
        ? []
        : await db.user.findMany({
            where: { id: { in: userIds }, deletedAt: null },
            select: simpleUserSelect,
          });

    for (const n of notifications) {
      const decidedByModerator =
        typeof n.details.reviewerUserId === 'number' ||
        n.details.reviewedByModerator === true ||
        typeof n.details.reviewRequestId === 'string';
      const reviewerUserId = reviewerOf(n);
      const user =
        typeof reviewerUserId === 'number' ? users.find((u) => u.id === reviewerUserId) : undefined;
      if (user) {
        const { id, ...actor } = user;
        n.details.actor = actor;
      }
      if (decidedByModerator) n.details.reviewedByModerator = true;
      delete n.details.reviewerUserId;
      delete n.details.reviewRequestId;
    }
  },
});
