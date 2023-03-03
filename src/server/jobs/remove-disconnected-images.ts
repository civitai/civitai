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
        await deleteImage(image.url);
        await dbWrite.image.delete({ where: { id: image.id } });
      } catch {
        // Ignore errors
      }
    }
  }
);
