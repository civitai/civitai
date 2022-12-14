import { throwDbError } from '~/server/utils/errorHandling';
import { GetModelVersionImagesSchema, GetReviewImagesSchema } from './../schema/image.schema';
import { getModelVersionImages, getReviewImages } from './../services/image.service';

export const getModelVersionImagesHandler = async ({
  input: { modelVersionId },
}: {
  input: GetModelVersionImagesSchema;
}) => {
  try {
    return await getModelVersionImages({ modelVersionId });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getReviewImagesHandler = async ({
  input: { reviewId },
}: {
  input: GetReviewImagesSchema;
}) => {
  try {
    return await getReviewImages({ reviewId });
  } catch (error) {
    throw throwDbError(error);
  }
};
