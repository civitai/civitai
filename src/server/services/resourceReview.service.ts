import { GetByIdInput } from '~/server/schema/base.schema';
import { UpsertResourceReviewInput } from '../schema/resourceReview.schema';
import { dbWrite } from '~/server/db/client';
import { GetResourceReviewsInput } from '~/server/schema/resourceReview.schema';

export const getResourceReviews = async ({ resourceIds }: GetResourceReviewsInput) => {
  return await dbWrite.resourceReview.findMany({
    where: { modelVersionId: { in: resourceIds } },
    select: {
      id: true,
      modelVersionId: true,
      rating: true,
      details: true,
    },
  });
};

export const upsertResourceReview = async (
  data: UpsertResourceReviewInput & { userId: number }
) => {
  return await dbWrite.resourceReview.upsert({
    where: { id: data.id },
    update: data,
    create: data,
    select: { id: true },
  });
};

export const deleteResourceReview = async ({ id }: GetByIdInput) => {
  return await dbWrite.resourceReview.delete({ where: { id } });
};
