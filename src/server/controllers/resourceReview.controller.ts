import { GetByIdInput } from '~/server/schema/base.schema';
import {
  CreateResourceReviewInput,
  GetRatingTotalsInput,
  GetResourceReviewsInfiniteInput,
  UpdateResourceReviewInput,
  UpsertResourceReviewInput,
} from '../schema/resourceReview.schema';
import { throwDbError } from '~/server/utils/errorHandling';
import { GetResourceReviewsInput } from '~/server/schema/resourceReview.schema';
import {
  getResourceReview,
  deleteResourceReview,
  getRatingTotals,
  getResourceReviews,
  getResourceReviewsInfinite,
  upsertResourceReview,
  updateResourceReview,
  createResourceReview,
} from '~/server/services/resourceReview.service';
import { Context } from '~/server/createContext';

export const getResourceReviewHandler = async ({ input }: { input: GetByIdInput }) => {
  try {
    return await getResourceReview(input);
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getResourceReviewsHandler = async ({ input }: { input: GetResourceReviewsInput }) => {
  try {
    return await getResourceReviews(input);
  } catch (error) {
    throw throwDbError(error);
  }
};

export type ResourceReviewInfiniteModel = AsyncReturnType<
  typeof getResourceReviewsInfiniteHandler
>['items'][0];
export const getResourceReviewsInfiniteHandler = async ({
  input,
}: {
  input: GetResourceReviewsInfiniteInput;
}) => {
  try {
    return await getResourceReviewsInfinite(input);
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getRatingTotalsHandler = async ({
  input,
  ctx,
}: {
  input: GetRatingTotalsInput;
  ctx: Context;
}) => {
  try {
    return await getRatingTotals({ ...input });
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

export const createResourceReviewHandler = async ({
  input,
  ctx,
}: {
  input: CreateResourceReviewInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    return await createResourceReview({ ...input, userId: ctx.user.id });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const updateResourceReviewHandler = async ({
  input,
  ctx,
}: {
  input: UpdateResourceReviewInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    return await updateResourceReview({ ...input });
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
