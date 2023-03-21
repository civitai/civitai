import { GetByIdInput } from '~/server/schema/base.schema';
import { UpsertResourceReviewInput } from '../schema/resourceReview.schema';
import { throwDbError } from '~/server/utils/errorHandling';
import { GetResourceReviewsInput } from '~/server/schema/resourceReview.schema';
import {
  deleteResourceReview,
  getResourceReviews,
  upsertResourceReview,
} from '~/server/services/resourceReview.service';
import { Context } from '~/server/createContext';

export const getResourceReviewHandler = async ({ input }: { input: GetResourceReviewsInput }) => {
  try {
    return await getResourceReviews(input);
  } catch (error) {
    throw throwDbError(error);
  }
};

export const upsertResourceReviewHandler = async ({
  input,
  ctx,
}: {
  input: UpsertResourceReviewInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    return await upsertResourceReview({ ...input, userId: ctx.user.id });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const deleteResourceReviewHandler = async ({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    return await deleteResourceReview(input);
  } catch (error) {
    throw throwDbError(error);
  }
};
