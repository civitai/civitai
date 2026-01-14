import { Prisma } from '@prisma/client';
import { chunk } from 'lodash-es';
import { isProd } from '~/env/other';
import { env } from '~/env/server';
import { dbRead, dbWrite } from '~/server/db/client';
import { createJob } from '~/server/jobs/job';
import type { IngestImageInput } from '~/server/schema/image.schema';
import { deleteImages, ingestImage } from '~/server/services/image.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { EntityType, JobQueueType } from '~/shared/utils/prisma/enums';
import { decreaseDate } from '~/utils/date-helpers';

const IMAGE_SCANNING_ERROR_DELAY = 60 * 1; // 1 hour
const IMAGE_SCANNING_RETRY_LIMIT = 9;

type IngestImageRow = IngestImageInput & {
  scanRequestedAt: Date | null;
  ingestion: string;
  retryCount: number | null;
};

export const ingestImages = createJob('ingest-images', '*/5 * * * *', async () => {
  const now = new Date();

  // Pull from JobQueue instead of scanning Image table with partial indexes
  const jobQueue = await dbRead.jobQueue.findMany({
    where: { type: JobQueueType.ImageScan, entityType: EntityType.Image },
    take: 10000,
    orderBy: { createdAt: 'asc' },
  });

  if (!jobQueue.length) {
    console.log('No images in queue');
    return { processed: 0 };
  }

  const imageIds = jobQueue.map((j) => j.entityId);
  console.log(`Found ${imageIds.length} images in queue`);

  // Fetch full image data by IDs (fast primary key lookup)
  const images =
    (await dbWrite.$queryRaw<IngestImageRow[]>`
    SELECT id, url, type, width, height, meta->>'prompt' as prompt,
           "scanRequestedAt", ingestion, ("scanJobs"->>'retryCount')::int as "retryCount"
    FROM "Image"
    WHERE id = ANY(${imageIds})
  `) ?? [];

  // Filter based on status and retry logic
  const rescanDate = decreaseDate(now, env.IMAGE_SCANNING_RETRY_DELAY, 'minutes');
  const errorRetryDate = decreaseDate(now, IMAGE_SCANNING_ERROR_DELAY, 'minutes').getTime();

  const pendingImages = images.filter(
    (img) =>
      img.ingestion === 'Pending' && (!img.scanRequestedAt || img.scanRequestedAt <= rescanDate)
  );

  const rescanImages = images.filter((img) => img.ingestion === 'Rescan');

  const errorImages = images.filter(
    (img) =>
      img.ingestion === 'Error' &&
      img.scanRequestedAt &&
      new Date(img.scanRequestedAt).getTime() <= errorRetryDate &&
      Number(img.retryCount ?? 0) < IMAGE_SCANNING_RETRY_LIMIT
  );

  // Categorize images for proper queue cleanup:
  // 1. Images we're about to process - remove from queue
  const processedIds = new Set([
    ...pendingImages.map((img) => img.id),
    ...rescanImages.map((img) => img.id),
    ...errorImages.map((img) => img.id),
  ]);

  // 2. Images still in scannable status but waiting for retry delay - KEEP in queue
  const waitingForRetryIds = new Set(
    images
      .filter((img) => {
        // Pending but recently scanned - waiting for retry delay
        if (
          img.ingestion === 'Pending' &&
          img.scanRequestedAt &&
          img.scanRequestedAt > rescanDate
        ) {
          return true;
        }
        // Error but waiting for retry delay or under retry limit
        if (img.ingestion === 'Error') {
          const waitingForDelay =
            img.scanRequestedAt && new Date(img.scanRequestedAt).getTime() > errorRetryDate;
          const underRetryLimit = Number(img.retryCount ?? 0) < IMAGE_SCANNING_RETRY_LIMIT;
          return waitingForDelay && underRetryLimit;
        }
        return false;
      })
      .map((img) => img.id)
  );

  // 3. Images no longer in scannable status (Scanned, Blocked, etc.) or exceeded retry limit - remove
  const imageIdSet = new Set(images.map((img) => img.id));
  const staleIds = imageIds.filter((id) => {
    // Image was deleted or not found
    if (!imageIdSet.has(id)) return true;
    // Image is being processed
    if (processedIds.has(id)) return false;
    // Image is waiting for retry
    if (waitingForRetryIds.has(id)) return false;
    // Otherwise it's stale (status changed or exceeded retry limit)
    return true;
  });

  console.log({
    pendingImages: pendingImages.length,
    rescanImages: rescanImages.length,
    errorImages: errorImages.length,
    waitingForRetry: waitingForRetryIds.size,
    staleIds: staleIds.length,
  });

  if (!isProd) return;

  const sentPendingIds = await sendImagesForScanBulk(pendingImages);
  const sentRescanIds = await sendImagesForScanBulk(rescanImages, { lowPriority: true });
  const sentErrorIds = await sendImagesForScanBulk(errorImages, { lowPriority: true });

  // Remove successfully sent and stale items from queue
  // Keep items that failed to send or are waiting for retry delay - they'll be picked up on next run
  const idsToRemove = [...sentPendingIds, ...sentRescanIds, ...sentErrorIds, ...staleIds];
  if (idsToRemove.length > 0) {
    await dbWrite.jobQueue.deleteMany({
      where: {
        type: JobQueueType.ImageScan,
        entityType: EntityType.Image,
        entityId: { in: idsToRemove },
      },
    });
  }

  const totalSent = sentPendingIds.length + sentRescanIds.length + sentErrorIds.length;
  return {
    sent: totalSent,
    waitingForRetry: waitingForRetryIds.size,
    staleRemoved: staleIds.length,
  };
});

