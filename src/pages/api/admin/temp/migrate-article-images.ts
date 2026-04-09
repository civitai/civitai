import { ArticleStatus, Prisma } from '@prisma/client';
import * as z from 'zod';
import { dbWrite } from '~/server/db/client';
import { dataProcessor } from '~/server/db/db-helpers';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { createLogger } from '~/utils/logging';
import { booleanString } from '~/utils/zod-helpers';
import { getContentMedia } from '~/server/services/article-content-cleanup.service';
import type { ExtractedMedia } from '~/utils/article-helpers';
import { EntityModerationStatus, ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import { ImageConnectionType } from '~/server/common/enums';
import { submitTextModeration } from '~/server/services/text-moderation.service';
import { removeTags } from '~/utils/string-helpers';

const log = createLogger('migrate-article-images', 'blue');

// --- Types ---

const allModes = ['images', 'text-moderation'] as const;
type Mode = (typeof allModes)[number];

type MigrationStats = {
  articlesProcessed: number;
  imagesCreated: number;
  connectionsCreated: number;
  textModerationSubmitted: number;
  textModerationSkipped: number;
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
  mode: z
    .string()
    .transform((v) => v.split(',') as Mode[])
    .pipe(z.array(z.enum(allModes)).min(1)),
});

type MigrationParams = z.infer<typeof querySchema>;

// --- Helpers ---

function createEmptyStats(): MigrationStats {
  return {
    articlesProcessed: 0,
    imagesCreated: 0,
    connectionsCreated: 0,
    textModerationSubmitted: 0,
    textModerationSkipped: 0,
    errors: [],
  };
}

function mergeStats(statsList: MigrationStats[]): MigrationStats {
  const merged = createEmptyStats();
  for (const stats of statsList) {
    merged.articlesProcessed += stats.articlesProcessed;
    merged.imagesCreated += stats.imagesCreated;
    merged.connectionsCreated += stats.connectionsCreated;
    merged.textModerationSubmitted += stats.textModerationSubmitted;
    merged.textModerationSkipped += stats.textModerationSkipped;
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
                  data: { contentScannedAt: new Date() },
                });
              }
            },
            { timeout: 60000, maxWait: 10000 }
          );

          log(
            `  Transaction complete: ${stats.imagesCreated} images, ${stats.connectionsCreated} connections`
          );
        } catch (error) {
          const msg = error instanceof Error ? error.message : 'Unknown error';
          log(`❌ Batch transaction failed: ${msg}`);
          stats.errors.push(`Batch transaction failed: ${msg}`);
        }
      }

      // Mark articles without images as scanned (exclude extraction failures so they can be retried)
      const articlesWithoutImages = articleBatch.filter(
        (article) => !articleMediaMap.has(article.id) && !failedArticleIds.has(article.id)
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

      log(`[images] Batch complete (${Date.now() - batchStart}ms)`);
      batchResults.push(stats);
    },
  });

  return mergeStats(batchResults);
}

// --- Text Moderation Mode ---
// Targets all published articles that either:
// - Have no EntityModeration record yet (new articles)
// - Have a Failed or Expired EntityModeration record (retries)

async function runTextModeration(
  params: MigrationParams,
  runContext: RunContext
): Promise<MigrationStats> {
  const { dryRun, concurrency } = params;
  const batchResults: MigrationStats[] = [];

  log(`Running text-moderation mode${dryRun ? ' (DRY RUN)' : ''}...`);

  await dataProcessor({
    params,
    runContext,
    rangeFetcher: async () => {
      if (params.after || params.before) return fetchDateRange(params);

      const [{ max }] = await dbWrite.$queryRaw<{ max: number }[]>(
        Prisma.sql`
          SELECT MAX(a.id) "max" FROM "Article" a
          LEFT JOIN "EntityModeration" em ON em."entityId" = a.id AND em."entityType" = 'Article'
          WHERE a.status = ${ArticleStatus.Published}::"ArticleStatus"
          AND a.content != ''
          AND (em.id IS NULL OR em.status != ${EntityModerationStatus.Succeeded}::"EntityModerationStatus")
        `
      );
      return { start: params.start, end: params.end ?? max ?? 0 };
    },
    processor: async ({ start, end }) => {
      const batchStart = Date.now();
      const stats = createEmptyStats();

      const articleBatch = await dbWrite.$queryRaw<Article[]>(
        Prisma.sql`
          SELECT DISTINCT a.id, a.title, a.content, a."userId"
          FROM "Article" a
          LEFT JOIN "EntityModeration" em ON em."entityId" = a.id AND em."entityType" = 'Article'
          WHERE a.id >= ${start} AND a.id <= ${end}
          AND a.status = ${ArticleStatus.Published}::"ArticleStatus"
          AND a.content != ''
          AND (em.id IS NULL OR em.status != ${EntityModerationStatus.Succeeded}::"EntityModerationStatus")
          ORDER BY a.id ASC
        `
      );

      if (articleBatch.length === 0) return;

      log(`[text-moderation] Processing ${articleBatch.length} articles (IDs ${start}-${end})...`);

      if (dryRun) {
        for (const article of articleBatch) {
          const text = [article.title, removeTags(article.content)].filter(Boolean).join(' ');
          log(`[DRY RUN] Article ${article.id}: text moderation (${text.length} chars)`);
          stats.textModerationSubmitted++;
          stats.articlesProcessed++;
        }
        batchResults.push(stats);
        return;
      }

      let textModIdx = 0;
      await limitConcurrency(() => {
        if (textModIdx >= articleBatch.length) return null;
        const article = articleBatch[textModIdx++];

        return async () => {
          try {
            const text = [article.title, removeTags(article.content)].filter(Boolean).join(' ');

            if (!text.trim()) {
              stats.textModerationSkipped++;
              return;
            }

            await submitTextModeration({
              entityType: 'Article',
              entityId: article.id,
              content: text,
              labels: ['nsfw', 'pg', 'pg13', 'r', 'x', 'xxx'],
              priority: 'low',
            });
            stats.textModerationSubmitted++;
          } catch (error) {
            stats.errors.push(
              `Text moderation article ${article.id}: ${
                error instanceof Error ? error.message : 'Unknown error'
              }`
            );
          }
        };
      }, concurrency);

      stats.articlesProcessed += articleBatch.length;

      log(
        `[text-moderation] Batch complete: ${stats.textModerationSubmitted} submitted, ${
          stats.textModerationSkipped
        } skipped (${Date.now() - batchStart}ms)`
      );
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
  const modes = new Set(params.mode);
  const startTime = Date.now();

  log(
    `Starting article migration (modes: ${params.mode.join(',')})${
      params.dryRun ? ' (DRY RUN)' : ''
    } with batchSize ${params.batchSize}, concurrency ${params.concurrency}`
  );

  const results: MigrationStats[] = [];

  try {
    if (modes.has('images')) {
      results.push(await runImageScan(params, res));
    }

    if (modes.has('text-moderation')) {
      results.push(await runTextModeration(params, res));
    }

    const aggregated = mergeStats(results);
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    log(`Process completed successfully in ${duration}s`);

    res.status(200).json({
      ok: true,
      dryRun: params.dryRun,
      modes: params.mode,
      duration: `${duration}s`,
      result: {
        articlesProcessed: aggregated.articlesProcessed,
        imagesCreated: aggregated.imagesCreated,
        connectionsCreated: aggregated.connectionsCreated,
        textModerationSubmitted: aggregated.textModerationSubmitted,
        textModerationSkipped: aggregated.textModerationSkipped,
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
