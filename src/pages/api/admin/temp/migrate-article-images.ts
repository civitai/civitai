import { ArticleStatus, Prisma } from '@prisma/client';
import * as z from 'zod';
import { dbWrite } from '~/server/db/client';
import { pgDbRead } from '~/server/db/pgDb';
import { dataProcessor } from '~/server/db/db-helpers';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { createLogger } from '~/utils/logging';
import { booleanString } from '~/utils/zod-helpers';
import { getContentMedia } from '~/server/services/article-content-cleanup.service';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import { ImageConnectionType } from '~/server/common/enums';
import { recomputeArticleIngestion } from '~/server/services/article.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';

const log = createLogger('migrate-article-images', 'blue');

// --- Types / Schema ---

type Article = { id: number; content: string; userId: number };

type MigrationStats = {
  articlesProcessed: number;
  imagesCreated: number;
  connectionsCreated: number;
  errors: number;
};

/** Minimal contract dataProcessor needs for cancellation — `NextApiResponse`
 * satisfies it because the underlying `http.ServerResponse` extends
 * `EventEmitter` and emits `'close'` when the client disconnects. */
type RunContext = { on: (event: 'close', listener: () => void) => void };

const querySchema = z.object({
  dryRun: booleanString().default(true),
  rollback: booleanString().default(false),
  // Reconcile mode: run `recomputeArticleIngestion` on every Published article
  // stuck in `Pending`/`Rescan` state. Fixes articles where scan webhooks
  // completed but the pipeline never flipped ingestion to a terminal state
  // (e.g. debounce race in `webhook-debounce.ts`).
  reconcile: booleanString().default(false),
  // Each batch extracts media from up to `batchSize` articles and commits in
  // one transaction (~10 media items/article on average). `concurrency`
  // parallel batches run at once — don't exceed the DB connection pool. The
  // run continues until the cursor exhausts the corpus (or the caller aborts).
  //
  // Scanning is async: images are created with `ingestion: Pending` and the
  // `trg_image_scan_queue` DB trigger enqueues them to JobQueue. The
  // `ingest-images` cron sends article-backfill images through the low-priority
  // orchestrator lane (see `src/server/jobs/image-ingestion.ts`) so migration
  // work doesn't starve live user uploads.
  batchSize: z.coerce.number().min(1).max(1000).default(250),
  concurrency: z.coerce.number().min(1).max(10).default(4),
  // `start` is the minimum Article ID to consider. Useful when resuming after
  // an abort (the per-group log line prints the current cursor).
  start: z.coerce.number().optional().default(0),
  end: z.coerce.number().optional(),
});

type MigrationParams = z.infer<typeof querySchema>;

// --- Rollback Mode ---

