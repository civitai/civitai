import { createJob } from './job';
import { dbRead, dbWrite } from '~/server/db/client';
import { deleteImage } from '~/utils/cf-images-utils';

export const removeDisconnectedImages = createJob(
  'remove-disconnected-images',
  '7 1 * * *',
  async () => {
    const disconnectedImages = await dbRead.image.findMany({
      where: {
        connections: {
          modelId: null,
        },
      },
      select: {
        id: true,
        url: true,
      },
    });

    for (const image of disconnectedImages) {
      try {
        const otherImagesWithSameUrl = await dbWrite.image.count({
          where: {
            url: image.url,
            id: { not: image.id },
            connections: { modelId: { not: null } },
          },
        });
        if (otherImagesWithSameUrl == 0) await deleteImage(image.url);
        await dbWrite.image.delete({ where: { id: image.id } });
      } catch {
        // Ignore errors
      }
    }
  }
);
