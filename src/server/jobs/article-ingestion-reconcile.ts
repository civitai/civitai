import { sql } from 'kysely';
import { dbRead, dbWrite } from '~/server/db/client';
import { kyselyWrite } from '~/server/db/kyselyDb';
import { createJob } from '~/server/jobs/job';
import {
  TEXT_MODERATION_PENDING_TIMEOUT_MINUTES,
  TEXT_MODERATION_RETRY_LIMIT,
  TEXT_MODERATION_RETRY_STATUSES,
} from '~/server/jobs/text-moderation-retry.constants';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { hashContent } from '~/server/services/entity-moderation.service';
import {
  articleHasText,
  articleTextVerdictMatch,
  retryArticleErrorImages,
  updateArticleImageScanStatus,
} from '~/server/services/article.service';
import {
  ingestionErrorPatch,
  ingestionErrorStep,
  readIngestionErrorState,
  silentIngestionErrorState,
  textCheckSpentRetries,
  type ArticleIngestionErrorState,
} from '~/server/services/article-ingestion.helpers';
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

const FETCH_LIMIT = 500;
const RECONCILE_CONCURRENCY = 5;

// Caps per tick, so a mass failure is not sent back to the scanner all at once.
const ERROR_FETCH_LIMIT = 500;
const ERROR_ARTICLES_PER_TICK = 25;
const ERROR_IMAGES_PER_TICK = 200;

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
 * machine for them. Two classes of drift this catches (and, after them, the
 * Error retries in `retryErrorArticles`):
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
      TEXT_MODERATION_PENDING_TIMEOUT_MINUTES,
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
      const errorRetries = await runErrorRetries(now);
      return { candidates: 0, advanced: 0, resubmitted: 0, stillStuck: 0, errors: 0, errorRetries };
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
            (moderation.retryCount < TEXT_MODERATION_RETRY_LIMIT &&
              (TEXT_MODERATION_RETRY_STATUSES.includes(moderation.status) ||
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
            });

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
              logToAxiom({
                name: 'article-ingestion-reconcile',
                type: 'error',
                message: `submitTextModeration failed: ${(e as Error).message}`,
                articleId: id,
              });
              return;
            }
          } else {
            stillStuck++;
            action = 'still-stuck';
          }
        }

        logToAxiom({
          name: 'article-ingestion-reconcile',
          type: 'info',
          articleId: id,
          action,
          beforeStatus: before.status,
          beforeIngestion: before.ingestion,
          afterStatus: after.status,
          afterIngestion: after.ingestion,
        });
      } catch (e) {
        errors++;
        logToAxiom({
          name: 'article-ingestion-reconcile',
          type: 'error',
          message: `recompute failed: ${(e as Error).message}`,
          stack: (e as Error).stack,
          articleId: id,
        });
      }
    });

    await limitConcurrency(tasks, RECONCILE_CONCURRENCY);
    const errorRetries = await runErrorRetries(now);

    return {
      candidates: candidates.length,
      advanced,
      resubmitted,
      skippedResubmits,
      stillStuck,
      errors,
      errorRetries,
    };
  }
);

/**
 * Merges the job's own fields into the episode, only while it is the episode the job read: a
 * recompute may have ended it, or written its own fields since.
 */
async function updateErrorState(
  id: number,
  enteredAt: number,
  patch: Partial<ArticleIngestionErrorState>
) {
  await kyselyWrite
    .withoutPlugins()
    .updateTable('Article')
    .set({
      metadata: sql`jsonb_set(metadata, '{ingestionError}', (metadata->'ingestionError') || ${JSON.stringify(
        patch
      )}::jsonb)`,
    })
    .where('id', '=', id)
    .where(sql<boolean>`(metadata->'ingestionError'->>'enteredAt')::bigint = ${enteredAt}`)
    .execute();
}

async function textCheckOnPrimary(id: number) {
  // primary: the recompute just before may have read a newer verdict than the replica holds.
  return dbWrite.entityModeration.findUnique({
    where: { entityType_entityId: { entityType: 'Article', entityId: id } },
    select: { status: true, retryCount: true },
  });
}

/** Moves an article the job could not act on to the back of the queue, so it cannot block the rest. */
async function markChecked(id: number, checkedAt: number) {
  await kyselyWrite
    .withoutPlugins()
    .updateTable('Article')
    .set({
      metadata: sql`jsonb_set(COALESCE(metadata, '{}'::jsonb), '{ingestionError}', COALESCE(metadata->'ingestionError', ${JSON.stringify(
        silentIngestionErrorState(checkedAt)
      )}::jsonb) || ${JSON.stringify({ checkedAt })}::jsonb)`,
    })
    .where('id', '=', id)
    .where('ingestion', '=', ArticleIngestionStatus.Error)
    .execute();
}

