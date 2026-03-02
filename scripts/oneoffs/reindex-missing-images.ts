/**
 * Script to re-index images on the metrics Meilisearch index if they were created
 * between 12/17 and 12/18 and either don't exist on the index OR they exist but are
 * marked as unpublished/review/etc.
 *
 * Usage:
 *   npm run tsscript scripts/oneoffs/reindex-missing-images.ts [--dry-run] [--batch-size=1000]
 *
 * Options:
 *   --dry-run      Preview what would be re-indexed without actually queuing
 *   --batch-size   Number of images to process per batch (default: 1000)
 */

import { MeiliSearch } from 'meilisearch';
import { PrismaClient } from '@prisma/client';
import { chunk } from 'lodash-es';
import { addToQueue } from '~/server/redis/queues';

// Parse command line arguments
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const batchSizeArg = args.find((arg) => arg.startsWith('--batch-size='));
const BATCH_SIZE = batchSizeArg ? parseInt(batchSizeArg.split('=')[1], 10) : 1000;

// Date range for the query (December 17-18, 2024)
const START_DATE = new Date('2024-12-17T00:00:00.000Z');
const END_DATE = new Date('2024-12-19T00:00:00.000Z'); // Exclusive end

// NsfwLevel constants (from src/server/common/enums.ts)
const NSFW_LEVEL_BLOCKED = 32;

// Environment variables for Meilisearch
const METRICS_SEARCH_HOST = process.env.METRICS_SEARCH_HOST;
const METRICS_SEARCH_API_KEY = process.env.METRICS_SEARCH_API_KEY;
const METRICS_IMAGES_SEARCH_INDEX = 'metrics_images_v1';

// Initialize clients
const prisma = new PrismaClient();
const metricsSearchClient =
  METRICS_SEARCH_HOST && METRICS_SEARCH_API_KEY
    ? new MeiliSearch({
        host: METRICS_SEARCH_HOST,
        apiKey: METRICS_SEARCH_API_KEY,
      })
    : null;

interface ImageRecord {
  id: number;
  createdAt: Date;
  postId: number | null;
  ingestion: string;
  needsReview: string | null;
  nsfwLevel: number;
  blockedFor: string | null;
}

interface MeiliSearchHit {
  id: number;
  needsReview: string | null;
  nsfwLevel: number;
  blockedFor: string | null;
  publishedAtUnix?: number;
}

async function getImagesFromDatabase(): Promise<ImageRecord[]> {
  console.log(
    `Fetching images created between ${START_DATE.toISOString()} and ${END_DATE.toISOString()}...`
  );

  const images = await prisma.$queryRaw<ImageRecord[]>`
    SELECT
      i.id,
      i."createdAt",
      i."postId",
      i.ingestion::"text" as ingestion,
      i."needsReview",
      i."nsfwLevel",
      i."blockedFor"
    FROM "Image" i
    JOIN "Post" p ON p.id = i."postId"
    WHERE i."createdAt" >= ${START_DATE}
      AND i."createdAt" < ${END_DATE}
      AND i."postId" IS NOT NULL
      AND i.ingestion = 'Scanned'
      AND p."publishedAt" IS NOT NULL
    ORDER BY i.id ASC
  `;

  console.log(`Found ${images.length} eligible images in database`);
  return images;
}

