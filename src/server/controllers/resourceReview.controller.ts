import type { Context } from '~/server/createContext';
import { dbRead } from '~/server/db/client';
import { redis, REDIS_KEYS, REDIS_SUB_KEYS } from '~/server/redis/client';
import type { GetByIdInput } from '~/server/schema/base.schema';
import type { GetByUsernameSchema } from '~/server/schema/user.schema';
import {
  createResourceReview,
  deleteResourceReview,
  getUserRatingTotals,
  toggleExcludeResourceReview,
  updateResourceReview,
  upsertResourceReview,
} from '~/server/services/resourceReview.service';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwDbError,
} from '~/server/utils/errorHandling';
import { updateEntityMetric } from '~/server/utils/metric-helpers';
import type { EntityMetric_MetricType_Type } from '~/shared/utils/prisma/enums';
import type {
  CreateResourceReviewInput,
  UpdateResourceReviewInput,
  UpsertResourceReviewInput,
} from '../schema/resourceReview.schema';
import { hasEntityAccess } from '../services/common.service';

/**
 * Helper to update review metrics for both model and model version
 */
async function updateReviewMetrics({
  ctx,
  modelId,
  modelVersionId,
  metricType,
  amount,
}: {
  ctx: DeepNonNullable<Context>;
  modelId?: number | null;
  modelVersionId?: number | null;
  metricType: EntityMetric_MetricType_Type;
  amount: number;
}) {
  const updates = [];

  if (modelId) {
    updates.push(
      updateEntityMetric({
        ctx,
        entityType: 'Model',
        entityId: modelId,
        metricType,
        amount,
      })
    );
  }

  if (modelVersionId) {
    updates.push(
      updateEntityMetric({
        ctx,
        entityType: 'ModelVersion',
        entityId: modelVersionId,
        metricType,
        amount,
      })
    );
  }

  await Promise.all(updates);
}

/**
 * Helper to handle review rating changes (for updates)
 */
async function handleReviewRatingChange({
  ctx,
  oldReview,
  newRecommended,
}: {
  ctx: DeepNonNullable<Context>;
  oldReview: { recommended: boolean; modelId?: number | null; modelVersionId?: number | null };
  newRecommended: boolean;
}) {
  const oldMetricType = oldReview.recommended ? 'ThumbsUp' : 'ThumbsDown';
  const newMetricType = newRecommended ? 'ThumbsUp' : 'ThumbsDown';

  // Remove old rating
  await updateReviewMetrics({
    ctx,
    modelId: oldReview.modelId,
    modelVersionId: oldReview.modelVersionId,
    metricType: oldMetricType,
    amount: -1,
  });

  // Add new rating
  await updateReviewMetrics({
    ctx,
    modelId: oldReview.modelId,
    modelVersionId: oldReview.modelVersionId,
    metricType: newMetricType,
    amount: 1,
  });
}

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

    // Check if this is an update or create
    let oldReview = null;
    if (input.id) {
      oldReview = await dbRead.resourceReview.findUnique({
        where: { id: input.id },
        select: { recommended: true, modelId: true, modelVersionId: true },
      });
    }

    const result = await upsertResourceReview({ ...input, userId: ctx.user.id });

    // For updates, we need to get the full review data since update only returns { id }
    // Cast result as it has full data when creating (not updating)
    const review = oldReview
      ? { ...oldReview, ...input }
      : (result as { id: number; modelId: number; modelVersionId: number; recommended: boolean });

    // Track metrics based on whether it's create or update
    if (!oldReview) {
      // New review - add metrics
      const metricType = review.recommended ? 'ThumbsUp' : 'ThumbsDown';
      await updateReviewMetrics({
        ctx,
        modelId: review.modelId,
        modelVersionId: review.modelVersionId,
        metricType,
        amount: 1,
      });
    } else if (input.recommended !== undefined && oldReview.recommended !== input.recommended) {
      // Update with rating change
      await handleReviewRatingChange({
        ctx,
        oldReview,
        newRecommended: input.recommended,
      });
    }

    return result;
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

    // Track entity metrics for model ratings
    const metricType = result.recommended ? 'ThumbsUp' : 'ThumbsDown';
    await updateReviewMetrics({
      ctx,
      modelId: result.modelId,
      modelVersionId: result.modelVersionId,
      metricType,
      amount: 1,
    });

    await redis.del(
      `${REDIS_KEYS.USER.BASE}:${ctx.user.id}:${REDIS_SUB_KEYS.USER.MODEL_ENGAGEMENTS}`
    );
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
    // Get the old review to compare
    const oldReview = await dbRead.resourceReview.findUnique({
      where: { id: input.id },
      select: { recommended: true, modelId: true, modelVersionId: true },
    });

    const result = await updateResourceReview({ ...input });
    await ctx.track.resourceReview({
      type: 'Update',
      modelId: result.modelId,
      modelVersionId: result.modelVersionId,
      rating: result.rating,
      nsfw: result.nsfw,
    });

    // Handle rating changes for entity metrics
    if (
      oldReview &&
      input.recommended !== undefined &&
      oldReview.recommended !== input.recommended
    ) {
      await handleReviewRatingChange({
        ctx,
        oldReview: { ...oldReview, modelId: result.modelId, modelVersionId: result.modelVersionId },
        newRecommended: input.recommended,
      });
    }

    await redis.del(
      `${REDIS_KEYS.USER.BASE}:${ctx.user.id}:${REDIS_SUB_KEYS.USER.MODEL_ENGAGEMENTS}`
    );
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

    // Remove rating from entity metrics
    const metricType = result.recommended ? 'ThumbsUp' : 'ThumbsDown';
    await updateReviewMetrics({
      ctx,
      modelId: result.modelId,
      modelVersionId: result.modelVersionId,
      metricType,
      amount: -1,
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
