import { Prisma } from '@prisma/client';
import { chunk } from 'lodash-es';
import { isProd } from '~/env/other';
import { env } from '~/env/server';
import { dbRead, dbWrite } from '~/server/db/client';
import { createJob } from '~/server/jobs/job';
import type { IngestImageInput } from '~/server/schema/image.schema';
import {
  deleteImages,
  ingestImage,
  ingestImageBulk
} from '~/server/services/image.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { decreaseDate } from '~/utils/date-helpers';

const IMAGE_SCANNING_ERROR_DELAY = 60 * 1; // 1 hour
const IMAGE_SCANNING_RETRY_LIMIT = 3;

type PendingIngestImageRow = IngestImageInput & {
  scanRequestedAt: Date | null;
}
type ErrorIngestImageRow = PendingIngestImageRow & {
  retryCount: number;
}

export const ingestImages = createJob('ingest-images', '0 * * * *', async () => {
  const now = new Date();

  // Fetch then filter pending images in JS to avoid a slow query
  const rescanDate = decreaseDate(now, env.IMAGE_SCANNING_RETRY_DELAY, 'minutes');
  const pendingImages = ((await dbWrite.$queryRaw<PendingIngestImageRow[]>`
    SELECT id, url, type, width, height, meta->>'prompt' as prompt, "scanRequestedAt"
    FROM "Image"
    WHERE ingestion = 'Pending'::"ImageIngestionStatus"
  `) ?? []).filter((img) => !img.scanRequestedAt || img.scanRequestedAt <= rescanDate);

  // Fetch then filter error images in JS to avoid a slow query
  const errorRetryDate = decreaseDate(now, IMAGE_SCANNING_ERROR_DELAY, 'minutes');
  const errorImages = ((await dbWrite.$queryRaw<ErrorIngestImageRow[]>`
    SELECT id, url, type, width, height, meta->>'prompt' as prompt, "scanRequestedAt", ("scanJobs"->>'retryCount')::int as retryCount
    FROM "Image"
    WHERE ingestion = 'Error'::"ImageIngestionStatus" AND "createdAt" > now() - '6 hours'::interval
  `) ?? []).filter((img) => img.scanRequestedAt && img.scanRequestedAt <= errorRetryDate && img.retryCount < IMAGE_SCANNING_RETRY_LIMIT);

  const images: IngestImageInput[] = [...pendingImages, ...errorImages]

  if (isProd) await sendImagesForScanBulk(images);

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

async function sendImagesForScanBulk(images: IngestImageInput[]) {
  const failedSends: number[] = [];
  const tasks = chunk(images, 250).map((batch, i) => async () => {
    console.log('Ingesting batch', i + 1, 'of', tasks.length);
    const start = Date.now();

    let retryCount = 0,
      success = false;
    while (retryCount < 3) {
      success = await ingestImageBulk({ images: batch });
      if (success) break;
      console.log('Retrying batch', i + 1, 'retry', retryCount + 1);
      retryCount++;
    }
    if (!success) failedSends.push(...batch.map((x) => x.id));
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
  const images = await dbRead.$queryRaw<{ id: number }[]>`
    select id, ingestion, "blockedFor"
    from "Image"
    WHERE "ingestion" = 'Blocked' AND "blockedFor" != 'AiNotVerified'
    AND (
      ("blockedFor" != 'moderated' and "createdAt" <= ${cutoff}) OR
      ("blockedFor" = 'moderated' and "updatedAt" <= ${cutoff})
    )
    ${Prisma.raw(nextCursor ? `AND id > ${nextCursor}` : ``)}
    ORDER BY id
    LIMIT ${limit + 1}
  `;

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