async function checkMeiliSearchStatus(
  imageIds: number[]
): Promise<Map<number, MeiliSearchHit | null>> {
  if (!metricsSearchClient) {
    throw new Error(
      'Meilisearch client not initialized. Check METRICS_SEARCH_HOST and METRICS_SEARCH_API_KEY env vars.'
    );
  }

  const result = new Map<number, MeiliSearchHit | null>();
  const index = metricsSearchClient.index(METRICS_IMAGES_SEARCH_INDEX);

  // Process in smaller chunks to avoid hitting Meilisearch limits
  const chunks = chunk(imageIds, 500);

  for (const chunkIds of chunks) {
    try {
      const filter = `id IN [${chunkIds.join(',')}]`;
      const searchResult = await index.search('', {
        filter,
        limit: chunkIds.length,
        attributesToRetrieve: ['id', 'needsReview', 'nsfwLevel', 'blockedFor', 'publishedAtUnix'],
      });

      // Initialize all IDs as not found
      for (const id of chunkIds) {
        result.set(id, null);
      }

      // Mark found ones
      for (const hit of searchResult.hits as MeiliSearchHit[]) {
        result.set(hit.id, hit);
      }
    } catch (error) {
      console.error(`Error querying Meilisearch for chunk:`, error);
      // Mark all in this chunk as needing update (safer)
      for (const id of chunkIds) {
        result.set(id, null);
      }
    }
  }

  return result;
}

function shouldReindex(
  dbImage: ImageRecord,
  meiliHit: MeiliSearchHit | null
): { reindex: boolean; reason: string } {
  // Case 1: Image doesn't exist in Meilisearch
  if (!meiliHit) {
    return { reindex: true, reason: 'missing_from_index' };
  }

  // Case 2: Image exists but has problematic status in Meilisearch
  // These indicate the image might not be properly indexed

  // Check if needsReview is set in Meilisearch but not in DB
  if (meiliHit.needsReview && !dbImage.needsReview) {
    return { reindex: true, reason: 'stale_needsReview' };
  }

  // Check if blockedFor is set in Meilisearch but not in DB
  if (meiliHit.blockedFor && !dbImage.blockedFor) {
    return { reindex: true, reason: 'stale_blockedFor' };
  }

  // Check for blocked nsfw level in Meilisearch
  // If the DB shows it's not blocked but Meilisearch shows blocked
  if (meiliHit.nsfwLevel === NSFW_LEVEL_BLOCKED && dbImage.nsfwLevel !== NSFW_LEVEL_BLOCKED) {
    return { reindex: true, reason: 'stale_nsfwLevel_blocked' };
  }

  // Check for nsfwLevel = 0 in Meilisearch (unprocessed) when DB has a valid level
  if (meiliHit.nsfwLevel === 0 && dbImage.nsfwLevel > 0) {
    return { reindex: true, reason: 'stale_nsfwLevel_zero' };
  }

  // Check if publishedAtUnix is missing (indicates unpublished in index)
  if (!meiliHit.publishedAtUnix) {
    return { reindex: true, reason: 'missing_publishedAt' };
  }

  return { reindex: false, reason: 'up_to_date' };
}

async function queueForReindex(imageIds: number[]): Promise<void> {
  if (isDryRun) {
    console.log(`[DRY RUN] Would queue ${imageIds.length} images for re-indexing`);
    return;
  }

  // Queue for update action
  await addToQueue(`${METRICS_IMAGES_SEARCH_INDEX}:Update`, imageIds);
  console.log(`Queued ${imageIds.length} images for re-indexing`);
}

