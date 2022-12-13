import { GetModelVersionImagesSchema, GetReviewImagesSchema } from './../schema/image.schema';
import { getModelVersionImages, getReviewImages } from './../services/image.service';

export const getModelVersionImagesHandler = async ({
  input: { modelVersionId },
}: {
  input: GetModelVersionImagesSchema;
}) => getModelVersionImages({ modelVersionId });

export const getReviewImagesHandler = async ({
  input: { reviewId },
}: {
  input: GetReviewImagesSchema;
}) => getReviewImages({ reviewId });
