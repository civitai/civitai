import { ArticleStatus, Prisma } from '@prisma/client';
import * as z from 'zod';
import { pgDbRead } from '~/server/db/pgDb';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { createLogger } from '~/utils/logging';
import { booleanString } from '~/utils/zod-helpers';
import { EntityModerationStatus } from '~/shared/utils/prisma/enums';
import { submitTextModeration } from '~/server/services/text-moderation.service';
import { removeTags } from '~/utils/string-helpers';

type CancelFn = () => Promise<void>;

const log = createLogger('migrate-article-text-moderation', 'blue');

// --- Types ---

type MigrationStats = {
  articlesProcessed: number;
  textModerationSubmitted: number;
  textModerationSkipped: number;
  errors: string[];
};

type Article = { id: number; title: string; content: string; userId: number };

const querySchema = z.object({
  dryRun: booleanString().default(true),
  batchSize: z.coerce.number().min(1).max(1000).default(1000),
  concurrency: z.coerce.number().min(1).max(5).default(5),
  start: z.coerce.number().optional().default(0),
  end: z.coerce.number().optional(),
  after: z.coerce.date().optional(),
  before: z.coerce.date().optional(),
});

type MigrationParams = z.infer<typeof querySchema>;

// --- Helpers ---

async function fetchDateRange(params: MigrationParams, cancelFns: CancelFn[]) {
  const query = await pgDbRead.cancellableQuery<{ start: number; end: number }>(Prisma.sql`
    WITH dates AS (
      SELECT
      MIN("createdAt") as start,
      MAX("createdAt") as end
      FROM "Article" WHERE "createdAt" > ${params.after ?? new Date(0)}
      ${params.before ? Prisma.sql`AND "createdAt" < ${params.before}` : Prisma.empty}
    )
    SELECT MIN(id) as start, MAX(id) as end
    FROM "Article" a
    JOIN dates d ON d.start = a."createdAt" OR d.end = a."createdAt";
  `);
  cancelFns.push(query.cancel);
  const results = await query.result();
  return results[0];
}

async function fetchMaxArticleId(cancelFns: CancelFn[]) {
  const query = await pgDbRead.cancellableQuery<{ max: number }>(Prisma.sql`
    SELECT MAX(a.id) "max" FROM "Article" a
    LEFT JOIN "EntityModeration" em ON em."entityId" = a.id AND em."entityType" = 'Article'
    WHERE a.status = ${ArticleStatus.Published}::"ArticleStatus"
    AND a.content != ''
    AND (em.id IS NULL OR em.status != ${EntityModerationStatus.Succeeded}::"EntityModerationStatus")
  `);
  cancelFns.push(query.cancel);
  const results = await query.result();
  return results[0]?.max ?? 0;
}

// --- Main Handler ---

