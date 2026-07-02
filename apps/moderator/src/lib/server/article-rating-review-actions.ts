import { getClickhouse } from './clickhouse';
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

  // TODO(moderator-migration): notify the owner (article-rating-review-approved/rejected). Notifications
  // write to a separate notifications DB (notifDbWrite) not wired into the spoke — deferred to Wave 2.

  return { ok: true, status: result.status };
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
