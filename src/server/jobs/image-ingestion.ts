import { Prisma } from '@prisma/client';
import { chunk } from 'lodash-es';
import { isProd } from '~/env/other';
import { env } from '~/env/server';
import { dbRead, dbWrite } from '~/server/db/client';
import { createJob } from '~/server/jobs/job';
import type { IngestImageInput } from '~/server/schema/image.schema';
import { deleteImages, ingestImage, ingestImageBulk } from '~/server/services/image.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { EntityType, JobQueueType } from '~/shared/utils/prisma/enums';
import { decreaseDate } from '~/utils/date-helpers';

const IMAGE_SCANNING_ERROR_DELAY = 60 * 1; // 1 hour
const IMAGE_SCANNING_RETRY_LIMIT = 9;

type PendingIngestImageRow = IngestImageInput & {
  scanRequestedAt: Date | null;
};
type ErrorIngestImageRow = PendingIngestImageRow & {
  retryCount: number;
};

async function fetchAllPendingImages<T extends { id: number }>(
  query: (cursor: number | undefined, limit: number) => Promise<T[]>,
  batchSize = 5000
): Promise<T[]> {
  const allResults: T[] = [];
  let cursor: number | undefined;

  while (true) {
    const batch = await query(cursor, batchSize);
    if (batch.length === 0) break;

    allResults.push(...batch);
    cursor = batch[batch.length - 1].id;

    if (batch.length < batchSize) break;
  }

  return allResults;
}

export const ingestImages = createJob('ingest-images', '0 * * * *', async () => {
  const now = new Date();

  // Fetch then filter pending images in JS to avoid a slow query
  const rescanDate = decreaseDate(now, env.IMAGE_SCANNING_RETRY_DELAY, 'minutes');
  const pendingImages = (
    await fetchAllPendingImages(async (cursor, limit) => {
      return (
        (await dbWrite.$queryRaw<PendingIngestImageRow[]>`
          SELECT id, url, type, width, height, meta->>'prompt' as prompt, "scanRequestedAt"
          FROM "Image"
          WHERE ingestion = 'Pending'::"ImageIngestionStatus"
          ${Prisma.raw(cursor ? `AND id > ${cursor}` : '')}
          ORDER BY id
          LIMIT ${limit}
        `) ?? []
      );
    })
  ).filter((img) => !img.scanRequestedAt || img.scanRequestedAt <= rescanDate);

  console.log({ pendingImages: pendingImages.length });

  const rescanImages = await fetchAllPendingImages(async (cursor, limit) => {
    return (
      (await dbWrite.$queryRaw<PendingIngestImageRow[]>`
        SELECT id, url, type, width, height, meta->>'prompt' as prompt, "scanRequestedAt"
        FROM "Image"
        WHERE ingestion = 'Rescan'::"ImageIngestionStatus"
        ${Prisma.raw(cursor ? `AND id > ${cursor}` : '')}
        ORDER BY id
        LIMIT ${limit}
      `) ?? []
    );
  });

  // Fetch then filter error images in JS to avoid a slow query
  const errorRetryDate = decreaseDate(now, IMAGE_SCANNING_ERROR_DELAY, 'minutes').getTime();
  const errorImages = (
    (await dbWrite.$queryRaw<ErrorIngestImageRow[]>`
    SELECT id, url, type, width, height, meta->>'prompt' as prompt, "scanRequestedAt", ("scanJobs"->>'retryCount')::int as "retryCount"
    FROM "Image"
    WHERE ingestion = 'Error'::"ImageIngestionStatus" AND ("createdAt" > now() - '96 hours'::interval)
  `) ?? []
  ).filter(
    (img) =>
      img.scanRequestedAt &&
      new Date(img.scanRequestedAt).getTime() <= errorRetryDate &&
      Number(img.retryCount ?? 0) < IMAGE_SCANNING_RETRY_LIMIT
  );

  const images: IngestImageInput[] = [...pendingImages, ...errorImages];

  if (isProd) {
    await sendImagesForScanBulk(pendingImages);
    await sendImagesForScanBulk(rescanImages, { lowPriority: true });
    await sendImagesForScanBulk(errorImages, { lowPriority: true });
  }

  return { toScan: images.length };
});

async function sendImagesForScanSingle(images: IngestImageInput[]) {
  const failedSends: number[] = [];
  const tasks = images.map((image, i) => async () => {
    console.log('Ingesting image', i + 1, 'of', tasks.length);
    const start = Date.now();

    let retryCount = 0,
      success = false;
    while (retryCount < 3) {
      success = await ingestImage({ image });
      if (success) break;
      console.log('Retrying image', i + 1, 'retry', retryCount + 1);
      retryCount++;
    }
    if (!success) failedSends.push(image.id);
    console.log('Image', i + 1, 'ingested in', ((Date.now() - start) / 1000).toFixed(0), 's');
  });
  await limitConcurrency(tasks, 50);
  console.log('Failed sends:', failedSends.length);
}

async function sendImagesForScanBulk(
  images: IngestImageInput[],
  options?: { lowPriority?: boolean }
) {
  const failedSends: number[] = [];
  const tasks = chunk(images, 250).map((batch, i) => async () => {
    console.log('Ingesting batch', i + 1, 'of', tasks.length);
    const start = Date.now();

    let retryCount = 0,
      success = false;
    let imagesToProcess = [...batch]; // Track images that still need processing

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
    console.log('Image', i + 1, 'ingested in', ((Date.now() - start) / 1000).toFixed(0), 's');
  });
  await limitConcurrency(tasks, 4);
  console.log('Failed sends:', failedSends.length);
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
