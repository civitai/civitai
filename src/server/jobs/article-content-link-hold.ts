import { constants } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { createJob } from '~/server/jobs/job';
import { logToAxiom } from '~/server/logging/client';
import { linkArticleContentImages } from '~/server/services/article.service';
import {
  contentLinkHoldCounter,
  getContentLinkHold,
} from '~/server/services/article-content-link-hold';
import { createReport } from '~/server/services/report.service';
import { ArticleStatus, ReportReason } from '~/shared/utils/prisma/enums';
import { ReportEntity } from '~/shared/utils/report-helpers';

/** A deferral older than this goes to moderators rather than waiting on in silence. */
export const CONTENT_LINK_DEFERRAL_BACKSTOP_MS = 24 * 60 * 60 * 1000;
export const CONTENT_LINK_DEFERRAL_REPORT_COMMENT =
  'automated: image could not be verified after 24h';
const BATCH = 200;

/**
 * Re-links each held article, least recently checked first, which settles each url whose key's
 * issuer can now be read.
 */
export async function settleContentLinkHolds(now = new Date()) {
  const holds = await dbWrite.articleContentLinkHold.findMany({
    orderBy: { checkedAt: 'asc' },
    take: BATCH,
    select: { articleId: true },
  });
  for (const { articleId } of holds) {
    try {
      await dbWrite.articleContentLinkHold.updateMany({
        where: { articleId },
        data: { checkedAt: now },
      });
      await settleArticle(articleId, now);
    } catch (error) {
      logToAxiom({
        type: 'error',
        name: 'article-content-link-hold',
        message: 'Failed to settle a held article',
        articleId,
        error: (error as Error).message,
      }).catch(() => undefined);
    }
  }
  return { checked: holds.length };
}

async function settleArticle(articleId: number, now: Date) {
  const before = await getContentLinkHold(dbWrite, articleId);
  // Read here, not with the batch: a save since then replaced the content the hold was taken on.
  const article = await dbWrite.article.findUnique({
    where: { id: articleId },
    select: { userId: true, content: true, coverId: true, status: true },
  });
  if (!before || !article) return;
  await linkArticleContentImages({
    articleId,
    content: article.content ?? '',
    userId: before.editorId,
    ownerId: article.userId,
    coverId: article.coverId,
    now,
  });

  const hold = await getContentLinkHold(dbWrite, articleId);
  if (!hold?.deferred.length || hold.reportedAt || !hold.deferredSince) return;
  if (now.getTime() - hold.deferredSince.getTime() < CONTENT_LINK_DEFERRAL_BACKSTOP_MS) return;
  // Nobody else sees an unpublished article, so there is nothing for a moderator to act on yet.
  if (article.status !== ArticleStatus.Published) return;

  await createReport({
    userId: constants.system.user.id,
    isModerator: true,
    id: articleId,
    type: ReportEntity.Article,
    reason: ReportReason.AdminAttention,
    details: { reason: 'Other', comment: CONTENT_LINK_DEFERRAL_REPORT_COMMENT },
    foldIntoPendingOnly: true,
  });
  await dbWrite.articleContentLinkHold.updateMany({
    where: { articleId },
    data: { reportedAt: now },
  });
  contentLinkHoldCounter.inc({ outcome: 'reported' });
}

export const articleContentLinkHold = createJob(
  'article-content-link-hold',
  '*/10 * * * *',
  async () => settleContentLinkHolds()
);