async function runRollback(params: MigrationParams): Promise<{
  connectionsDeleted: number;
  tagsDeleted: number;
  imagesDeleted: number;
  articlesReset: number;
}> {
  const { dryRun } = params;

  log(`Running rollback${dryRun ? ' (DRY RUN)' : ''}...`);

  // Step 1: Find all Article ImageConnections and their image IDs
  const connections = await dbWrite.$queryRaw<{ imageId: number; entityId: number }[]>`
    SELECT "imageId", "entityId"
    FROM "ImageConnection"
    WHERE "entityType" = 'Article'
  `;

  if (connections.length === 0) {
    log('No Article ImageConnections found — nothing to rollback');
    return { connectionsDeleted: 0, tagsDeleted: 0, imagesDeleted: 0, articlesReset: 0 };
  }

  const imageIds = [...new Set(connections.map((c) => c.imageId))];
  const articleIds = [...new Set(connections.map((c) => c.entityId))];

  log(
    `Found ${connections.length} connections, ${imageIds.length} images, ${articleIds.length} articles`
  );

  // Step 2: Find which images have OTHER references and must be preserved.
  // Mirrors the checks in isExemptFromAiVerification — we can't just look at
  // ImageConnection since images can also be tied to posts, model resources,
  // or cover-image slots on users/articles/challenges/profiles.
  const sharedImages = await dbWrite.$queryRaw<{ imageId: number }[]>`
    SELECT DISTINCT id AS "imageId"
    FROM "Image"
    WHERE id IN (${Prisma.join(imageIds)})
      AND (
        "postId" IS NOT NULL
        OR EXISTS (
          SELECT 1 FROM "ImageConnection" ic
          WHERE ic."imageId" = "Image".id AND ic."entityType" != 'Article'
        )
        OR EXISTS (SELECT 1 FROM "ImageResourceNew" r WHERE r."imageId" = "Image".id)
        OR EXISTS (SELECT 1 FROM "User" u WHERE u."profilePictureId" = "Image".id)
        OR EXISTS (SELECT 1 FROM "UserProfile" up WHERE up."coverImageId" = "Image".id)
        OR EXISTS (SELECT 1 FROM "Article" a WHERE a."coverId" = "Image".id)
        OR EXISTS (SELECT 1 FROM "Challenge" ch WHERE ch."coverImageId" = "Image".id)
      )
  `;
  const sharedImageIds = new Set(sharedImages.map((r) => r.imageId));
  const orphanedImageIds = imageIds.filter((id) => !sharedImageIds.has(id));

  log(
    `${orphanedImageIds.length} images are article-only (will delete), ${sharedImageIds.size} shared with other entities (will keep)`
  );

  if (dryRun) {
    return {
      connectionsDeleted: connections.length,
      tagsDeleted: 0, // can't count without deleting
      imagesDeleted: orphanedImageIds.length,
      articlesReset: articleIds.length,
    };
  }

  // Step 3: Delete tags on orphaned images
  let tagsDeleted = 0;
  if (orphanedImageIds.length > 0) {
    const tagResult = await dbWrite.$executeRaw`
      DELETE FROM "TagsOnImageNew"
      WHERE "imageId" IN (${Prisma.join(orphanedImageIds)})
    `;
    tagsDeleted = tagResult;
    log(`Deleted ${tagsDeleted} tag associations`);
  }

  // Step 4: Delete all Article ImageConnections
  const connResult = await dbWrite.$executeRaw`
    DELETE FROM "ImageConnection"
    WHERE "entityType" = 'Article'
  `;
  log(`Deleted ${connResult} ImageConnections`);

  // Step 5: Delete orphaned images (no S3 deletion — these are references to content URLs)
  let imagesDeleted = 0;
  if (orphanedImageIds.length > 0) {
    const imgResult = await dbWrite.$executeRaw`
      DELETE FROM "Image"
      WHERE id IN (${Prisma.join(orphanedImageIds)})
    `;
    imagesDeleted = imgResult;
    log(`Deleted ${imagesDeleted} orphaned images`);
  }

  // Step 6: Recompute article ingestion (will go back to Scanned since no images remain)
  log(`Recomputing ingestion for ${articleIds.length} articles...`);
  const recomputeTasks = articleIds.map((articleId) => async () => {
    try {
      await recomputeArticleIngestion(articleId);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      log(`  ⚠️  recomputeArticleIngestion failed for article ${articleId}: ${msg}`);
    }
  });
  await limitConcurrency(recomputeTasks, params.concurrency);

  return {
    connectionsDeleted: connResult,
    tagsDeleted,
    imagesDeleted,
    articlesReset: articleIds.length,
  };
}

// --- Reconcile Mode ---
//
// Recomputes `Article.ingestion` for Published articles stuck in `Pending` or
// `Rescan`. `recomputeArticleIngestion` is idempotent: articles that are
// genuinely still scanning stay `Pending`; articles whose images/text already
// finished get promoted to `Scanned` (or `Blocked`/`Error` as appropriate).

async function runReconcile(params: MigrationParams): Promise<{
  articlesFound: number;
  recomputed: number;
  errors: number;
}> {
  const { dryRun, concurrency } = params;

  log(`Running reconcile${dryRun ? ' (DRY RUN)' : ''}...`);

  const articles = await dbWrite.$queryRaw<{ id: number }[]>`
    SELECT a.id
    FROM "Article" a
    WHERE a.status = ${ArticleStatus.Published}::"ArticleStatus"
      AND a.ingestion IN ('Pending', 'Rescan')
    ORDER BY a.id ASC
  `;

  log(`Found ${articles.length} Published articles in Pending/Rescan`);

  if (dryRun) {
    return { articlesFound: articles.length, recomputed: 0, errors: 0 };
  }

  let recomputed = 0;
  let errors = 0;
  const startTime = Date.now();

  const tasks = articles.map(({ id }) => async () => {
    try {
      await recomputeArticleIngestion(id);
      recomputed++;
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      log(`  ⚠️  recomputeArticleIngestion failed for article ${id}: ${msg}`);
      errors++;
    }
  });
  await limitConcurrency(tasks, concurrency);

  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`Reconciled ${recomputed}/${articles.length} articles in ${elapsedSec}s (${errors} errors)`);

  return { articlesFound: articles.length, recomputed, errors };
}

