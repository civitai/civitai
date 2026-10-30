import { constants } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { createJob } from '~/server/jobs/job';
import { logToAxiom } from '~/server/logging/client';
import { linkArticleContentImages } from '~/server/services/article.service';
import {
  contentLinkHoldCounter,
  readContentLinkHold,
} from '~/server/services/article-content-link-hold';
import { createReport } from '~/server/services/report.service';
import { ReportReason } from '~/shared/utils/prisma/enums';
import { ReportEntity } from '~/shared/utils/report-helpers';

/** A deferral older than this goes to moderators rather than waiting on in silence. */
export const CONTENT_LINK_DEFERRAL_BACKSTOP_MS = 24 * 60 * 60 * 1000;
export const CONTENT_LINK_DEFERRAL_REPORT_COMMENT =
  'automated: image could not be verified after 24h';
const BATCH = 200;

type HeldArticle = { id: number; userId: number; content: string | null; coverId: number | null };

/** Re-links each held article, which settles each url whose key's issuer can now be read. */
export async function settleContentLinkHolds(now = new Date()) {
  const articles = await dbWrite.$queryRaw<HeldArticle[]>`
    SELECT id, "userId", content, "coverId" FROM "Article"
    WHERE metadata ? 'contentLinkHold'
    ORDER BY id
    LIMIT ${BATCH}
  `;
  for (const article of articles) {
    try {
      await settleArticle(article, now);
    } catch (error) {
      logToAxiom({
        type: 'error',
        name: 'article-content-link-hold',
        message: 'Failed to settle a held article',
        articleId: article.id,
        error: (error as Error).message,
      }).catch(() => undefined);
    }
  }
  return { checked: articles.length };
}

async function heldOf(articleId: number) {
  const row = await dbWrite.article.findUnique({
    where: { id: articleId },
    select: { metadata: true },
  });
  return readContentLinkHold(row?.metadata);
}

async function settleArticle(article: HeldArticle, now: Date) {
  const before = await heldOf(article.id);
  if (!before) return;
  await linkArticleContentImages({
    articleId: article.id,
    content: article.content ?? '',
    userId: before.editorId ?? article.userId,
    ownerId: article.userId,
    coverId: article.coverId,
  });

  const hold = await heldOf(article.id);
  if (!hold?.deferred.length || hold.reportedAt || !hold.deferredSince) return;
  if (now.getTime() - new Date(hold.deferredSince).getTime() < CONTENT_LINK_DEFERRAL_BACKSTOP_MS)
    return;

  await createReport({
    userId: constants.system.user.id,
    isModerator: true,
    id: article.id,
    type: ReportEntity.Article,
    reason: ReportReason.AdminAttention,
    details: { reason: 'Other', comment: CONTENT_LINK_DEFERRAL_REPORT_COMMENT },
  });
  await dbWrite.$executeRaw`
    UPDATE "Article"
    SET metadata = jsonb_set(metadata, '{contentLinkHold,reportedAt}', to_jsonb(${now.toISOString()}::text))
    WHERE id = ${article.id} AND metadata ? 'contentLinkHold'
  `;
  contentLinkHoldCounter.inc({ outcome: 'reported' });
}

export const articleContentLinkHold = createJob(
  'article-content-link-hold',
  '*/10 * * * *',
  async () => settleContentLinkHolds()
);
