/**
 * Migration Script: Article Content Images
 *
 * Creates Image entities and ImageConnections for all embedded images in existing articles.
 * Supports dry-run mode, progress checkpointing, and graceful error handling.
 *
 * Usage:
 *   npm run migrate:article-images                    # Full migration
 *   npm run migrate:article-images -- --dry-run       # Preview without changes
 *   npm run migrate:article-images -- --batch=50      # Custom batch size
 */

import { PrismaClient } from '@prisma/client';
import { extractImagesFromArticle } from '../src/server/utils/article-image-helpers';
import { ingestImageBulk } from '../src/server/services/image.service';
import fs from 'fs/promises';
import path from 'path';

type ExtractedMedia = {
  url: string;
  type: 'image' | 'video';
  alt?: string;
};

const prisma = new PrismaClient();

interface MigrationStats {
  articlesProcessed: number;
  imagesCreated: number;
  connectionsCreated: number;
  errors: string[];
  startTime: Date;
}

interface CheckpointData {
  offset: number;
  stats: MigrationStats;
  lastArticleId: number;
}

const CHECKPOINT_FILE = path.join(process.cwd(), 'migration-article-images-progress.json');

/**
 * Load checkpoint from previous run
 */
async function loadCheckpoint(): Promise<CheckpointData | null> {
  try {
    const data = await fs.readFile(CHECKPOINT_FILE, 'utf-8');
    const checkpoint = JSON.parse(data);
    console.log(`📍 Resuming from checkpoint: Article ID ${checkpoint.lastArticleId}, Offset ${checkpoint.offset}`);
    return checkpoint;
  } catch {
    console.log('🆕 Starting fresh migration (no checkpoint found)');
    return null;
  }
}

/**
 * Save checkpoint for resumption
 */
async function saveCheckpoint(checkpoint: CheckpointData): Promise<void> {
  await fs.writeFile(CHECKPOINT_FILE, JSON.stringify(checkpoint, null, 2));
}

/**
 * Delete checkpoint after successful completion
 */
async function deleteCheckpoint(): Promise<void> {
  try {
    await fs.unlink(CHECKPOINT_FILE);
    console.log('✅ Checkpoint file removed');
  } catch {
    // Ignore if file doesn't exist
  }
}

/**
 * Main migration function
 */
