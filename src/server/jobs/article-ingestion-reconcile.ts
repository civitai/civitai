import { dbRead } from '~/server/db/client';
import { createJob } from '~/server/jobs/job';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { hashContent } from '~/server/services/entity-moderation.service';
import {
  articleHasText,
  articleTextVerdictMatch,
  updateArticleImageScanStatus,
} from '~/server/services/article.service';
import { submitTextModeration } from '~/server/services/text-moderation.service';
import { submitTextModerationOrScan } from '~/server/services/text-scan/route';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import {
  ArticleIngestionStatus,
  ArticleStatus,
  EntityModerationStatus,
} from '~/shared/utils/prisma/enums';
import { decreaseDate } from '~/utils/date-helpers';
import { articleModerationText } from '~/server/services/article-ingestion.helpers';

// Grace window before an article is considered "stuck". Gives the normal
// webhook path time to fire before the cron steps in.
const STUCK_THRESHOLD_MINUTES = 15;
// Per article text: a verdict that keeps coming back for other text is left Pending for moderators.
const MAX_FORCED_RESUBMITS = 3;
const FORCED_RESUBMITS_TTL_SECONDS = 7 * 24 * 60 * 60;

// After this long without a webhook, a Pending EntityModeration row is
// considered lost. Matches TEXT_MODERATION_PENDING_TIMEOUT_MINUTES in
// `text-moderation-retry.ts` so both cron paths agree.
const PENDING_MODERATION_TIMEOUT_MINUTES = 30;

const MODERATION_RETRY_LIMIT = 9;
const FETCH_LIMIT = 500;
const RECONCILE_CONCURRENCY = 5;

type StuckArticleRow = { id: number };

// A Redis failure reads as capped, so a resubmit is never billed without being counted.
async function recordForcedResubmit(articleId: number, textHash: string) {
  const key =
    `${REDIS_SYS_KEYS.ARTICLE_VERDICT_RESUBMITS.ATTEMPTS}:${articleId}:${textHash}` as const;
  try {
    const attempts = await sysRedis.incrBy(key, 1);
    await sysRedis.expire(key, FORCED_RESUBMITS_TTL_SECONDS);
    return attempts;
  } catch {
    return MAX_FORCED_RESUBMITS + 1;
  }
}

/**
 * Find articles whose ingestion pipeline has stalled and re-run the state
 * machine for them. Two classes of drift this catches:
 *   1. `status IN (Published, Processing) AND ingestion IN (Pending, Rescan)` —
 *      scan webhooks completed but the final recompute never fired (lost
 *      webhook, process crash between `recordEntityModerationSuccess` and
 *      `recomputeArticleIngestion`, or the EntityModeration row was never
 *      created at all because `submitTextModeration` failed silently).
 *   2. `status = Processing AND ingestion = Scanned` — scans finished but the
 *      `Processing → Published` status flip inside `recomputeArticleIngestion`
 *      was never run.
 *
 * The `retry-failed-text-moderation` cron handles EntityModeration-level
 * retries; this one handles Article-level state drift and resubmits text
 * moderation only as a fallback when the article has text but no usable
 * moderation row.
 */
