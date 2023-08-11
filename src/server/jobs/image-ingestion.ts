import { ImageIngestionStatus } from '@prisma/client';
import { chunk } from 'lodash';
import { isProd } from '~/env/other';
import { dbRead } from '~/server/db/client';
import { createJob } from '~/server/jobs/job';
import { deleteImageById, ingestImage } from '~/server/services/image.service';
import { decreaseDate } from '~/utils/date-helpers';

export const ingestImages = createJob('ingest-images', '0 * * * *', async () => {
  // if (!isProd) return;
  const images = await dbRead.image.findMany({
    where: {
      OR: [
        {
          scanRequestedAt: { lte: decreaseDate(new Date(), 5, 'minute') },
          ingestion: ImageIngestionStatus.Pending,
        },
        { scanRequestedAt: null },
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

  const batches = chunk(images, 50);
  for (const batch of batches) {
    await Promise.all(batch.map((image) => ingestImage({ image })));
  }
});

export const removeBlockedImages = createJob('remove-blocked-images', '0 23 * * *', async () => {
  // if (!isProd) return;
  const images = await dbRead.image.findMany({
    where: { ingestion: ImageIngestionStatus.Blocked },
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
