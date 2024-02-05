import { ImageIngestionStatus } from '@prisma/client';
import { chunk } from 'lodash-es';
import { isProd } from '~/env/other';
import { env } from '~/env/server.mjs';
import { BlockedReason, ImageType } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { createJob } from '~/server/jobs/job';
import { IngestImageInput } from '~/server/schema/image.schema';
import { deleteImageById, ingestImageBulk } from '~/server/services/image.service';
import { decreaseDate } from '~/utils/date-helpers';

const IMAGE_SCANNING_ERROR_DELAY = 60 * 1; // 1 hour
const IMAGE_SCANNING_RETRY_LIMIT = 3;
const rescanInterval = `${env.IMAGE_SCANNING_RETRY_DELAY} minutes`;
const errorInterval = `${IMAGE_SCANNING_ERROR_DELAY} minutes`;

export const ingestImages = createJob('ingest-images', '0 * * * *', async () => {
  // if (!isProd) return;
  const images = await dbWrite.$queryRaw<IngestImageInput[]>`
    SELECT id, url, type, width, height
    FROM "Image"
    WHERE (
        ingestion = ${ImageIngestionStatus.Pending}::"ImageIngestionStatus"
        AND ("scanRequestedAt" IS NULL OR "scanRequestedAt" <= now() - ${rescanInterval}::interval)
      ) OR (
        ingestion = ${ImageIngestionStatus.Error}::"ImageIngestionStatus"
        AND "scanRequestedAt" <= now() - ${errorInterval}::interval
        AND ("scanJobs"->>'retryCount')::int < ${IMAGE_SCANNING_RETRY_LIMIT}
      )
  `;

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
