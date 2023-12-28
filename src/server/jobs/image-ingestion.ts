import { ImageIngestionStatus } from '@prisma/client';
import { chunk } from 'lodash-es';
import { isProd } from '~/env/other';
import { env } from '~/env/server.mjs';
import { BlockedReason } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { createJob } from '~/server/jobs/job';
import { deleteImageById, ingestImageBulk } from '~/server/services/image.service';
import { decreaseDate } from '~/utils/date-helpers';

const IMAGE_SCANNING_ERROR_DELAY = 60 * 1; // 1 hour
const IMAGE_SCANNING_RETRY_LIMIT = 3;
export const ingestImages = createJob('ingest-images', '0 * * * *', async () => {
  // if (!isProd) return;
  const images = await dbRead.image.findMany({
    where: {
      OR: [
        {
          ingestion: ImageIngestionStatus.Pending,
          scanRequestedAt: {
            lte: decreaseDate(new Date(), env.IMAGE_SCANNING_RETRY_DELAY, 'minute'),
          },
        },
        { scanRequestedAt: null, ingestion: ImageIngestionStatus.Pending },
        {
          ingestion: ImageIngestionStatus.Error,
          scanRequestedAt: {
            lte: decreaseDate(new Date(), IMAGE_SCANNING_ERROR_DELAY, 'minute'),
          },
          scanJobs: { path: ['retryCount'], lt: IMAGE_SCANNING_RETRY_LIMIT },
        },
      ],
    },
    select: {
      id: true,
      url: true,
      type: true,
      width: true,
      height: true,
    },
  });

  if (!isProd) {
    console.log(images.length);
    return;
  }

  const batches = chunk(images, 250);
  for (const batch of batches) {
    await ingestImageBulk({ images: batch });
  }
});

export const removeBlockedImages = createJob('remove-blocked-images', '0 23 * * *', async () => {
  if (!isProd) return;
  const images = await dbRead.image.findMany({
    where: {
      ingestion: ImageIngestionStatus.Blocked,
      OR: [
        { createdAt: { lte: decreaseDate(new Date(), 7, 'days') } },
        { blockedFor: BlockedReason.Moderated },
      ],
    },
    select: { id: true },
  });
  if (!images.length) return;

  if (!isProd) {
    console.log(images.length);
    return;
  }

  const toRemove = images.map((x) => x.id);
  const batches = chunk(toRemove, 3);
  for (const batch of batches) {
    await Promise.all(batch.map((id) => deleteImageById({ id })));
  }
});
