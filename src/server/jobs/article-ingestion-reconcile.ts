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
  ingestionErrorStep,
  readIngestionErrorState,
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

// Error articles are few, and most ticks act on none of them; the caps keep a mass failure (919
// images in five minutes on 2026-10-29) from coming back to the scanner in one tick.
const ERROR_FETCH_LIMIT = 2000;
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

    const errorRetries = await retryErrorArticles(now).catch((e) => {
      logToAxiom({
        name: 'article-ingestion-reconcile',
        type: 'error',
        message: `error retries failed: ${(e as Error).message}`,
      });
      return null;
    });

    if (!candidates.length) {
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

/** Writes the episode only while it is still the one that was read: a recompute may have ended it. */
async function writeErrorState(
  id: number,
  state: ArticleIngestionErrorState,
  expected: number | null
) {
  await kyselyWrite
    .withoutPlugins()
    .updateTable('Article')
    .set({
      metadata: sql`jsonb_set(COALESCE(metadata, '{}'::jsonb), '{ingestionError}', ${JSON.stringify(
        state
      )}::jsonb)`,
    })
    .where('id', '=', id)
    .where(
      expected === null
        ? sql<boolean>`metadata->'ingestionError' IS NULL AND ingestion = ${ArticleIngestionStatus.Error}::"ArticleIngestionStatus"`
        : sql<boolean>`(metadata->'ingestionError'->>'enteredAt')::bigint = ${expected}`
    )
    .execute();
}

/**
 * Published and Processing articles at ingestion Error: nothing else ever takes them out of it.
 * Each episode gets a few retry rounds, spread over days (`INGESTION_ERROR_ROUND_DAYS`), then one
 * `article-ingestion-error-exhausted` log for the moderators' monitor.
 */
async function retryErrorArticles(now: Date) {
  const rows = await dbRead.article.findMany({
    where: {
      status: { in: [ArticleStatus.Published, ArticleStatus.Processing] },
      ingestion: ArticleIngestionStatus.Error,
    },
    select: { id: true, metadata: true },
    orderBy: { id: 'asc' },
    take: ERROR_FETCH_LIMIT,
  });
  const due = rows
    .map(({ id, metadata }) => {
      const state = readIngestionErrorState(metadata);
      return { id, state, step: ingestionErrorStep(state, now.getTime()) };
    })
    .filter(({ step }) => step !== 'wait' && step !== 'done')
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

  for (const { id, state, step } of due) {
    try {
      if (step === 'exhaust' && state) {
        await writeErrorState(id, { ...state, exhaustedAt: now.getTime() }, state.enteredAt);
        counts.exhausted++;
        logToAxiom({
          name: 'article-ingestion-error-exhausted',
          type: 'warning',
          articleId: id,
        });
        continue;
      }

      // An input that recovered on its own (or a recompute that never ran) needs no retry.
      await updateArticleImageScanStatus([id]);
      // primary: read-after-write of the recompute above.
      const article = await dbWrite.article.findUnique({
        where: { id },
        select: {
          ingestion: true,
          userId: true,
          coverId: true,
          bannerId: true,
          title: true,
          content: true,
        },
      });
      if (!article || article.ingestion !== ArticleIngestionStatus.Error) {
        counts.left++;
        continue;
      }

      if (step === 'start') {
        await writeErrorState(id, { enteredAt: now.getTime(), rounds: 0 }, null);
        continue;
      }
      if (!state || imageBudget <= 0) continue;

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
        ? await dbRead.entityModeration.findUnique({
            where: { entityType_entityId: { entityType: 'Article', entityId: id } },
            select: { status: true, retryCount: true },
          })
        : null;
      if (textCheckSpentRetries(moderation)) {
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

      await writeErrorState(
        id,
        { ...state, rounds: state.rounds + 1, lastRoundAt: now.getTime() },
        state.enteredAt
      );
      counts.rounds++;
      logToAxiom({
        name: 'article-ingestion-reconcile',
        type: 'info',
        articleId: id,
        action: 'error-retry-round',
        message: `round ${state.rounds + 1}: ${images.sent} image(s)${
          textCheckSpentRetries(moderation) ? ', text check' : ''
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
    }
  }
  return counts;
}
