import { ImageIngestionStatus } from '@prisma/client';
import { isProd } from '~/env/other';
import { dbRead } from '~/server/db/client';
import { createJob } from '~/server/jobs/job';
import { deleteImageById, ingestImage } from '~/server/services/image.service';
import { decreaseDate } from '~/utils/date-helpers';

export const ingestImages = createJob('ingest-images', '0 * * * *', async () => {
  if (!isProd) return;
  const images = await dbRead.image.findMany({
    where: {
      OR: [
        {
          scanRequestedAt: { not: null },
          scannedAt: null,
          ingestion: ImageIngestionStatus.Pending,
        },
        { scanRequestedAt: null },
      ],
    },
    select: {
      id: true,
      url: true,
      scanRequestedAt: true,
    },
  });

  const buffer = decreaseDate(new Date(), 5, 'minute');
  const toIngest = images.filter(
    (x) => !x.scanRequestedAt || x.scanRequestedAt.getTime() <= buffer.getTime()
  );

  await Promise.all(toIngest.map((image) => ingestImage({ image })));
});

export const removeBlockedImages = createJob('remove-blocked-images', '0 23 * * *', async () => {
  if (!isProd) return;
  const images = await dbRead.image.findMany({
    where: { ingestion: ImageIngestionStatus.Blocked },
    select: { id: true },
  });
  if (!images.length) return;

  const toRemove = images.map((x) => x.id);
  await Promise.all(toRemove.map((id) => deleteImageById({ id })));
});
