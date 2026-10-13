import { NotificationCategory, SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { eventEngine } from '~/server/events';
import { logToAxiom } from '~/server/logging/client';
import { userArticleCountCache } from '~/server/redis/caches';
import { articlesSearchIndex } from '~/server/search-index';
import { getScheduledArticleGoLive } from '~/server/services/article-schedule.helpers';
import { createNotification } from '~/server/services/notification.service';
import { ArticleStatus } from '~/shared/utils/prisma/enums';

// A minute's worth is a handful; the cap only bounds a backlog after an outage; the rest go next run.
const GO_LIVE_BATCH = 500;

/**
 * Takes every scheduled article whose time has come live. Run each minute by
 * process-scheduled-publishing. The predicate is `scheduledAt <= now`, not a window, so a missed run
 * is caught up rather than dropped.
 *
 * Each row is written with a guarded update that re-checks the state it was decided on, so a cancel,
 * an edit or a scan settling between the read and the write leaves that row for the next run instead
 * of acting on stale state.
 */
export async function publishDueScheduledArticles(now: Date) {
  const due = await dbWrite.article.findMany({
    where: { status: ArticleStatus.Draft, scheduledAt: { lte: now } },
    select: { id: true, userId: true, ingestion: true, scheduledAt: true },
    orderBy: { scheduledAt: 'asc' },
    take: GO_LIVE_BATCH,
  });

  const published: { id: number; userId: number }[] = [];
  const processing: { id: number; userId: number }[] = [];
  const failed: { id: number; userId: number; scheduledAt: Date | null }[] = [];

  for (const article of due) {
    const outcome = getScheduledArticleGoLive(article.ingestion);
    const guard = {
      id: article.id,
      status: ArticleStatus.Draft,
      publishedAt: null,
      scheduledAt: article.scheduledAt,
      ingestion: article.ingestion,
    };

    if (outcome === 'publish') {
      // publishedAt is the real go-live instant, not the scheduled one: the follower notification
      // and the Newest sort both key on it, and a value behind their last pass would be skipped.
      const { count } = await dbWrite.article.updateMany({
        where: guard,
        data: { status: ArticleStatus.Published, publishedAt: now, scheduledAt: null },
      });
      if (count) published.push(article);
    } else if (outcome === 'process') {
      // publishedAt stays NULL; recomputeArticleIngestion stamps it when the scan settles.
      const { count } = await dbWrite.article.updateMany({
        where: guard,
        data: { status: ArticleStatus.Processing, scheduledAt: null },
      });
      if (count) processing.push(article);
    } else {
      const { count } = await dbWrite.article.updateMany({
        where: guard,
        data: { scheduledAt: null },
      });
      if (count) failed.push(article);
    }
  }

  for (const { id, userId } of published) {
    await Promise.all([
      eventEngine.processEngagement({
        userId,
        type: 'published',
        entityType: 'article',
        entityId: id,
      }),
      articlesSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Update }]),
      userArticleCountCache.refresh(userId),
      createNotification({
        userId,
        category: NotificationCategory.System,
        type: 'system-message',
        key: `article-published-${id}`,
        details: {
          message: 'Your scheduled article is now live!',
          url: `/articles/${id}`,
        },
      }),
    ]).catch((error) => logGoLiveError('published side effects failed', id, error));
  }

  for (const { id, userId } of processing) {
    await userArticleCountCache
      .refresh(userId)
      .catch((error) => logGoLiveError('count refresh failed', id, error));
  }

  for (const { id, userId, scheduledAt } of failed) {
    await createNotification({
      userId,
      category: NotificationCategory.System,
      type: 'system-message',
      key: `article-schedule-failed-${id}-${scheduledAt?.getTime()}`,
      details: {
        message:
          'Your scheduled article was not published: an image or its text failed review. Fix it and publish or schedule it again.',
        url: `/articles/${id}/edit`,
      },
    }).catch((error) => logGoLiveError('failure notification failed', id, error));
  }

  if (due.length === GO_LIVE_BATCH)
    await logToAxiom({
      name: 'process-scheduled-publishing',
      type: 'warning',
      message: `Scheduled article backlog hit ${GO_LIVE_BATCH}; the rest go live next run`,
    }).catch(() => undefined);

  return {
    published: published.map((a) => a.id),
    processing: processing.map((a) => a.id),
    failed: failed.map((a) => a.id),
  };
}

function logGoLiveError(message: string, articleId: number, error: unknown) {
  return logToAxiom({
    name: 'process-scheduled-publishing',
    type: 'error',
    message: `scheduled article: ${message}`,
    articleId,
    error: (error as Error)?.message,
  }).catch(() => undefined);
}
