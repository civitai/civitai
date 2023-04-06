import { createJob } from './job';
import { dbRead, dbWrite } from '~/server/db/client';
import { deleteImage } from '~/utils/cf-images-utils';
import { imageUrlInUse } from '~/server/services/image.service';
import { isProd } from '~/env/other';

export const removeDisconnectedImages = createJob(
  'remove-disconnected-images',
  '7 1 * * *',
  async () => {
    // TODO Justin - Adjust this to only delete images not tied to a post
    // const disconnectedImages = await dbRead.image.findMany({
    //   where: {
    //     connections: {
    //       modelId: null,
    //     },
    //   },
    //   select: {
    //     id: true,
    //     url: true,
    //   },
    // });
    // for (const image of disconnectedImages) {
    //   try {
    //     if (isProd && !imageUrlInUse(image)) await deleteImage(image.url);
    //     await dbWrite.image.delete({ where: { id: image.id } });
    //   } catch {
    //     // Ignore errors
    //   }
    // }
  }
);
