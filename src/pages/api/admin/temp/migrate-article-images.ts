import { ArticleStatus, Prisma } from '@prisma/client';
import * as z from 'zod';
import { dbWrite } from '~/server/db/client';
import { dataProcessor } from '~/server/db/db-helpers';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { createLogger } from '~/utils/logging';
import { booleanString } from '~/utils/zod-helpers';
import { getContentMedia } from '~/server/services/article-content-cleanup.service';
import type { ExtractedMedia } from '~/utils/article-helpers';
import { ArticleIngestionStatus, ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import { ImageConnectionType } from '~/server/common/enums';
import { recomputeArticleIngestion } from '~/server/services/article.service';

const log = createLogger('migrate-article-images', 'blue');

// --- Types ---

type MigrationStats = {
  articlesProcessed: number;
  imagesCreated: number;
  connectionsCreated: number;
  errors: string[];
};

type Article = { id: number; title: string; content: string; userId: number };

type RunContext = {
  on: (event: 'close', listener: () => void) => void;
};

const querySchema = z.object({
  dryRun: booleanString().default(true),
  batchSize: z.coerce.number().min(1).max(1000).default(100),
  concurrency: z.coerce.number().min(1).max(5).default(2),
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
    errors: [],
  };
}

function mergeStats(statsList: MigrationStats[]): MigrationStats {
  const merged = createEmptyStats();
  for (const stats of statsList) {
    merged.articlesProcessed += stats.articlesProcessed;
    merged.imagesCreated += stats.imagesCreated;
    merged.connectionsCreated += stats.connectionsCreated;
    merged.errors.push(...stats.errors);
  }
  return merged;
}

async function fetchDateRange(params: MigrationParams) {
  const results = await dbWrite.$queryRaw<{ start: number; end: number }[]>`
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
  `;
  return results[0];
}

// --- Image Scan Mode ---

async function runImageScan(
  params: MigrationParams,
  runContext: RunContext
): Promise<MigrationStats> {
  const { dryRun } = params;
  const batchResults: MigrationStats[] = [];

  log(`Running image scan mode${dryRun ? ' (DRY RUN)' : ''}...`);

  await dataProcessor({
    params,
    runContext,
    rangeFetcher: async () => {
      if (params.after || params.before) return fetchDateRange(params);

      const [{ max }] = await dbWrite.$queryRaw<{ max: number }[]>(
        Prisma.sql`SELECT MAX(id) "max" FROM "Article"
        WHERE status = ${ArticleStatus.Published}::"ArticleStatus"
        AND content != ''
        AND "contentScannedAt" IS NULL`
      );
      return { start: params.start, end: params.end ?? max ?? 0 };
    },
    processor: async ({ start, end }) => {
      const batchStart = Date.now();
      const stats = createEmptyStats();

      const articleBatch = await dbWrite.$queryRaw<Article[]>(
        Prisma.sql`
          SELECT a.id, a.title, a.content, a."userId"
          FROM "Article" a
          WHERE a.id >= ${start} AND a.id <= ${end}
          AND a.status = ${ArticleStatus.Published}::"ArticleStatus"
          AND a.content != ''
          AND a."contentScannedAt" IS NULL
          ORDER BY a.id ASC
        `
      );

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

      if (articleMediaMap.size > 0) {
        log(`Extracted ${allUrls.size} unique URLs from ${articleMediaMap.size} articles`);

        try {
          await dbWrite.$transaction(
            async (tx) => {
              const existingImages = await tx.image.findMany({
                where: { url: { in: Array.from(allUrls) } },
                select: { id: true, url: true },
              });

              const existingUrlMap = new Map(existingImages.map((img) => [img.url, img.id]));
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

                createdImages.forEach((img) => existingUrlMap.set(img.url, img.id));
                stats.imagesCreated = createdImages.length;
              }

              const allConnections: Array<{
                imageId: number;
                entityType: ImageConnectionType.Article;
                entityId: number;
              }> = [];

              for (const [articleId, { media }] of articleMediaMap) {
                for (const item of media) {
                  const imageId = existingUrlMap.get(item.url);
                  if (imageId) {
                    allConnections.push({
                      imageId,
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
                stats.connectionsCreated = allConnections.length;
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

          // Recompute ingestion status for each processed article
          for (const articleId of articleMediaMap.keys()) {
            try {
              await recomputeArticleIngestion(articleId);
            } catch (error) {
              const msg = error instanceof Error ? error.message : 'Unknown error';
              log(`⚠️  recomputeArticleIngestion failed for article ${articleId}: ${msg}`);
            }
          }

          log(
            `  Transaction complete: ${stats.imagesCreated} images, ${stats.connectionsCreated} connections`
          );
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
            `⚠️  Failed to mark ${articlesWithoutImages.length} articles: ${
              error instanceof Error ? error.message : 'Unknown error'
            }`
          );
        }

        for (const articleId of ids) {
          try {
            await recomputeArticleIngestion(articleId);
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Unknown error';
            log(`⚠️  recomputeArticleIngestion failed for article ${articleId}: ${msg}`);
          }
        }
      }

      log(`[images] Batch complete (${Date.now() - batchStart}ms)`);
      batchResults.push(stats);
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
    }, concurrency ${params.concurrency}`
  );

  try {
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