export async function migrateArticleImages({
  batchSize = 100,
  dryRun = true,
}: {
  batchSize?: number;
  dryRun?: boolean;
}): Promise<MigrationStats> {
  const checkpoint = await loadCheckpoint();

  const stats: MigrationStats = checkpoint?.stats || {
    articlesProcessed: 0,
    imagesCreated: 0,
    connectionsCreated: 0,
    errors: [],
    startTime: new Date(),
  };

  let offset = checkpoint?.offset || 0;

  // Count total articles to migrate
  const totalArticles = await prisma.article.count({
    where: {
      status: { in: ['Published', 'Processing'] },
      content: { not: '' },
    },
  });

  console.log(`\n📊 Migration Overview:`);
  console.log(`   Total articles: ${totalArticles}`);
  console.log(`   Batch size: ${batchSize}`);
  console.log(`   Mode: ${dryRun ? '🔍 DRY RUN (preview only)' : '✍️  LIVE (making changes)'}\n`);

  while (offset < totalArticles) {
    const articles = await prisma.article.findMany({
      where: {
        status: { in: ['Published', 'Processing'] },
        content: { not: '' },
      },
      select: {
        id: true,
        content: true,
        userId: true,
      },
      skip: offset,
      take: batchSize,
      orderBy: { id: 'asc' },
    });

    if (articles.length === 0) break;

    for (const article of articles) {
      try {
        const contentMedia = extractImagesFromArticle(article.content);

        if (dryRun) {
          console.log(`[DRY RUN] Article ${article.id}: ${contentMedia.length} media items`);
          stats.articlesProcessed++;
          stats.imagesCreated += contentMedia.length; // Assume all would be created
          stats.connectionsCreated += contentMedia.length; // Assume all connections created
          continue;
        }

        // Skip articles with no media
        if (contentMedia.length === 0) {
          stats.articlesProcessed++;
          continue;
        }

        // Transaction for atomicity
        await prisma.$transaction(
          async (tx) => {
            const urls = contentMedia.map((media: ExtractedMedia) => media.url);

            // Get existing images
            const existingImages = await tx.image.findMany({
              where: { url: { in: urls } },
              select: { id: true, url: true },
            });

            const existingUrlMap = new Map(existingImages.map((img) => [img.url, img.id]));
            const missingMedia = contentMedia.filter((media: ExtractedMedia) => !existingUrlMap.has(media.url));

            // Create missing images
            if (missingMedia.length > 0) {
              const newImages = await tx.image.createManyAndReturn({
                data: missingMedia.map((media: ExtractedMedia) => ({
                  url: media.url,
                  userId: article.userId,
                  type: media.type,
                  ingestion: 'Pending' as const,
                  scanRequestedAt: new Date(),
                })),
                select: { id: true, url: true, type: true },
                skipDuplicates: true,
              });

              newImages.forEach((img) => {
                existingUrlMap.set(img.url, img.id);
                stats.imagesCreated++;
              });

              // Queue newly created images for immediate ingestion (high priority)
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
                  // Log error but don't fail the migration
                  console.error(`[Migration] Failed to queue images for article ${article.id}:`, error);
                });
              }
            }

            // Create ImageConnections (batch operation for performance)
            const connections = Array.from(existingUrlMap.values()).map((imageId) => ({
              imageId,
              entityType: 'Article' as const,
              entityId: article.id,
            }));

            if (connections.length > 0) {
              await tx.imageConnection.createMany({
                data: connections,
                skipDuplicates: true,
              });

              stats.connectionsCreated += connections.length;
            }
          },
          { timeout: 60000 }
        );

        stats.articlesProcessed++;
      } catch (error: any) {
        const errorMsg = `Article ${article.id}: ${error.message}`;
        console.error(`❌ [Migration Error] ${errorMsg}`);
        stats.errors.push(errorMsg);
        // Continue with next article (transaction auto-rolled back)
      }
    }

    offset += batchSize;

    // Save checkpoint
    if (!dryRun) {
      await saveCheckpoint({
        offset,
        stats,
        lastArticleId: articles[articles.length - 1].id,
      });
    }

    // Progress report
    const progress = Math.min(100, Math.round((offset / totalArticles) * 100));
    console.log(`📊 Progress: ${offset}/${totalArticles} articles (${progress}%)`);
  }

  // Final summary
  const duration = Date.now() - stats.startTime.getTime();
  console.log(`\n✅ Migration Complete!`);
  console.log(`   Articles processed: ${stats.articlesProcessed}`);
  console.log(`   Images created: ${stats.imagesCreated}`);
  console.log(`   Connections created: ${stats.connectionsCreated}`);
  console.log(`   Errors: ${stats.errors.length}`);
  console.log(`   Duration: ${Math.round(duration / 1000)}s\n`);

  if (stats.errors.length > 0) {
    console.log(`⚠️  Errors encountered:`);
    stats.errors.slice(0, 10).forEach((err) => console.log(`   - ${err}`));
    if (stats.errors.length > 10) {
      console.log(`   ... and ${stats.errors.length - 10} more`);
    }
  }

  // Clean up checkpoint on success
  if (!dryRun && stats.errors.length === 0) {
    await deleteCheckpoint();
  }

  return stats;
}

// CLI execution
if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const batchArg = args.find((a) => a.startsWith('--batch='));
  const batchSize = batchArg ? parseInt(batchArg.split('=')[1]) : 100;

  console.log('🚀 Article Image Migration Script\n');

  migrateArticleImages({ batchSize, dryRun })
    .then((stats) => {
      process.exit(stats.errors.length > 0 ? 1 : 0);
    })
    .catch((error) => {
      console.error('💥 Migration failed:', error);
      process.exit(1);
    })
    .finally(() => {
      prisma.$disconnect();
    });
}
