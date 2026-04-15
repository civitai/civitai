import { ArticleStatus, Prisma } from '@prisma/client';
import * as z from 'zod';
import { dbWrite } from '~/server/db/client';
import { pgDbRead } from '~/server/db/pgDb';
import { dataProcessor } from '~/server/db/db-helpers';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { createLogger } from '~/utils/logging';
import { booleanString } from '~/utils/zod-helpers';
import { getContentMedia } from '~/server/services/article-content-cleanup.service';
import type { ExtractedMedia } from '~/utils/article-helpers';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import { ImageConnectionType } from '~/server/common/enums';
import { recomputeArticleIngestion } from '~/server/services/article.service';
import { updateArticleNsfwLevels } from '~/server/services/nsfwLevels.service';
import { createImageIngestionRequest } from '~/server/services/orchestrator/orchestrator.service';
import {
  processImageScanWorkflow,
  type ScanResultStep,
} from '~/server/services/image-scan-result.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';

const log = createLogger('migrate-article-images', 'blue');

// --- Types ---

type MigrationStats = {
  articlesProcessed: number;
  imagesCreated: number;
  connectionsCreated: number;
  imagesScanned: number;
  imagesFailed: number;
  errors: string[];
};

type Article = { id: number; title: string; content: string; userId: number };

type RunContext = {
  on: (event: 'close', listener: () => void) => void;
};

const querySchema = z.object({
  dryRun: booleanString().default(true),
  rollback: booleanString().default(false),
  batchSize: z.coerce.number().min(1).max(1000).default(100),
  concurrency: z.coerce.number().min(1).max(5).default(2),
  scanConcurrency: z.coerce.number().min(1).max(10).default(5),
  start: z.coerce.number().optional().default(0),
  end: z.coerce.number().optional(),
  after: z.coerce.date().optional(),
  before: z.coerce.date().optional(),
});

type MigrationParams = z.infer<typeof querySchema>;

// --- Helpers ---

function createEmptyStats(): MigrationStats {
  return {
    articlesProcessed: 0,
    imagesCreated: 0,
    connectionsCreated: 0,
    imagesScanned: 0,
    imagesFailed: 0,
    errors: [],
  };
}

function mergeStats(statsList: MigrationStats[]): MigrationStats {
  const merged = createEmptyStats();
  for (const stats of statsList) {
    merged.articlesProcessed += stats.articlesProcessed;
    merged.imagesCreated += stats.imagesCreated;
    merged.connectionsCreated += stats.connectionsCreated;
    merged.imagesScanned += stats.imagesScanned;
    merged.imagesFailed += stats.imagesFailed;
    merged.errors.push(...stats.errors);
  }
  return merged;
}

type CancelFn = () => Promise<void>;

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

/**
 * Submit an image for scanning with wait, then process the result inline.
 * Returns true if the scan completed and was processed, false otherwise.
 */