async function sendImagesForScanBulk(
  images: IngestImageInput[],
  options?: { lowPriority?: boolean }
): Promise<number[]> {
  if (!images.length) return [];

  const failedSends: number[] = [];
  const tasks = chunk(images, 250).map((batch, i) => async () => {
    console.log('Ingesting batch', i + 1, 'of', tasks.length);
    const start = Date.now();

    let retryCount = 0,
      success = false;
    let imagesToProcess = [...batch];

    while (retryCount < 3 && imagesToProcess.length > 0) {
      const failedImages: IngestImageInput[] = [];

      for (const image of imagesToProcess) {
        const imageSuccess = await ingestImage({ image, lowPriority: options?.lowPriority });
        if (!imageSuccess) {
          failedImages.push(image);
        }
      }

      imagesToProcess = failedImages;
      success = failedImages.length === 0;

      if (success) break;
      console.log('Retrying batch', i + 1, 'retry', retryCount + 1);
      retryCount++;
    }
    if (!success) failedSends.push(...imagesToProcess.map((x) => x.id));
    console.log('Batch', i + 1, 'ingested in', ((Date.now() - start) / 1000).toFixed(0), 's');
  });
  await limitConcurrency(tasks, 4);
  if (failedSends.length > 0) {
    console.log('Failed sends:', failedSends.length);
  }

  const failedSet = new Set(failedSends);
  return images.filter((img) => !failedSet.has(img.id)).map((img) => img.id);
}

const BLOCKED_IMAGE_RETENTION_DAYS = 7;

export const removeBlockedImages = createJob('remove-blocked-images', '0 23 * * *', async () => {
  // Pull from JobQueue instead of scanning Image table
  const jobQueue = await dbRead.jobQueue.findMany({
    where: { type: JobQueueType.BlockedImageDelete, entityType: EntityType.Image },
    take: 10000,
    orderBy: { createdAt: 'asc' },
  });

  if (!jobQueue.length) {
    console.log('No blocked images in queue');
    return { processed: 0 };
  }

  const imageIds = jobQueue.map((j) => j.entityId);
  console.log(`Found ${imageIds.length} blocked images in queue`);

  // Fetch image data to check retention period and blockedFor status
  const cutoff = decreaseDate(new Date(), BLOCKED_IMAGE_RETENTION_DAYS, 'days');
  const images = await dbRead.$queryRaw<
    { id: number; blockedFor: string | null; createdAt: Date; updatedAt: Date }[]
  >`
    SELECT id, "blockedFor", "createdAt", "updatedAt"
    FROM "Image"
    WHERE id = ANY(${imageIds})
      AND ingestion = 'Blocked'::"ImageIngestionStatus"
  `;

  // Filter images ready for deletion based on retention period
  const imagesToDelete = images.filter((img) => {
    // Skip AiNotVerified - these are handled differently
    if (img.blockedFor === 'AiNotVerified') return false;

    // Moderated images use updatedAt for retention
    if (img.blockedFor === 'moderated') {
      return img.updatedAt <= cutoff;
    }

    // All other blocked images use createdAt for retention
    return img.createdAt <= cutoff;
  });

  // Find stale queue entries (image deleted, status changed, or AiNotVerified)
  const imageIdSet = new Set(images.map((img) => img.id));
  const deleteReadyIds = new Set(imagesToDelete.map((img) => img.id));
  const staleIds = imageIds.filter((id) => {
    // Image was deleted or status changed from Blocked
    if (!imageIdSet.has(id)) return true;
    // AiNotVerified images should be removed from queue
    const img = images.find((i) => i.id === id);
    if (img?.blockedFor === 'AiNotVerified') return true;
    return false;
  });

  // Find images still waiting for retention period
  const waitingIds = imageIds.filter((id) => {
    if (!imageIdSet.has(id)) return false;
    if (deleteReadyIds.has(id)) return false;
    if (staleIds.includes(id)) return false;
    return true;
  });

  console.log({
    imagesToDelete: imagesToDelete.length,
    waitingForRetention: waitingIds.length,
    staleIds: staleIds.length,
  });

  if (!isProd) return { imagesToDelete: imagesToDelete.length };

  if (!env.DATABASE_IS_PROD) return { imagesToDelete: 0 };

  // Delete images that are past retention period
  if (imagesToDelete.length > 0) {
    await deleteImages(imagesToDelete.map((x) => x.id));
  }

  // Remove processed and stale entries from queue
  const idsToRemove = [...imagesToDelete.map((x) => x.id), ...staleIds];
  if (idsToRemove.length > 0) {
    await dbWrite.jobQueue.deleteMany({
      where: {
        type: JobQueueType.BlockedImageDelete,
        entityType: EntityType.Image,
        entityId: { in: idsToRemove },
      },
    });
  }

  return {
    deleted: imagesToDelete.length,
    staleRemoved: staleIds.length,
    waitingForRetention: waitingIds.length,
  };
});
