import { ArticleStatus, Prisma } from '@prisma/client';
import * as z from 'zod';
import { dbWrite } from '~/server/db/client';
import { dataProcessor } from '~/server/db/db-helpers';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { createLogger } from '~/utils/logging';
import { booleanString } from '~/utils/zod-helpers';
import { extractImagesFromArticle } from '~/server/utils/article-image-helpers';
import { ingestImage } from '~/server/services/image.service';
import type { ExtractedMedia } from '~/utils/article-helpers';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import type { MediaType } from '~/shared/utils/prisma/enums';
import { ImageConnectionType } from '~/server/common/enums';

const log = createLogger('migrate-article-images', 'blue');

const querySchema = z.object({
  dryRun: booleanString().default(true),
  batchSize: z.coerce.number().min(1).max(1000).default(100),
  concurrency: z.coerce.number().min(1).max(5).default(2),
  start: z.coerce.number().optional().default(0),
  end: z.coerce.number().optional(),
  after: z.coerce.date().optional(),
  before: z.coerce.date().optional(),
});

export default WebhookEndpoint(async (req, res) => {
  const result = querySchema.safeParse(req.query);
  if (!result.success) {
    return res.status(400).json({ ok: false, error: z.treeifyError(result.error) });
  }

  const params = result.data;
  const { dryRun, concurrency, batchSize } = params;
  const startTime = Date.now();

  log(
    `Starting article image migration process${
      dryRun ? ' (DRY RUN)' : ''
    } with batchSize ${batchSize}, concurrency ${concurrency}`
  );

  const aggregatedStats = {
    articlesProcessed: 0,
    imagesCreated: 0,
    connectionsCreated: 0,
    errors: [] as string[],
  };

  try {
    await dataProcessor({
      params,
      runContext: res,
      rangeFetcher: async () => {
        // Support date-based range filtering
        if (params.after || params.before) {
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

        // Get min/max article IDs that need processing
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

        // Fetch articles by ID range
        const articleBatch = await dbWrite.article.findMany({
          where: {
            id: { gte: start, lte: end },
            status: ArticleStatus.Published,
            content: { not: '' },
            contentScannedAt: null,
          },
          select: {
            id: true,
            content: true,
            userId: true,
          },
          orderBy: { id: 'asc' },
        });

        if (articleBatch.length === 0) {
          console.log(`No articles found in range ${start}-${end}`);
          return;
        }

        log(`Processing ${articleBatch.length} articles (IDs ${start}-${end})...`);

        const batchStats = {
          articlesProcessed: 0,
          imagesCreated: 0,
          connectionsCreated: 0,
          errors: [] as string[],
        };

        if (dryRun) {
          // Dry run: just count without processing
          for (const article of articleBatch) {
            const contentMedia = extractImagesFromArticle(article.content);
            log(`[DRY RUN] Article ${article.id}: ${contentMedia.length} media items`);
            batchStats.articlesProcessed++;
            batchStats.imagesCreated += contentMedia.length;
            batchStats.connectionsCreated += contentMedia.length;
          }
        } else {
          // Extract all media from batch (in-memory)
          const articleMediaMap = new Map<number, { media: ExtractedMedia[]; userId: number }>();
          const allUrls = new Set<string>();

          for (const article of articleBatch) {
            try {
              const contentMedia = extractImagesFromArticle(article.content);

              if (contentMedia.length === 0) {
                batchStats.articlesProcessed++;
                continue;
              }

              articleMediaMap.set(article.id, {
                media: contentMedia,
                userId: article.userId,
              });

              contentMedia.forEach((media) => allUrls.add(media.url));
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : 'Unknown error';
              batchStats.errors.push(`Article ${article.id} extraction: ${errorMessage}`);
            }
          }

          if (articleMediaMap.size > 0) {
            log(`Extracted ${allUrls.size} unique URLs from ${articleMediaMap.size} articles`);

            // Process batch in single transaction
            let newImages: Array<{ id: number; url: string; type: MediaType }> = [];
            try {
              const transactionResult = await dbWrite.$transaction(
                async (tx) => {
                  // Fetch existing images
                  const existingImages = await tx.image.findMany({
                    where: { url: { in: Array.from(allUrls) } },
                    select: { id: true, url: true },
                  });

                  const existingUrlMap = new Map(existingImages.map((img) => [img.url, img.id]));

                  // Create missing images
                  const missingUrls = Array.from(allUrls).filter((url) => !existingUrlMap.has(url));

                  let createdImages: Array<{ id: number; url: string; type: MediaType }> = [];
                  if (missingUrls.length > 0) {
                    const mediaByUrl = new Map<
                      string,
                      { type: 'image' | 'video'; userId: number; name?: string }
                    >();

                    for (const [, { media, userId }] of articleMediaMap) {
                      for (const item of media) {
                        if (missingUrls.includes(item.url) && !mediaByUrl.has(item.url)) {
                          mediaByUrl.set(item.url, { type: item.type, userId, name: item.alt });
                        }
                      }
                    }

                    createdImages = await tx.image.createManyAndReturn({
                      data: Array.from(mediaByUrl.entries()).map(
                        ([url, { type, userId, name }]) => ({
                          url,
                          userId,
                          type,
                          name,
                          ingestion: ImageIngestionStatus.Pending,
                          scanRequestedAt: new Date(),
                        })
                      ),
                      select: { id: true, url: true, type: true },
                      skipDuplicates: true,
                    });

                    createdImages.forEach((img) => {
                      existingUrlMap.set(img.url, img.id);
                    });

                    batchStats.imagesCreated += createdImages.length;
                  }

                  // Create connections
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

                    batchStats.connectionsCreated += allConnections.length;
                  }

                  batchStats.articlesProcessed += articleMediaMap.size;

                  // Mark processed articles
                  const processedArticleIds = Array.from(articleMediaMap.keys());
                  if (processedArticleIds.length > 0) {
                    await tx.article.updateMany({
                      where: { id: { in: processedArticleIds } },
                      data: { contentScannedAt: new Date() },
                    });
                  }

                  return { newImages: createdImages };
                },
                { timeout: 60000, maxWait: 10000 }
              );

              newImages = transactionResult.newImages;

              log(
                `  Transaction complete: ${batchStats.imagesCreated} images, ${batchStats.connectionsCreated} connections`
              );

              // Queue images for ingestion AFTER transaction commits
              // This prevents race conditions where webhooks fire before the transaction commits
              if (newImages.length > 0) {
                log(`  Queueing ${newImages.length} images for scanning...`);
                for (const img of newImages) {
                  await ingestImage({
                    image: img,
                    lowPriority: true,
                    userId: 4, // System user
                  }).catch((error) => {
                    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                    log(`⚠️  Failed to queue image ${img.id}: ${errorMessage}`);
                  });
                }
              }
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : 'Unknown error';
              const errorMsg = `Batch transaction failed: ${errorMessage}`;
              log(`❌ ${errorMsg}`);
              batchStats.errors.push(errorMsg);
            }
          }

          // Mark articles without images as scanned
          const articlesWithoutImages = articleBatch.filter(
            (article) => !articleMediaMap.has(article.id)
          );
          if (articlesWithoutImages.length > 0) {
            await dbWrite.article
              .updateMany({
                where: { id: { in: articlesWithoutImages.map((a) => a.id) } },
                data: { contentScannedAt: new Date() },
              })
              .catch((error) => {
                log(
                  `⚠️  Failed to mark ${articlesWithoutImages.length} articles: ${
                    error instanceof Error ? error.message : 'Unknown error'
                  }`
                );
              });
          }
        }

        // Aggregate stats
        aggregatedStats.articlesProcessed += batchStats.articlesProcessed;
        aggregatedStats.imagesCreated += batchStats.imagesCreated;
        aggregatedStats.connectionsCreated += batchStats.connectionsCreated;
        aggregatedStats.errors.push(...batchStats.errors);

        log(
          `Batch complete: ${batchStats.articlesProcessed} articles (${Date.now() - batchStart}ms)`
        );
      },
    });

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    log(`Process completed successfully in ${duration}s`);

    res.status(200).json({
      ok: true,
      dryRun,
      duration: `${duration}s`,
      result: {
        articlesProcessed: aggregatedStats.articlesProcessed,
        imagesCreated: aggregatedStats.imagesCreated,
        connectionsCreated: aggregatedStats.connectionsCreated,
        errorCount: aggregatedStats.errors.length,
        errorsSample: aggregatedStats.errors.slice(0, 10),
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
