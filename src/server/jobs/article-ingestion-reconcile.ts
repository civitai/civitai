import { dbRead } from '~/server/db/client';
import { createJob } from '~/server/jobs/job';
import { logToAxiom } from '~/server/logging/client';
import { articleHasText, updateArticleImageScanStatus } from '~/server/services/article.service';
import { submitTextModeration } from '~/server/services/text-moderation.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import {
  ArticleIngestionStatus,
  ArticleStatus,
  EntityModerationStatus,
} from '~/shared/utils/prisma/enums';
import { decreaseDate } from '~/utils/date-helpers';
import { removeTags } from '~/utils/string-helpers';

// Grace window before an article is considered "stuck". Gives the normal
// webhook path time to fire before the cron steps in.
const STUCK_THRESHOLD_MINUTES = 15;

// After this long without a webhook, a Pending EntityModeration row is
// considered lost. Matches TEXT_MODERATION_PENDING_TIMEOUT_MINUTES in
// `text-moderation-retry.ts` so both cron paths agree.
const PENDING_MODERATION_TIMEOUT_MINUTES = 30;

const MODERATION_RETRY_LIMIT = 9;
const FETCH_LIMIT = 500;
const RECONCILE_CONCURRENCY = 5;

type StuckArticleRow = { id: number };

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

        let action: 'advanced' | 'resubmitted-moderation' | 'still-stuck' | 'no-op' = changed
          ? 'advanced'
          : 'no-op';

        // If it's still pending AND has text to moderate, see whether the
        // text-moderation pipeline needs a nudge. The retry cron also covers
        // Failed/Expired/Canceled/timed-out-Pending rows, but it does NOT
        // handle the "row was never created" case (silent submit failure),
        // which is exactly what this block catches.
        if (stillPending && articleHasText(after.title, after.content)) {
          const moderation = await dbRead.entityModeration.findUnique({
            where: { entityType_entityId: { entityType: 'Article', entityId: id } },
            select: { status: true, retryCount: true, updatedAt: true },
          });

          const shouldResubmit =
            !moderation ||
            (moderation.retryCount < MODERATION_RETRY_LIMIT &&
              (moderation.status === EntityModerationStatus.Failed ||
                moderation.status === EntityModerationStatus.Expired ||
                moderation.status === EntityModerationStatus.Canceled ||
                (moderation.status === EntityModerationStatus.Pending &&
                  moderation.updatedAt < pendingModerationBefore)));

          if (shouldResubmit) {
            const textForModeration = [after.title, removeTags(after.content ?? '')]
              .filter(Boolean)
              .join(' ');
            try {
              await submitTextModeration({
                entityType: 'Article',
                entityId: id,
                content: textForModeration,
                labels: ['nsfw'],
                priority: 'low',
              });
              resubmitted++;
              action = 'resubmitted-moderation';
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
      stillStuck,
      errors,
    };
  }
);
