import { prisma } from '~/server/db/client';
import { imageSelect } from '~/server/selectors/image.selector';

export const getModelVersionImages = async ({ modelVersionId }: { modelVersionId: number }) => {
  const result = await prisma.imagesOnModels.findMany({
    where: { modelVersionId },
    select: { image: { select: imageSelect } },
  });
  return result.map((x) => x.image);
};

export const getReviewImages = async ({ reviewId }: { reviewId: number }) => {
  const result = await prisma.imagesOnReviews.findMany({
    where: { reviewId },
    select: { image: { select: imageSelect } },
  });
  return await result.map((x) => x.image);
};
