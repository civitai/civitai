import { NotificationCategory } from '@civitai/notifications';
import { getBrowsingLevelLabel } from '@civitai/shared';
import { getClickhouse } from './clickhouse';
import { getNotifications } from './notifications';
import { syncSearchIndex } from './search-index';
import { resolveArticleRatingReview } from './article-rating-reviews.service';
import { ReportStatus } from '$lib/article-rating-review';

type ResolveOk = { ok: true; status: ReportStatus };
type ResolveErr = { ok: false; error: string };

// Resolve an article rating review, pinning it to `appliedLevel`. The DB mutation runs INTERNALLY via
// Kysely (see resolveArticleRatingReview). The only main-app hit is the approved Meilisearch enqueue.
export async function resolveRatingReview(input: {
  reviewId: number;
  appliedLevel: number;
  modComment?: string;
  userId: number;
}): Promise<ResolveOk | ResolveErr> {
  let result;
  try {
    result = await resolveArticleRatingReview({
      reviewId: input.reviewId,
      appliedLevel: input.appliedLevel,
      modComment: input.modComment,
      moderatorId: input.userId,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  // Keep Meilisearch in sync — the one main-app callback the spoke is allowed to make.
  void syncSearchIndex({ entityType: 'article', entityId: result.articleId, action: 'update' });

  void recordRatingReviewResolved({
    reviewId: input.reviewId,
    articleId: result.articleId,
    status: result.status,
    appliedLevel: input.appliedLevel,
    moderatorId: input.userId,
  });

  void notifyRatingReviewResolved({
    ownerUserId: result.ownerUserId,
    reviewId: input.reviewId,
    articleId: result.articleId,
    articleTitle: result.articleTitle,
    status: result.status,
    previousLevel: result.previousLevel,
    appliedLevel: input.appliedLevel,
    modComment: input.modComment,
  });

  return { ok: true, status: result.status };
}

// Owner notification, ported from the legacy resolveArticleRatingReview. Actioned = the mod granted the
// owner's suggested level (approved); Unactioned = the mod applied a different level (rejected). Sent via
// @civitai/notifications (best-effort — a delivery failure never fails the resolution).
async function notifyRatingReviewResolved(v: {
  ownerUserId: number;
  reviewId: number;
  articleId: number;
  articleTitle: string;
  status: ReportStatus;
  previousLevel: number;
  appliedLevel: number;
  modComment?: string;
}): Promise<void> {
  try {
    if (v.status === ReportStatus.Actioned)
      await getNotifications().createNotification({
        userId: v.ownerUserId,
        type: 'article-rating-review-approved',
        category: NotificationCategory.System,
        key: `article-rating-review-approved:${v.reviewId}`,
        details: {
          articleId: v.articleId,
          articleTitle: v.articleTitle,
          previousLevel: getBrowsingLevelLabel(v.previousLevel),
          newLevel: getBrowsingLevelLabel(v.appliedLevel),
          modComment: v.modComment ?? null,
        },
      });
    else
      await getNotifications().createNotification({
        userId: v.ownerUserId,
        type: 'article-rating-review-rejected',
        category: NotificationCategory.System,
        key: `article-rating-review-rejected:${v.reviewId}`,
        details: {
          articleId: v.articleId,
          articleTitle: v.articleTitle,
          appliedLevel: getBrowsingLevelLabel(v.appliedLevel),
          modComment: v.modComment ?? null,
        },
      });
  } catch {
    // onFailure already logged by the client; best-effort.
  }
}

// ClickHouse analytics parity with the legacy tRPC path's `ctx.track.articleRatingReviewResolved`. The
// spoke owns ClickHouse (see page-visits). Fire-and-forget; failures are swallowed.
async function recordRatingReviewResolved(values: {
  reviewId: number;
  articleId: number;
  status: ReportStatus;
  appliedLevel: number;
  moderatorId: number;
}): Promise<void> {
  try {
    await getClickhouse().insert({
      table: 'articleRatingReviewsResolved',
      values: [{ userId: values.moderatorId, ...values }],
      format: 'JSONEachRow',
    });
  } catch (err) {
    console.error('[article-rating-review] failed to record resolved event', err);
  }
}