async function runErrorRetries(now: Date) {
  return retryErrorArticles(now).catch((e) => {
    logToAxiom({
      name: 'article-ingestion-reconcile',
      type: 'error',
      message: `error retries failed: ${(e as Error).message}`,
    });
    return null;
  });
}

/**
 * Published and Processing articles at ingestion Error, which the stuck-article query above does
 * not select. Each episode gets retry rounds on `INGESTION_ERROR_ROUND_DAYS`, then one
 * `article-ingestion-error-exhausted` warning log, and a daily recompute while it stays at Error.
 */
async function retryErrorArticles(now: Date) {
  // Least recently checked first, so a backlog of exhausted episodes cannot starve newer ones.
  const rows = await dbRead.$queryRaw<{ id: number; ingestionError: unknown }[]>`
    SELECT a.id, a.metadata->'ingestionError' AS "ingestionError"
    FROM "Article" a
    WHERE a.status IN (${ArticleStatus.Published}::"ArticleStatus", ${ArticleStatus.Processing}::"ArticleStatus")
      AND a.ingestion = ${ArticleIngestionStatus.Error}::"ArticleIngestionStatus"
    ORDER BY COALESCE((a.metadata->'ingestionError'->>'checkedAt')::bigint, 0), a.id
    LIMIT ${ERROR_FETCH_LIMIT}
  `;
  const due = rows
    .filter(
      ({ ingestionError }) =>
        ingestionErrorStep(readIngestionErrorState({ ingestionError }), now.getTime()) !== 'wait'
    )
    .slice(0, ERROR_ARTICLES_PER_TICK);

  const counts = {
    candidates: due.length,
    left: 0,
    rounds: 0,
    images: 0,
    texts: 0,
    deferred: 0,
    exhausted: 0,
    errors: 0,
  };
  let imageBudget = ERROR_IMAGES_PER_TICK;
  const checkedAt = now.getTime();

  for (const { id } of due) {
    try {
      // An input that recovered, or a hold a moderator lifted, needs no retry.
      await updateArticleImageScanStatus([id]);
      // primary: read-after-write of the recompute above, which may have written the episode.
      const article = await dbWrite.article.findUnique({
        where: { id },
        select: {
          ingestion: true,
          userId: true,
          coverId: true,
          bannerId: true,
          title: true,
          content: true,
          metadata: true,
        },
      });
      if (!article || article.ingestion !== ArticleIngestionStatus.Error) {
        counts.left++;
        continue;
      }
      // The recompute records an episode for every article it leaves at Error.
      const state = readIngestionErrorState(article.metadata);
      if (!state) {
        await markChecked(id, checkedAt);
        continue;
      }
      const step = ingestionErrorStep(state, checkedAt);

      if (step === 'exhaust') {
        await updateErrorState(id, state.enteredAt, ingestionErrorPatch(step, state, checkedAt));
        counts.exhausted++;
        logToAxiom({ name: 'article-ingestion-error-exhausted', type: 'warning', articleId: id });
        continue;
      }
      if (step !== 'round' || imageBudget <= 0) {
        await updateErrorState(id, state.enteredAt, ingestionErrorPatch('check', state, checkedAt));
        continue;
      }

      const images = await retryArticleErrorImages({
        article: {
          id,
          userId: article.userId,
          coverId: article.coverId,
          bannerId: article.bannerId,
        },
        // A missing blob rarely comes back: one try, in the first round.
        includeNotFound: state.rounds === 0,
        budget: imageBudget,
        fullBudget: imageBudget === ERROR_IMAGES_PER_TICK,
      });
      if (images.deferred) {
        counts.deferred++;
        continue;
      }
      imageBudget -= images.sent;
      counts.images += images.sent;

      const moderation = articleHasText(article.title, article.content)
        ? await textCheckOnPrimary(id)
        : null;
      const resendText = textCheckSpentRetries(moderation);
      if (resendText) {
        await submitTextModerationOrScan({
          entityType: 'Article',
          entityId: id,
          force: true,
          xguard: () =>
            submitTextModeration({
              entityType: 'Article',
              entityId: id,
              content: articleModerationText(article.title, article.content),
              labels: ['nsfw'],
              priority: 'low',
              forceRescan: true,
              rearmRetries: true,
            }),
        });
        counts.texts++;
      }

      await updateErrorState(id, state.enteredAt, ingestionErrorPatch(step, state, checkedAt));
      counts.rounds++;
      logToAxiom({
        name: 'article-ingestion-reconcile',
        type: 'info',
        articleId: id,
        action: 'error-retry-round',
        message: `round ${state.rounds + 1}: ${images.sent} image(s)${
          resendText ? ', text check' : ''
        } sent again`,
      });
    } catch (e) {
      counts.errors++;
      logToAxiom({
        name: 'article-ingestion-reconcile',
        type: 'error',
        message: `error retry failed: ${(e as Error).message}`,
        articleId: id,
      });
      await markChecked(id, checkedAt).catch(() => undefined);
    }
  }
  return counts;
}
