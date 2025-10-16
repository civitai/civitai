import { ArticleStatus } from '@prisma/client';
import * as z from 'zod';
import { dbWrite } from '~/server/db/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { createLogger } from '~/utils/logging';
import { booleanString } from '~/utils/zod-helpers';
import { Limiter } from '~/server/utils/concurrency-helpers';
import { extractImagesFromArticle } from '~/server/utils/article-image-helpers';
import { ingestImageBulk } from '~/server/services/image.service';
import type { ExtractedMedia } from '~/utils/article-helpers';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

const log = createLogger('migrate-article-images', 'blue');

const querySchema = z.object({
  dryRun: booleanString().default(true),
  batchSize: z.coerce.number().min(1).max(1000).default(100),
  concurrency: z.coerce.number().min(1).max(5).default(2),
});

export default WebhookEndpoint(async (req, res) => {
  const result = querySchema.safeParse(req.query);
  if (!result.success) {
    return res.status(400).json({ ok: false, error: z.treeifyError(result.error) });
  }

  const { dryRun, concurrency, batchSize } = result.data;
  const startTime = Date.now();

  log(
    `Starting article image migration process${
      dryRun ? ' (DRY RUN)' : ''
    } with concurrency ${concurrency}`
  );

  // Step 1: Find all articles with content
  const step1Start = Date.now();
  log('Step 1: Finding articles with content...');

  const totalArticles = await dbWrite.article.findMany({
    where: {
      status: ArticleStatus.Published,
      content: { not: '' },
      contentScannedAt: null, // Only process articles that haven't been scanned yet
    },
    select: {
      id: true,
      content: true,
      userId: true,
    },
    orderBy: { id: 'asc' },
  });

  log(`Step 1: Found ${totalArticles.length} articles to process (${Date.now() - step1Start}ms)`);

  if (totalArticles.length === 0) {
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    log(`Process completed successfully in ${duration}s`);

    return res.status(200).json({
      ok: true,
      dryRun,
      duration: `${duration}s`,
      result: {
        articlesProcessed: 0,
        imagesCreated: 0,
        connectionsCreated: 0,
        errors: [],
        message: 'No articles found to migrate',
      },
    });
  }

  try {
    // Step 2: Fetch all articles and let Limiter handle batching and concurrency
    const step2Start = Date.now();
    log(`Step 2: Processing ${totalArticles.length} articles with concurrency ${concurrency}...`);

    // Process all articles with Limiter handling batching and concurrency
    // Each batch is processed in a SINGLE transaction for better performance
    const allBatchResults = await Limiter({ limit: concurrency, batchSize }).process(
      totalArticles,
      async (articleBatch) => {
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
          return batchStats;
        }

        // Step 2a: Extract all media from all articles in batch (in-memory)
        const step2aStart = Date.now();
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

            // Collect all unique URLs across the batch
            contentMedia.forEach((media) => allUrls.add(media.url));
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            batchStats.errors.push(`Article ${article.id} extraction: ${errorMessage}`);
          }
        }

        if (articleMediaMap.size === 0) {
          return batchStats; // No articles with media in this batch
        }

        log(
          `  Step 2a: Extracted ${allUrls.size} unique URLs from ${
            articleMediaMap.size
          } articles (${Date.now() - step2aStart}ms)`
        );

        // Step 2b: Process entire batch in single transaction
        const step2bStart = Date.now();
        try {
          await dbWrite.$transaction(
            async (tx) => {
              // Fetch all existing images for the batch in one query
              const existingImages = await tx.image.findMany({
                where: { url: { in: Array.from(allUrls) } },
                select: { id: true, url: true },
              });

              const existingUrlMap = new Map(existingImages.map((img) => [img.url, img.id]));

              // Determine which images need to be created (deduplicated)
              const missingUrls = Array.from(allUrls).filter((url) => !existingUrlMap.has(url));

              // Create all missing images in one operation
              if (missingUrls.length > 0) {
                // Group by userId to create images with correct ownership
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

                const newImages = await tx.image.createManyAndReturn({
                  data: Array.from(mediaByUrl.entries()).map(([url, { type, userId, name }]) => ({
                    url,
                    userId,
                    type,
                    name,
                    ingestion: ImageIngestionStatus.Pending,
                    scanRequestedAt: new Date(),
                  })),
                  select: { id: true, url: true, type: true },
                  skipDuplicates: true,
                });

                newImages.forEach((img) => {
                  existingUrlMap.set(img.url, img.id);
                });

                batchStats.imagesCreated += newImages.length;

                // Queue all newly created images for ingestion in one call
                if (newImages.length > 0) {
                  await ingestImageBulk({
                    images: newImages.map((img) => ({
                      id: img.id,
                      url: img.url,
                      type: img.type,
                    })),
                    lowPriority: true,
                    tx,
                  }).catch((error) => {
                    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                    log(
                      `⚠️  Failed to queue ${newImages.length} images for ingestion: ${errorMessage}`
                    );
                  });
                }
              }

              // Create all ImageConnections for all articles in batch
              const allConnections: Array<{
                imageId: number;
                entityType: 'Article';
                entityId: number;
              }> = [];

              for (const [articleId, { media }] of articleMediaMap) {
                for (const item of media) {
                  const imageId = existingUrlMap.get(item.url);
                  if (imageId) {
                    allConnections.push({
                      imageId,
                      entityType: 'Article' as const,
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

              // Mark all processed articles with contentScannedAt timestamp
              const processedArticleIds = Array.from(articleMediaMap.keys());
              if (processedArticleIds.length > 0) {
                await tx.article.updateMany({
                  where: { id: { in: processedArticleIds } },
                  data: { contentScannedAt: new Date() },
                });
              }
            },
            { timeout: 60000, maxWait: 10000 }
          );

          log(
            `  Step 2b: Batch transaction complete - ${batchStats.articlesProcessed} articles, ${
              batchStats.imagesCreated
            } images, ${batchStats.connectionsCreated} connections (${Date.now() - step2bStart}ms)`
          );
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          const errorMsg = `Batch transaction failed: ${errorMessage}`;
          log(`❌ ${errorMsg}`);
          batchStats.errors.push(errorMsg);
        }

        // Mark articles without images as scanned too (outside transaction since they weren't in articleMediaMap)
        const articlesWithoutImages = articleBatch.filter(
          (article) => !articleMediaMap.has(article.id)
        );
        if (!dryRun && articlesWithoutImages.length > 0) {
          await dbWrite.article
            .updateMany({
              where: { id: { in: articlesWithoutImages.map((a) => a.id) } },
              data: { contentScannedAt: new Date() },
            })
            .catch((error) => {
              log(
                `⚠️  Failed to mark ${articlesWithoutImages.length} articles without images: ${
                  error instanceof Error ? error.message : 'Unknown error'
                }`
              );
            });
        }

        return batchStats;
      }
    );

    log(`Step 2: Processing complete (${Date.now() - step2Start}ms)`);

    // Aggregate all results
    const aggregatedStats = allBatchResults.reduce(
      (acc, batch) => ({
        articlesProcessed: acc.articlesProcessed + batch.articlesProcessed,
        imagesCreated: acc.imagesCreated + batch.imagesCreated,
        connectionsCreated: acc.connectionsCreated + batch.connectionsCreated,
        errors: [...acc.errors, ...batch.errors],
      }),
      {
        articlesProcessed: 0,
        imagesCreated: 0,
        connectionsCreated: 0,
        errors: [] as string[],
      }
    );

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
        totalArticles,
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