async function main() {
  console.log('='.repeat(60));
  console.log('Re-index Missing Images Script');
  console.log('='.repeat(60));
  console.log(`Mode: ${isDryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Batch size: ${BATCH_SIZE}`);
  console.log(`Date range: ${START_DATE.toISOString()} to ${END_DATE.toISOString()}`);
  console.log('');

  if (!metricsSearchClient) {
    console.error('ERROR: Meilisearch client not initialized.');
    console.error(
      'Please set METRICS_SEARCH_HOST and METRICS_SEARCH_API_KEY environment variables.'
    );
    process.exit(1);
  }

  try {
    // Step 1: Get all eligible images from database
    const dbImages = await getImagesFromDatabase();

    if (dbImages.length === 0) {
      console.log('No images found in the specified date range. Exiting.');
      process.exit(0);
    }

    // Step 2: Process in batches to avoid overwhelming DB and Meilisearch
    const batches = chunk(dbImages, BATCH_SIZE);
    const stats = {
      total: dbImages.length,
      missing: 0,
      staleNeedsReview: 0,
      staleBlockedFor: 0,
      staleNsfwLevelBlocked: 0,
      staleNsfwLevelZero: 0,
      missingPublishedAt: 0,
      upToDate: 0,
      toReindex: [] as number[],
    };

    console.log(`Processing ${batches.length} batches...`);
    console.log('');

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const batchIds = batch.map((img) => img.id);

      console.log(
        `Batch ${i + 1}/${batches.length}: Checking ${batch.length} images (IDs ${batchIds[0]} - ${
          batchIds[batchIds.length - 1]
        })`
      );

      // Check Meilisearch status for this batch
      const meiliStatus = await checkMeiliSearchStatus(batchIds);

      // Determine which images need re-indexing
      for (const dbImage of batch) {
        const meiliHit = meiliStatus.get(dbImage.id) ?? null;
        const { reindex, reason } = shouldReindex(dbImage, meiliHit);

        if (reindex) {
          stats.toReindex.push(dbImage.id);

          switch (reason) {
            case 'missing_from_index':
              stats.missing++;
              break;
            case 'stale_needsReview':
              stats.staleNeedsReview++;
              break;
            case 'stale_blockedFor':
              stats.staleBlockedFor++;
              break;
            case 'stale_nsfwLevel_blocked':
              stats.staleNsfwLevelBlocked++;
              break;
            case 'stale_nsfwLevel_zero':
              stats.staleNsfwLevelZero++;
              break;
            case 'missing_publishedAt':
              stats.missingPublishedAt++;
              break;
          }
        } else {
          stats.upToDate++;
        }
      }

      // Small delay between batches to avoid hammering
      if (i < batches.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    // Step 3: Print summary
    console.log('');
    console.log('='.repeat(60));
    console.log('SUMMARY');
    console.log('='.repeat(60));
    console.log(`Total images checked: ${stats.total}`);
    console.log(`Up to date: ${stats.upToDate}`);
    console.log(`Need re-indexing: ${stats.toReindex.length}`);
    console.log('  - Missing from index: ' + stats.missing);
    console.log('  - Stale needsReview: ' + stats.staleNeedsReview);
    console.log('  - Stale blockedFor: ' + stats.staleBlockedFor);
    console.log('  - Stale nsfwLevel (blocked): ' + stats.staleNsfwLevelBlocked);
    console.log('  - Stale nsfwLevel (zero/unprocessed): ' + stats.staleNsfwLevelZero);
    console.log('  - Missing publishedAt: ' + stats.missingPublishedAt);
    console.log('');

    // Step 4: Queue for re-indexing
    if (stats.toReindex.length > 0) {
      console.log(
        `${isDryRun ? '[DRY RUN] Would queue' : 'Queueing'} ${
          stats.toReindex.length
        } images for re-indexing...`
      );

      // Queue in batches to avoid overwhelming Redis
      const queueBatches = chunk(stats.toReindex, 5000);
      for (let i = 0; i < queueBatches.length; i++) {
        await queueForReindex(queueBatches[i]);
        if (!isDryRun) {
          console.log(
            `  Queued batch ${i + 1}/${queueBatches.length} (${queueBatches[i].length} images)`
          );
        }
      }

      console.log('');
      if (isDryRun) {
        console.log('DRY RUN complete. No changes were made.');
        console.log('Run without --dry-run to actually queue images for re-indexing.');
      } else {
        console.log('Done! Images have been queued for re-indexing.');
        console.log('The search-index-sync job will process them on its next run.');
      }
    } else {
      console.log('No images need re-indexing. All images are up to date.');
    }

    // Print sample of image IDs that would be re-indexed
    if (stats.toReindex.length > 0 && stats.toReindex.length <= 100) {
      console.log('');
      console.log('Image IDs to re-index:', stats.toReindex.join(', '));
    } else if (stats.toReindex.length > 100) {
      console.log('');
      console.log('First 100 image IDs to re-index:', stats.toReindex.slice(0, 100).join(', '));
      console.log('...');
    }
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
