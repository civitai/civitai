import { Prisma } from '@prisma/client';
import { chunk } from 'lodash-es';
import { isProd } from '~/env/other';
import { env } from '~/env/server';
import { dbRead, dbWrite } from '~/server/db/client';
import { createJob } from '~/server/jobs/job';
import type { IngestImageInput } from '~/server/schema/image.schema';
import { deleteImages, ingestImage, ingestImageBulk } from '~/server/services/image.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
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

// const delayedBlockCutoff = new Date('2025-05-31');
export const removeBlockedImages = createJob('remove-blocked-images', '0 23 * * *', async () => {
  // During the delayed block period, we want to keep the images for 30 days
  // if (!isProd || delayedBlockCutoff > new Date()) return;
  let nextCursor: number | undefined;
  await removeBlockedImagesRecursive(undefined, nextCursor);
});

export async function removeBlockedImagesRecursive(
  cutoff: Date = decreaseDate(new Date(), 7, 'days'),
  nextCursor?: number,
  limit = 1000
) {
  const halfLimit = Math.floor(limit / 2);

  // Split into two queries to avoid slow OR condition
  // Query 1: Non-moderated blocked images by createdAt
  const nonModeratedImages = await dbRead.$queryRaw<{ id: number }[]>`
    SELECT id
    FROM "Image"
    WHERE "ingestion" = 'Blocked'
      AND "blockedFor" != 'AiNotVerified'
      AND "blockedFor" != 'moderated'
      AND "createdAt" <= ${cutoff}
      ${Prisma.raw(nextCursor ? `AND id > ${nextCursor}` : ``)}
    ORDER BY id
    LIMIT ${halfLimit + 1}
  `;

  // Query 2: Moderated blocked images by updatedAt
  const moderatedImages = await dbRead.$queryRaw<{ id: number }[]>`
    SELECT id
    FROM "Image"
    WHERE "ingestion" = 'Blocked'
      AND "blockedFor" = 'moderated'
      AND "updatedAt" <= ${cutoff}
      ${Prisma.raw(nextCursor ? `AND id > ${nextCursor}` : ``)}
    ORDER BY id
    LIMIT ${halfLimit + 1}
  `;

  // Merge, dedupe, and sort results
  const mergedImages = [...nonModeratedImages, ...moderatedImages];
  const uniqueIds = [...new Set(mergedImages.map((x) => x.id))].sort((a, b) => a - b);
  const images = uniqueIds.slice(0, limit + 1).map((id) => ({ id }));

  if (images.length > limit) {
    const nextItem = images.pop();
    nextCursor = nextItem?.id;
  } else nextCursor = undefined;

  if (!isProd) {
    console.log({ nextCursor, images: images.length });
  }

  if (!images.length || !env.DATABASE_IS_PROD) return;

  await deleteImages(images.map((x) => x.id));

  // if (nextCursor) {
  //   await removeBlockedImagesRecursive(cutoff, nextCursor);
  // }
}
