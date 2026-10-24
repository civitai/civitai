import { NotificationCategory } from '@civitai/notifications';
import { buildRatingReviewNotification } from '@civitai/shared/rating-review';
import { getClickhouse } from './clickhouse';
import { recordModActivity } from './mod-activity';
import { getNotifications } from './notifications';
import { ratingReviewActivityEntityType } from './rating-review-apply';
import { resolveRatingReview, type ResolveResult } from './rating-reviews.service';
import { syncSearchIndex } from './search-index';
import { bustModelVersionCache } from './user-actions.service';
import { ReportStatus } from '$lib/rating-review';

const SEARCH_INDEXED = new Set(['Article', 'Bounty', 'Model']);

export async function resolveRatingReviewAction(input: {
  reviewId: number;
  appliedLevel: number;
  modComment?: string;
  userId: number;
}): Promise<{ ok: true; status: ReportStatus } | { ok: false; error: string }> {
  let result: ResolveResult;
  try {
    result = await resolveRatingReview({
      reviewId: input.reviewId,
      appliedLevel: input.appliedLevel,
      modComment: input.modComment,
      moderatorId: input.userId,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  void recordModActivity({
    userId: input.userId,
    entityType: ratingReviewActivityEntityType(result.entityType),
    entityId: result.entityId,
    activity: 'ratingReview',
  });
  if (result.entityMissing) return { ok: true, status: result.status };

  if (SEARCH_INDEXED.has(result.entityType))
    void syncSearchIndex({
      entityType: result.entityType.toLowerCase(),
      entityId: result.entityId,
      action: 'update',
    });
  // `resourceDataCache` carries `Model.nsfw` for an hour, and generation reads it.
  if (result.modelVersionIds.length) void bustModelVersionCache(result.modelVersionIds);
  if (result.entityType === 'Article') void recordArticleResolved(result, input);
  void notifyOwner(result, input);

  return { ok: true, status: result.status };
}

async function notifyOwner(
  result: ResolveResult,
  input: { appliedLevel: number; modComment?: string }
): Promise<void> {
  try {
    const n = buildRatingReviewNotification({
      reviewId: result.reviewId,
      approved: result.status === ReportStatus.Actioned,
      entityType: result.entityType,
      entityId: result.entityId,
      parentId: result.parentId,
      title: result.title,
      previousLevel: result.previousLevel,
      appliedLevel: input.appliedLevel,
      modComment: input.modComment,
    });
    await getNotifications().createNotification({
      userId: result.ownerUserId,
      category: NotificationCategory.System,
      ...n,
    });
  } catch {
    // The client already logged the failure.
  }
}

// The ClickHouse table predates the generic queue, is Article-shaped, and is created outside this repo.
async function recordArticleResolved(
  result: ResolveResult,
  input: { appliedLevel: number; userId: number }
): Promise<void> {
  try {
    await getClickhouse().insert({
      table: 'articleRatingReviewsResolved',
      values: [
        {
          userId: input.userId,
          reviewId: result.reviewId,
          articleId: result.entityId,
          status: result.status,
          appliedLevel: input.appliedLevel,
          moderatorId: input.userId,
        },
      ],
      format: 'JSONEachRow',
    });
  } catch (err) {
    console.error('[rating-review] failed to record resolved event', err);
  }
}
