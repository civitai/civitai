import { isProd } from '~/env/other';
import { dbRead } from '~/server/db/client';
import { createJob } from '~/server/jobs/job';
import { ingestImage } from '~/server/services/image.service';
import { decreaseDate } from '~/utils/date-helpers';

export const ingestImages = createJob('ingest-images', '*/4 * * * *', async () => {
  if (!isProd) return;
  const images = await dbRead.image.findMany({
    where: { OR: [{ scanRequestedAt: { not: null }, scannedAt: null }, { scanRequestedAt: null }] },
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

  const result = await Promise.all(toIngest.map((image) => ingestImage({ image })));
});