export const articleIngestionReconcile = createJob(
  'article-ingestion-reconcile',
  '*/10 * * * *',
  async () => {
    const now = new Date();
    const stuckBefore = decreaseDate(now, STUCK_THRESHOLD_MINUTES, 'minutes');
    const pendingModerationBefore = decreaseDate(
      now,
      PENDING_MODERATION_TIMEOUT_MINUTES,
      'minutes'
    );

    const candidates = await dbRead.$queryRaw<StuckArticleRow[]>`
      SELECT a.id
      FROM "Article" a
      WHERE a."updatedAt" < ${stuckBefore}
        AND (
          (
            a.status IN (${ArticleStatus.Published}::"ArticleStatus", ${ArticleStatus.Processing}::"ArticleStatus")
            AND a.ingestion IN (${ArticleIngestionStatus.Pending}::"ArticleIngestionStatus", ${ArticleIngestionStatus.Rescan}::"ArticleIngestionStatus")
          )
          OR (
            a.status = ${ArticleStatus.Processing}::"ArticleStatus"
            AND a.ingestion = ${ArticleIngestionStatus.Scanned}::"ArticleIngestionStatus"
          )
        )
      ORDER BY a."updatedAt" ASC
      LIMIT ${FETCH_LIMIT}
    `;

    if (!candidates.length) {
      return { candidates: 0, advanced: 0, resubmitted: 0, stillStuck: 0, errors: 0 };
    }

    let advanced = 0;
    let resubmitted = 0;
    let skippedResubmits = 0;
    let stillStuck = 0;
    let errors = 0;

    const tasks = candidates.map(({ id }) => async () => {
      try {
        const before = await dbRead.article.findUnique({
          where: { id },
          select: { status: true, ingestion: true },
        });
        if (!before) return;

        // Use the full scan-status path so a reconcile that flips Processing
        // → Published also re-derives `Article.nsfwLevel` from current cover
        // and content image ratings. A bare `recomputeArticleIngestion` would
        // only advance ingestion state and leave a stale nsfwLevel in place,
        // which is the exact thing that let stuck-Processing articles flip to
        // Published with a stored PG level while holding an R/X/XXX cover.
        await updateArticleImageScanStatus([id]);

        const after = await dbRead.article.findUnique({
          where: { id },
          select: {
            status: true,
            ingestion: true,
            title: true,
            content: true,
          },
        });
        if (!after) return;

        const changed = after.status !== before.status || after.ingestion !== before.ingestion;
        if (changed) advanced++;

        const stillPending =
          (after.status === ArticleStatus.Published || after.status === ArticleStatus.Processing) &&
          (after.ingestion === ArticleIngestionStatus.Pending ||
            after.ingestion === ArticleIngestionStatus.Rescan);

        let action: string = changed ? 'advanced' : 'no-op';

        // If it's still pending AND has text to moderate, see whether the
        // text-moderation pipeline needs a nudge. The retry cron also covers
        // Failed/Expired/Canceled/timed-out-Pending rows, but it does NOT
        // handle the "row was never created" case (silent submit failure),
        // which is exactly what this block catches.
        if (stillPending && articleHasText(after.title, after.content)) {
          const moderation = await dbRead.entityModeration.findUnique({
            where: { entityType_entityId: { entityType: 'Article', entityId: id } },
            select: {
              status: true,
              retryCount: true,
              updatedAt: true,
              contentHash: true,
              result: true,
            },
          });

          // The recompute left it unscanned because the verdict is for other text. Forced, or a
          // scan that dedupes on its own hash would skip it and leave the article waiting.
          const verdictForOtherText =
            moderation?.status === EntityModerationStatus.Succeeded &&
            articleTextVerdictMatch(moderation, after) === 'other';
          const shouldResubmit =
            !moderation ||
            verdictForOtherText ||
            (moderation.retryCount < MODERATION_RETRY_LIMIT &&
              (moderation.status === EntityModerationStatus.Failed ||
                moderation.status === EntityModerationStatus.Expired ||
                moderation.status === EntityModerationStatus.Canceled ||
                (moderation.status === EntityModerationStatus.Pending &&
                  moderation.updatedAt < pendingModerationBefore)));

          const textForModeration = articleModerationText(after.title, after.content);
          const capped =
            verdictForOtherText &&
            (await recordForcedResubmit(id, hashContent(textForModeration))) > MAX_FORCED_RESUBMITS;
          if (capped)
            logToAxiom({
              name: 'article-verdict-resubmit-capped',
              type: 'warning',
              articleId: id,
            }).catch(() => null);

          if (shouldResubmit && !capped) {
            let skipped: string | undefined;
            try {
              await submitTextModerationOrScan({
                entityType: 'Article',
                entityId: id,
                force: verdictForOtherText,
                onActiveSkip: async (reason) => {
                  skipped = reason;
                },
                xguard: () =>
                  submitTextModeration({
                    entityType: 'Article',
                    entityId: id,
                    content: textForModeration,
                    labels: ['nsfw'],
                    priority: 'low',
                    forceRescan: verdictForOtherText,
                  }),
              });
              if (skipped) {
                skippedResubmits++;
                action = `skipped (${skipped})`;
              } else {
                resubmitted++;
                action = 'resubmitted-moderation';
              }
            } catch (e) {
              errors++;
              await logToAxiom({
                name: 'article-ingestion-reconcile',
                type: 'error',
                message: `submitTextModeration failed: ${(e as Error).message}`,
                articleId: id,
              }).catch(() => null);
              return;
            }
          } else {
            stillStuck++;
            action = 'still-stuck';
          }
        }

        await logToAxiom({
          name: 'article-ingestion-reconcile',
          type: 'info',
          articleId: id,
          action,
          beforeStatus: before.status,
          beforeIngestion: before.ingestion,
          afterStatus: after.status,
          afterIngestion: after.ingestion,
        }).catch(() => null);
      } catch (e) {
        errors++;
        await logToAxiom({
          name: 'article-ingestion-reconcile',
          type: 'error',
          message: `recompute failed: ${(e as Error).message}`,
          stack: (e as Error).stack,
          articleId: id,
        }).catch(() => null);
      }
    });

    await limitConcurrency(tasks, RECONCILE_CONCURRENCY);

    return {
      candidates: candidates.length,
      advanced,
      resubmitted,
      skippedResubmits,
      stillStuck,
      errors,
    };
  }
);
