import { createJob } from './job';
import { dbWrite } from '~/server/db/client';

const featuredPerCategory = 10;
export const selectFeaturedImages = createJob('select-featured-images', '3 1 * * *', async () => {
  await dbWrite.$executeRawUnsafe(`SELECT feature_images(${featuredPerCategory});`);
});
