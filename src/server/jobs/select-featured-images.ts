import { createJob } from './job';
import { prisma } from '~/server/db/client';

const unfeaturedCategories = ['porn', 'hentai'];
const featuredPerCategory = 10;
export const selectFeaturedImages = createJob(
  'select-featured-images',
  '3 1 * * *',
  async () => {
    await prisma.$executeRawUnsafe(
      `SELECT feature_images('${unfeaturedCategories.join(',')}', ${featuredPerCategory});`
    );
  },
  {
    shouldWait: false,
  }
);