export default WebhookEndpoint(async (req, res) => {
  const result = querySchema.safeParse(req.query);
  if (!result.success) {
    return res.status(400).json({ ok: false, error: z.treeifyError(result.error) });
  }

  const params = result.data;
  const startTime = Date.now();

  log(
    `Starting article text-moderation backfill${params.dryRun ? ' (DRY RUN)' : ''} with batchSize ${
      params.batchSize
    }, concurrency ${params.concurrency}`
  );

  const stats: MigrationStats = {
    articlesProcessed: 0,
    textModerationSubmitted: 0,
    textModerationSkipped: 0,
    errors: [],
  };

  const cancelFns: CancelFn[] = [];
  let stopped = false;
  res.on('close', async () => {
    stopped = true;
    log(`Client disconnected, cancelling ${cancelFns.length} in-flight query(ies)...`);
    await Promise.all(
      cancelFns.map((cancel) =>
        cancel().catch((err) => log(`Cancel failed: ${(err as Error).message}`))
      )
    );
  });

  try {
    // Resolve cursor bounds
    let cursor = params.start;
    let maxId: number;
    if (params.after || params.before) {
      const range = await fetchDateRange(params, cancelFns);
      cursor = Math.max(cursor, range?.start ?? 0);
      maxId = params.end ?? range?.end ?? 0;
    } else {
      maxId = params.end ?? (await fetchMaxArticleId(cancelFns));
    }

    const rangeStart = cursor;
    const rangeSize = Math.max(maxId - rangeStart + 1, 1);
    log(
      `Processing range: cursor=${cursor}, maxId=${maxId} (span ${rangeSize} ids, ~${Math.ceil(
        rangeSize / params.batchSize
      )} batches)`
    );

    let batchNumber = 0;

    while (cursor <= maxId && !stopped) {
      batchNumber++;
      const batchStart = Date.now();

      log(`[batch ${batchNumber}] Fetching articles starting from id=${cursor}...`);

      const articlesQuery = await pgDbRead.cancellableQuery<Article>(Prisma.sql`
        SELECT DISTINCT a.id, a.title, a.content, a."userId"
        FROM "Article" a
        LEFT JOIN "EntityModeration" em ON em."entityId" = a.id AND em."entityType" = 'Article'
        WHERE a.id >= ${cursor} AND a.id <= ${maxId}
        AND a.status = ${ArticleStatus.Published}::"ArticleStatus"
        AND a.content != ''
        AND (em.id IS NULL OR em.status != ${EntityModerationStatus.Succeeded}::"EntityModerationStatus")
        ORDER BY a.id ASC
        LIMIT ${params.batchSize}
      `);
      cancelFns.push(articlesQuery.cancel);

      let articles: Article[];
      try {
        articles = await articlesQuery.result();
      } catch (error) {
        if (stopped) {
          log(`[batch ${batchNumber}] Fetch cancelled, exiting`);
          break;
        }
        throw error;
      }

      if (articles.length === 0) {
        log(`[batch ${batchNumber}] No more articles found — finishing`);
        break;
      }

      const firstId = articles[0].id;
      const lastId = articles[articles.length - 1].id;
      log(
        `[batch ${batchNumber}] Processing ${articles.length} articles (IDs ${firstId}-${lastId})...`
      );

      if (params.dryRun) {
        for (const article of articles) {
          const text = [article.title, removeTags(article.content)].filter(Boolean).join(' ');
          log(`[DRY RUN] Article ${article.id}: text moderation (${text.length} chars)`);
          if (text.trim()) stats.textModerationSubmitted++;
          else stats.textModerationSkipped++;
        }
      } else {
        const tasks = articles.map((article) => async () => {
          try {
            const text = [article.title, removeTags(article.content)].filter(Boolean).join(' ');

            if (!text.trim()) {
              stats.textModerationSkipped++;
              return;
            }

            const workflow = await submitTextModeration({
              entityType: 'Article',
              entityId: article.id,
              content: text,
              labels: ['nsfw'],
              priority: 'low',
            });
            if (workflow?.id) {
              stats.textModerationSubmitted++;
            } else {
              stats.errors.push(`Text moderation article ${article.id}: no workflow returned`);
            }
          } catch (error) {
            stats.errors.push(
              `Text moderation article ${article.id}: ${
                error instanceof Error ? error.message : 'Unknown error'
              }`
            );
          }
        });

        await limitConcurrency(tasks, params.concurrency);
      }

      stats.articlesProcessed += articles.length;
      cursor = lastId + 1;

      const batchDuration = Date.now() - batchStart;
      const elapsedSec = (Date.now() - startTime) / 1000;
      const progressPct = Math.min(
        100,
        Math.max(0, ((cursor - rangeStart) / rangeSize) * 100)
      ).toFixed(1);
      const rate = stats.articlesProcessed / Math.max(elapsedSec, 0.001);

      log(
        `[batch ${batchNumber}] Complete in ${batchDuration}ms | ` +
          `batch: ${articles.length} articles | ` +
          `totals: ${stats.articlesProcessed} processed, ${stats.textModerationSubmitted} submitted, ${stats.textModerationSkipped} skipped, ${stats.errors.length} errors | ` +
          `progress: ${progressPct}% (id ${cursor}/${maxId}) | ` +
          `rate: ${rate.toFixed(1)} articles/s | ` +
          `elapsed: ${elapsedSec.toFixed(1)}s`
      );
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    log(`Process completed successfully in ${duration}s${stopped ? ' (stopped early)' : ''}`);

    res.status(200).json({
      ok: true,
      dryRun: params.dryRun,
      stopped,
      duration: `${duration}s`,
      result: {
        articlesProcessed: stats.articlesProcessed,
        textModerationSubmitted: stats.textModerationSubmitted,
        textModerationSkipped: stats.textModerationSkipped,
        errorCount: stats.errors.length,
        errorsSample: stats.errors.slice(0, 10),
      },
    });
  } catch (error) {
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    log(`Process failed after ${duration}s:`, error);

    res.status(500).json({
      ok: false,
      error: (error as Error).message,
      stack: (error as Error).stack,
    });
  }
});
