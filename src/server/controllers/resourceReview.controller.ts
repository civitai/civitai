import { GetResourceReviewPagedInput } from './../schema/resourceReview.schema';
import { GetByIdInput } from '~/server/schema/base.schema';
import {
  CreateResourceReviewInput,
  UpdateResourceReviewInput,
  UpsertResourceReviewInput,
} from '../schema/resourceReview.schema';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwDbError,
} from '~/server/utils/errorHandling';
import {
  deleteResourceReview,
  upsertResourceReview,
  updateResourceReview,
  createResourceReview,
  getPagedResourceReviews,
  toggleExcludeResourceReview,
  getUserRatingTotals,
} from '~/server/services/resourceReview.service';
import { Context } from '~/server/createContext';
import { GetByUsernameSchema } from '~/server/schema/user.schema';
import { dbRead } from '~/server/db/client';
import { hasEntityAccess } from '../services/common.service';
import { redis } from '~/server/redis/client';

export const upsertResourceReviewHandler = async ({
  input,
  ctx,
}: {
  input: UpsertResourceReviewInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const [access] = await hasEntityAccess({
      entityType: 'ModelVersion',
      entityIds: [input.modelVersionId],
      userId: ctx.user.id,
      isModerator: ctx.user.isModerator,
    });

    if (!access?.hasAccess) {
      throw throwAuthorizationError('You do not have access to this model version.');
    }

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
    const [access] = await hasEntityAccess({
      entityType: 'ModelVersion',
      entityIds: [input.modelVersionId],
      userId: ctx.user.id,
      isModerator: ctx.user.isModerator,
    });

    if (!access?.hasAccess) {
      throw throwAuthorizationError('You do not have access to this model version.');
    }

    const result = await createResourceReview({ ...input, userId: ctx.user.id });
    await ctx.track.resourceReview({
      type: 'Create',
      modelId: result.modelId,
      modelVersionId: result.modelVersionId,
      rating: result.recommended ? 5 : 1,
      nsfw: false,
    });
    await redis.del(`user:${ctx.user.id}:model-engagements`);
    return result;
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
    const result = await updateResourceReview({ ...input });
    await ctx.track.resourceReview({
      type: 'Update',
      modelId: result.modelId,
      modelVersionId: result.modelVersionId,
      rating: result.rating,
      nsfw: result.nsfw,
    });
    await redis.del(`user:${ctx.user.id}:model-engagements`);
    return result;
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
    const result = await deleteResourceReview(input);
    await ctx.track.resourceReview({
      type: 'Delete',
      modelId: result.modelId,
      modelVersionId: result.modelVersionId,
      rating: result.rating,
      nsfw: result.nsfw,
    });
    return result;
  } catch (error) {
    throw throwDbError(error);
  }
};

export const toggleExcludeResourceReviewHandler = async ({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const result = await toggleExcludeResourceReview(input);
    await ctx.track.resourceReview({
      type: result.exclude ? 'Exclude' : 'Include',
      modelId: result.modelId,
      modelVersionId: result.modelVersionId,
      rating: result.rating,
      nsfw: result.nsfw,
    });
    return result;
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getUserRatingTotalHandler = async ({ input }: { input: GetByUsernameSchema }) => {
  try {
    const { username } = input;
    const user = await dbRead.user.findUnique({
      where: { username },
    });

    if (!user) {
      throw throwBadRequestError('User not found');
    }

    const rating = await getUserRatingTotals({ userId: user.id });
    return rating;
  } catch (error) {
    throw throwDbError(error);
  }
};