// --- Migration ---
//
// Extract content images from a batch of articles, create `Image` rows
// (`ingestion: Pending`) + `ImageConnection` rows, and recompute each
// article's ingestion state. Scanning runs async: the `trg_image_scan_queue`
// DB trigger enqueues new Pending images into JobQueue, the `ingest-images`
// cron submits them via the low-priority orchestrator lane, and
// `/api/webhooks/image-scan-result` flips articles back to `Scanned` once
// all images terminate.

async function processBatch(
  articles: Article[],
  dryRun: boolean,
  concurrency: number,
  stats: MigrationStats
): Promise<void> {
  const batchIds = articles.map((a) => a.id);

  // Extract URLs. Deduplicate across the batch so shared URLs create a
  // single Image row + multiple ImageConnection rows.
  const allUrls = new Set<string>();
  const mediaByUrl = new Map<string, { type: 'image' | 'video'; userId: number; name?: string }>();
  const articleUrlPairs: Array<{ articleId: number; url: string }> = [];

  for (const article of articles) {
    const media = getContentMedia(article.content);
    for (const item of media) {
      allUrls.add(item.url);
      articleUrlPairs.push({ articleId: article.id, url: item.url });
      if (!mediaByUrl.has(item.url)) {
        mediaByUrl.set(item.url, { type: item.type, userId: article.userId, name: item.alt });
      }
    }
  }

  if (dryRun) {
    log(`[DRY RUN] ${articles.length} articles → ${allUrls.size} unique URLs`);
    stats.articlesProcessed += articles.length;
    stats.imagesCreated += allUrls.size;
    stats.connectionsCreated += articleUrlPairs.length;
    return;
  }

  if (allUrls.size > 0) {
    try {
      await dbWrite.$transaction(
        async (tx) => {
          const existing = await tx.image.findMany({
            where: { url: { in: [...allUrls] } },
            select: { id: true, url: true },
          });
          const urlToImageId = new Map(existing.map((img) => [img.url, img.id]));
          const missingUrls = [...allUrls].filter((url) => !urlToImageId.has(url));

          if (missingUrls.length > 0) {
            // `ingestion: Pending` causes the `trg_image_scan_queue` trigger
            // to auto-enqueue into JobQueue.
            const created = await tx.image.createManyAndReturn({
              data: missingUrls.map((url) => {
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                const info = mediaByUrl.get(url)!;
                return {
                  url,
                  userId: info.userId,
                  type: info.type,
                  name: info.name,
                  ingestion: ImageIngestionStatus.Pending,
                  scanRequestedAt: new Date(),
                };
              }),
              select: { id: true, url: true },
              skipDuplicates: true,
            });
            for (const img of created) urlToImageId.set(img.url, img.id);
            stats.imagesCreated += created.length;
          }

          const connections = articleUrlPairs
            .map(({ articleId, url }) => {
              const imageId = urlToImageId.get(url);
              return imageId
                ? { imageId, entityType: ImageConnectionType.Article, entityId: articleId }
                : null;
            })
            .filter((c): c is NonNullable<typeof c> => c !== null);

          if (connections.length > 0) {
            await tx.imageConnection.createMany({ data: connections, skipDuplicates: true });
            stats.connectionsCreated += connections.length;
          }

          await tx.article.updateMany({
            where: { id: { in: batchIds } },
            data: { scanRequestedAt: new Date() },
          });
        },
        { timeout: 60_000, maxWait: 10_000 }
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      log(
        `❌ Batch transaction failed (articles ${batchIds[0]}-${
          batchIds[batchIds.length - 1]
        }): ${msg}`
      );
      stats.errors += articles.length;
      return;
    }
  } else {
    // Text-only batch: still stamp scanRequestedAt so the article's ingestion
    // state gets recomputed (it may already be Scanned from text moderation).
    await dbWrite.article.updateMany({
      where: { id: { in: batchIds } },
      data: { scanRequestedAt: new Date() },
    });
  }

  // Recompute every article in the batch. Articles with images flip to
  // Pending (webhook recomputes them back to Scanned once scans complete);
  // text-only articles stay wherever their text-moderation state puts them.
  const recomputeTasks = batchIds.map((articleId) => async () => {
    try {
      await recomputeArticleIngestion(articleId);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      log(`  ⚠️  recomputeArticleIngestion failed for article ${articleId}: ${msg}`);
      stats.errors++;
    }
  });
  await limitConcurrency(recomputeTasks, concurrency);

  stats.articlesProcessed += articles.length;
}

async function fetchArticleBatch(
  start: number,
  end: number,
  cancelFns: (() => Promise<void>)[]
): Promise<Article[]> {
  // Unprocessed = Published + has content + no Article ImageConnection yet.
  // Uses cancellableQuery so a client disconnect kills the in-flight pg query
  // (dataProcessor calls all registered cancelFns from its `close` handler).
  const query = await pgDbRead.cancellableQuery<Article>(Prisma.sql`
    SELECT a.id, a.content, a."userId"
    FROM "Article" a
    LEFT JOIN "ImageConnection" ic ON ic."entityId" = a.id AND ic."entityType" = 'Article'
    WHERE a.id >= ${start} AND a.id <= ${end}
      AND a.status = ${ArticleStatus.Published}::"ArticleStatus"
      AND a.content != ''
      AND ic."imageId" IS NULL
    ORDER BY a.id ASC
  `);
  cancelFns.push(query.cancel);
  return query.result();
}

type MigrationResult = MigrationStats & {
  /** Highest article ID range end reached. Useful for resuming via `?start=` if the run was aborted. */
  lastProcessedEnd: number;
};

async function runMigration(
  params: MigrationParams,
  runContext: RunContext
): Promise<MigrationResult> {
  const stats: MigrationStats = {
    articlesProcessed: 0,
    imagesCreated: 0,
    connectionsCreated: 0,
    errors: 0,
  };
  let lastProcessedEnd = params.start;
  const startTime = Date.now();

  log(`Running migration${params.dryRun ? ' (DRY RUN)' : ''}...`);

  await dataProcessor({
    params,
    runContext,
    rangeFetcher: async ({ cancelFns }) => {
      // Cap the iteration at the largest unprocessed article ID so we don't
      // walk dead ID space past the corpus tail.
      const query = await pgDbRead.cancellableQuery<{ max: number }>(Prisma.sql`
        SELECT MAX(a.id) "max" FROM "Article" a
        LEFT JOIN "ImageConnection" ic ON ic."entityId" = a.id AND ic."entityType" = 'Article'
        WHERE a.status = ${ArticleStatus.Published}::"ArticleStatus"
          AND a.content != ''
          AND ic."imageId" IS NULL
      `);
      cancelFns.push(query.cancel);
      const [{ max }] = await query.result();
      const range = { start: params.start, end: params.end ?? max ?? 0 };
      const rangeSize = Math.max(range.end - range.start + 1, 0);
      const batches = Math.ceil(rangeSize / params.batchSize);
      log(`Range: ${range.start}-${range.end} (${rangeSize} ids, ~${batches} batches)`);
      return range;
    },
    processor: async ({ start, end, cancelFns }) => {
      const articles = await fetchArticleBatch(start, end, cancelFns);
      if (articles.length === 0) return;

      await processBatch(articles, params.dryRun, params.concurrency, stats);

      if (end > lastProcessedEnd) lastProcessedEnd = end;

      const elapsedSec = (Date.now() - startTime) / 1000;
      const rate = stats.articlesProcessed / Math.max(elapsedSec, 0.001);
      log(
        `[batch ${start}-${end}] ${articles.length} articles | ` +
          `totals: ${stats.articlesProcessed} processed, ${stats.imagesCreated} images, ` +
          `${stats.connectionsCreated} connections, ${stats.errors} errors | ` +
          `${rate.toFixed(1)}/s | elapsed: ${elapsedSec.toFixed(1)}s`
      );
    },
  });

  return { ...stats, lastProcessedEnd };
}

// --- Main Handler ---

export default WebhookEndpoint(async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: z.treeifyError(parsed.error) });
  }
  const params = parsed.data;
  const startTime = Date.now();

  try {
    if (params.rollback) {
      const result = await runRollback(params);
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      log(`Rollback completed in ${duration}s`);
      return res.status(200).json({
        ok: true,
        mode: 'rollback',
        dryRun: params.dryRun,
        duration: `${duration}s`,
        result,
      });
    }

    if (params.reconcile) {
      const result = await runReconcile(params);
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      log(`Reconcile completed in ${duration}s`);
      return res.status(200).json({
        ok: true,
        mode: 'reconcile',
        dryRun: params.dryRun,
        duration: `${duration}s`,
        result,
      });
    }

    log(
      `Starting migration${params.dryRun ? ' (DRY RUN)' : ''} with ` +
        `batchSize=${params.batchSize}, concurrency=${params.concurrency}, start=${params.start}`
    );

    const { lastProcessedEnd, ...stats } = await runMigration(params, res);

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    log(`Migration completed in ${duration}s (lastProcessedEnd=${lastProcessedEnd}).`);

    res.status(200).json({
      ok: true,
      dryRun: params.dryRun,
      duration: `${duration}s`,
      lastProcessedEnd,
      result: stats,
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