async function scanImageInline(image: { id: number; url: string; type: 'image' | 'video' }) {
  const workflow = await createImageIngestionRequest({
    imageId: image.id,
    url: image.url,
    priority: 'low',
    type: image.type,
    wait: 30,
  });

  if (!workflow?.id) {
    throw new Error(`Image ${image.id}: no workflow returned`);
  }

  const steps = (workflow.steps ?? []) as unknown as ScanResultStep[];
  const hasOutput = steps.some((s) => 'output' in s && s.output);

  if (!hasOutput) {
    throw new Error(
      `Image ${image.id}: workflow ${workflow.id} did not complete within wait window`
    );
  }

  await processImageScanWorkflow({
    workflowId: workflow.id,
    status: 'succeeded',
    steps,
    imageId: image.id,
  });
}

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

  // Step 2: Find which images are ONLY connected to articles (safe to delete)
  const sharedImages = await dbWrite.$queryRaw<{ imageId: number }[]>`
    SELECT DISTINCT "imageId"
    FROM "ImageConnection"
    WHERE "imageId" IN (${Prisma.join(imageIds)})
    AND "entityType" != 'Article'
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

// --- Image Scan Mode ---

async function runImageScan(
  params: MigrationParams,
  runContext: RunContext
): Promise<MigrationStats> {
  const { dryRun } = params;
  const batchResults: MigrationStats[] = [];
  let aborted = false;
  let batchNumber = 0;
  const startTime = Date.now();

  log(`Running image scan mode${dryRun ? ' (DRY RUN)' : ''}...`);

  await dataProcessor({
    params,
    runContext,
    rangeFetcher: async ({ cancelFns }) => {
      if (params.after || params.before) return fetchDateRange(params, cancelFns);

      // Find articles that haven't had their content images extracted yet
      // (no ImageConnection rows for the Article entity type)
      const query = await pgDbRead.cancellableQuery<{ max: number }>(
        Prisma.sql`SELECT MAX(a.id) "max" FROM "Article" a
        LEFT JOIN "ImageConnection" ic ON ic."entityId" = a.id AND ic."entityType" = 'Article'
        WHERE a.status = ${ArticleStatus.Published}::"ArticleStatus"
        AND a.content != ''
        AND ic."imageId" IS NULL`
      );
      cancelFns.push(query.cancel);
      const [{ max }] = await query.result();
      const range = { start: params.start, end: params.end ?? max ?? 0 };
      const rangeSize = Math.max(range.end - range.start + 1, 0);
      const batches = Math.ceil(rangeSize / params.batchSize);
      log(`Range: ${range.start}-${range.end} (${rangeSize} ids, ~${batches} batches)`);
      return range;
    },
    processor: async ({ start, end }) => {
      if (aborted) return;

      const batchStart = Date.now();
      const stats = createEmptyStats();

      // Don't push cancel to shared cancelFns — resolved query closures retain
      // references to result data (article content), causing OOM over many batches.
      // The dataProcessor's stop flag handles disconnection for in-flight work.
      const articlesQuery = await pgDbRead.cancellableQuery<Article>(
        Prisma.sql`
          SELECT a.id, a.title, a.content, a."userId"
          FROM "Article" a
          LEFT JOIN "ImageConnection" ic ON ic."entityId" = a.id AND ic."entityType" = 'Article'
          WHERE a.id >= ${start} AND a.id <= ${end}
          AND a.status = ${ArticleStatus.Published}::"ArticleStatus"
          AND a.content != ''
          AND ic."imageId" IS NULL
          ORDER BY a.id ASC
        `
      );
      const articleBatch = await articlesQuery.result();

      if (articleBatch.length === 0) return;

      log(`[images] Processing ${articleBatch.length} articles (IDs ${start}-${end})...`);

      if (dryRun) {
        for (const article of articleBatch) {
          const contentMedia = getContentMedia(article.content);
          log(`[DRY RUN] Article ${article.id}: ${contentMedia.length} media items`);
          stats.imagesCreated += contentMedia.length;
          stats.connectionsCreated += contentMedia.length;
          stats.articlesProcessed++;
        }
        batchResults.push(stats);
        return;
      }

      const articleMediaMap = new Map<number, { media: ExtractedMedia[]; userId: number }>();
      const allUrls = new Set<string>();
      const failedArticleIds = new Set<number>();

      for (const article of articleBatch) {
        try {
          const contentMedia = getContentMedia(article.content);
          if (contentMedia.length === 0) {
            stats.articlesProcessed++;
            continue;
          }
          articleMediaMap.set(article.id, { media: contentMedia, userId: article.userId });
          contentMedia.forEach((media) => allUrls.add(media.url));
        } catch (error) {
          const msg = error instanceof Error ? error.message : 'Unknown error';
          stats.errors.push(`Article ${article.id} extraction: ${msg}`);
          failedArticleIds.add(article.id);
        }
      }

      // Track images created in this batch so we can scan them after the transaction
      const createdImageIds: { id: number; url: string; type: 'image' | 'video' }[] = [];

      if (articleMediaMap.size > 0) {
        log(`Extracted ${allUrls.size} unique URLs from ${articleMediaMap.size} articles`);

        try {
          await dbWrite.$transaction(
            async (tx) => {
              const existingImages = await tx.image.findMany({
                where: { url: { in: Array.from(allUrls) } },
                select: { id: true, url: true, ingestion: true },
              });

              const existingUrlMap = new Map(existingImages.map((img) => [img.url, img]));
              const missingUrlSet = new Set(
                Array.from(allUrls).filter((url) => !existingUrlMap.has(url))
              );

              if (missingUrlSet.size > 0) {
                const mediaByUrl = new Map<
                  string,
                  { type: 'image' | 'video'; userId: number; name?: string }
                >();

                for (const [, { media, userId }] of articleMediaMap) {
                  for (const item of media) {
                    if (missingUrlSet.has(item.url) && !mediaByUrl.has(item.url)) {
                      mediaByUrl.set(item.url, { type: item.type, userId, name: item.alt });
                    }
                  }
                }

                const createdImages = await tx.image.createManyAndReturn({
                  data: Array.from(mediaByUrl.entries()).map(([url, { type, userId, name }]) => ({
                    url,
                    userId,
                    type,
                    name,
                    ingestion: ImageIngestionStatus.Pending,
                    scanRequestedAt: new Date(),
                  })),
                  select: { id: true, url: true },
                  skipDuplicates: true,
                });

                for (const img of createdImages) {
                  existingUrlMap.set(img.url, { ...img, ingestion: ImageIngestionStatus.Pending });
                  const mediaInfo = mediaByUrl.get(img.url);
                  createdImageIds.push({
                    id: img.id,
                    url: img.url,
                    type: mediaInfo?.type ?? 'image',
                  });
                }
                stats.imagesCreated += createdImages.length;
              }

              // Also collect existing images that are still Pending (not yet scanned)
              for (const [, img] of existingUrlMap) {
                if (
                  'ingestion' in img &&
                  img.ingestion === ImageIngestionStatus.Pending &&
                  !createdImageIds.some((c) => c.id === img.id)
                ) {
                  // Find the type from article media data
                  for (const [, { media }] of articleMediaMap) {
                    const match = media.find((m) => m.url === img.url);
                    if (match) {
                      createdImageIds.push({ id: img.id, url: img.url, type: match.type });
                      break;
                    }
                  }
                }
              }

              const allConnections: Array<{
                imageId: number;
                entityType: ImageConnectionType.Article;
                entityId: number;
              }> = [];

              for (const [articleId, { media }] of articleMediaMap) {
                for (const item of media) {
                  const existing = existingUrlMap.get(item.url);
                  if (existing) {
                    allConnections.push({
                      imageId: existing.id,
                      entityType: ImageConnectionType.Article,
                      entityId: articleId,
                    });
                  }
                }
              }

              if (allConnections.length > 0) {
                await tx.imageConnection.createMany({
                  data: allConnections,
                  skipDuplicates: true,
                });
                stats.connectionsCreated += allConnections.length;
              }

              stats.articlesProcessed += articleMediaMap.size;

              const processedArticleIds = Array.from(articleMediaMap.keys());
              if (processedArticleIds.length > 0) {
                await tx.article.updateMany({
                  where: { id: { in: processedArticleIds } },
                  data: { scanRequestedAt: new Date() },
                });
              }
            },
            { timeout: 60000, maxWait: 10000 }
          );

          log(
            `  Transaction complete: ${stats.imagesCreated} images, ${stats.connectionsCreated} connections`
          );

          // Scan images inline with wait
          if (createdImageIds.length > 0) {
            log(`  Scanning ${createdImageIds.length} images inline...`);
            const scanTasks = createdImageIds.map((img) => async () => {
              try {
                await scanImageInline(img);
                stats.imagesScanned++;
              } catch (error) {
                const msg = error instanceof Error ? error.message : 'Unknown error';
                log(`  ⚠️  Image ${img.id} scan: ${msg}`);
                stats.imagesFailed++;
                stats.errors.push(`Image ${img.id} scan: ${msg}`);
              }
            });
            await limitConcurrency(scanTasks, params.scanConcurrency);

            // Abort early if all image scans failed (e.g. orchestrator down)
            if (stats.imagesFailed === createdImageIds.length && createdImageIds.length > 0) {
              log(
                `  All ${createdImageIds.length} image scans failed — aborting. Sample: ${
                  stats.errors[stats.errors.length - 1]
                }`
              );
              aborted = true;
            }

            log(
              `  Image scanning complete: ${stats.imagesScanned} scanned, ${stats.imagesFailed} failed`
            );
          }

          const processedArticleIds = Array.from(articleMediaMap.keys());

          // Propagate image NSFW levels up to the article (mirrors webhook path
          // via updateArticleImageScanStatus). Single bulk SQL update.
          if (processedArticleIds.length > 0) {
            try {
              await updateArticleNsfwLevels(processedArticleIds);
            } catch (error) {
              const msg = error instanceof Error ? error.message : 'Unknown error';
              log(`  ⚠️  updateArticleNsfwLevels failed: ${msg}`);
              stats.errors.push(`updateArticleNsfwLevels: ${msg}`);
            }
          }

          // Recompute ingestion status for each processed article
          const recomputeTasks = processedArticleIds.map((articleId) => async () => {
            try {
              await recomputeArticleIngestion(articleId);
            } catch (error) {
              const msg = error instanceof Error ? error.message : 'Unknown error';
              log(`  ⚠️  recomputeArticleIngestion failed for article ${articleId}: ${msg}`);
            }
          });
          await limitConcurrency(recomputeTasks, params.scanConcurrency);
        } catch (error) {
          const msg = error instanceof Error ? error.message : 'Unknown error';
          log(`❌ Batch transaction failed: ${msg}`);
          stats.errors.push(`Batch transaction failed: ${msg}`);
        }
      }

      // Mark articles without images and recompute their ingestion status
      const articlesWithoutImages = articleBatch.filter(
        (article) => !articleMediaMap.has(article.id) && !failedArticleIds.has(article.id)
      );
      if (articlesWithoutImages.length > 0) {
        const ids = articlesWithoutImages.map((a) => a.id);
        try {
          await dbWrite.article.updateMany({
            where: { id: { in: ids } },
            data: { scanRequestedAt: new Date() },
          });
        } catch (error) {
          log(
            `  ⚠️  Failed to mark ${articlesWithoutImages.length} articles: ${
              error instanceof Error ? error.message : 'Unknown error'
            }`
          );
        }

        const recomputeTasks = ids.map((articleId) => async () => {
          try {
            await recomputeArticleIngestion(articleId);
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Unknown error';
            log(`  ⚠️  recomputeArticleIngestion failed for article ${articleId}: ${msg}`);
          }
        });
        await limitConcurrency(recomputeTasks, params.scanConcurrency);
      }

      batchResults.push(stats);
      batchNumber++;

      const cumulative = mergeStats(batchResults);
      const elapsedSec = (Date.now() - startTime) / 1000;
      const rate = cumulative.articlesProcessed / Math.max(elapsedSec, 0.001);

      log(
        `[batch ${batchNumber}] Complete in ${Date.now() - batchStart}ms | ` +
          `batch: ${stats.articlesProcessed} articles, ${stats.imagesCreated} images created, ${stats.imagesScanned} scanned, ${stats.imagesFailed} scan failures | ` +
          `totals: ${cumulative.articlesProcessed} articles, ${cumulative.imagesCreated} images, ${cumulative.connectionsCreated} connections, ${cumulative.imagesScanned} scanned, ${cumulative.imagesFailed} scan failures, ${cumulative.errors.length} errors | ` +
          `rate: ${rate.toFixed(1)} articles/s | elapsed: ${elapsedSec.toFixed(1)}s`
      );
    },
  });

  return mergeStats(batchResults);
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
    `Starting article image scan${params.dryRun ? ' (DRY RUN)' : ''} with batchSize ${
      params.batchSize
    }, concurrency ${params.concurrency}, scanConcurrency ${params.scanConcurrency}`
  );

  try {
    if (params.rollback) {
      const rollbackResult = await runRollback(params);
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      log(`Rollback completed in ${duration}s`);

      return res.status(200).json({
        ok: true,
        mode: 'rollback',
        dryRun: params.dryRun,
        duration: `${duration}s`,
        result: rollbackResult,
      });
    }

    const aggregated = await runImageScan(params, res);
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    log(`Process completed successfully in ${duration}s`);

    res.status(200).json({
      ok: true,
      dryRun: params.dryRun,
      duration: `${duration}s`,
      result: {
        articlesProcessed: aggregated.articlesProcessed,
        imagesCreated: aggregated.imagesCreated,
        connectionsCreated: aggregated.connectionsCreated,
        imagesScanned: aggregated.imagesScanned,
        imagesFailed: aggregated.imagesFailed,
        errorCount: aggregated.errors.length,
        errorsSample: aggregated.errors.slice(0, 10),
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
