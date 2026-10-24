import { dbWrite } from '~/server/db/client';
import { middleware, moderatorProcedure, protectedProcedure, router } from '~/server/trpc';
import { throwAuthorizationError } from '~/server/utils/errorHandling';
import {
  addPostTagHandler,
  addResourceToPostImageHandler,
  createPostHandler,
  createPostWithImagesHandler,
  deletePostHandler,
  getPostContestCollectionDetailsHandler,
  getPostHandler,
  getPostResourcesHandler,
  getPostsInfiniteHandler,
  getPostTagsHandler,
  removePostTagHandler,
  removeResourceFromPostImageHandler,
  reorderPostImagesHandler,
  updatePostCollectionTagIdHandler,
  updatePostHandler,
  updatePostImageHandler,
} from './../controllers/post.controller';
import { applyUserPreferences, rateLimit } from './../middleware.trpc';
import { CacheTTL } from '~/server/common/constants';
import { getByIdSchema } from './../schema/base.schema';
import {
  addPostTagSchema,
  addResourceToPostImageInput,
  createPostWithImagesSchema,
  getPostTagsSchema,
  getImageMoveTargetsSchema,
  moveImagesToPostSchema,
  getScheduledPostsSchema,
  plannerPostIdSchema,
  plannerPublishNowSchema,
  plannerRescheduleSchema,
  plannerShiftSchema,
  plannerUnscheduleSchema,
  postAddImageInput,
  postCreateSchema,
  postRateLimits,
  postsQuerySchema,
  postUpdateSchema,
  removePostTagSchema,
  removeResourceFromPostImageInput,
  reorderPostImagesSchema,
  scheduleBatchSchema,
  updatePostCollectionTagIdInput,
  updatePostImageSchema,
  validateBatchScheduleSchema,
} from './../schema/post.schema';
import { addPostImage, getPostEditDetail, getPostImageIds } from './../services/post.service';
import { getImageMoveTargets, moveImagesToPost } from './../services/post-image-move.service';
import {
  getPlannerPostDetail,
  getScheduledPosts,
  reschedulePlannerPost,
  shiftPlannerPosts,
  unschedulePlannerPosts,
} from './../services/post-planner.service';
import { scheduleBatch, validateBatchSchedule } from './../services/post-batch.service';
import { guardedProcedure, isFlagProtected, publicProcedure, verifiedProcedure } from './../trpc';
import { enqueueJobs } from '~/server/services/job-queue.service';
import { EntityType, JobQueueType } from '~/shared/utils/prisma/enums';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { STORYLINE_SUBMIT_RATE_LIMIT } from '~/shared/utils/storyline-placement';
import type { PostUpdateInput } from '~/server/schema/post.schema';

const isOwnerOrModerator = middleware(async ({ ctx, next, input = {} }) => {
  if (!ctx.user) throw throwAuthorizationError();

  const { id } = input as { id: number };

  const userId = ctx.user.id;
  const isModerator = ctx?.user?.isModerator;
  if (!isModerator && !!id) {
    const ownerId = (await dbWrite.post.findUnique({ where: { id }, select: { userId: true } }))
      ?.userId;
    if (ownerId !== userId) throw throwAuthorizationError();
  }

  return next({
    ctx: {
      // infers the `user` as non-nullable
      user: ctx.user,
    },
  });
});

// TODO.hotfix: added this middleware to allow editing images and check if it's the owner
const isImageOwnerOrModerator = middleware(async ({ ctx, next, input = {} }) => {
  if (!ctx.user) throw throwAuthorizationError();

  const userId = ctx.user.id;
  const isModerator = ctx?.user?.isModerator;

  const { id: inputId } = input as { id: number | number[] | null };

  if (!isModerator && !!inputId) {
    const ids = !Array.isArray(inputId) ? [inputId] : inputId;
    const images = await dbWrite.image.findMany({
      where: { id: { in: ids } },
      select: { userId: true },
    });
    if (images.some((i) => i.userId !== userId)) throw throwAuthorizationError();
  }

  return next({
    ctx: {
      // infers the `user` as non-nullable
      user: ctx.user,
    },
  });
});

export const postRouter = router({
  getInfinite: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(postsQuerySchema)
    .use(applyUserPreferences)
    .query(getPostsInfiniteHandler),
  get: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getByIdSchema)
    .query(getPostHandler),
  getEdit: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getByIdSchema)
    .query(({ ctx, input }) => getPostEditDetail({ ...input, user: ctx.user })),
  getImageIds: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getByIdSchema)
    .query(({ ctx, input }) => getPostImageIds({ ...input, user: ctx.user })),
  create: guardedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(postCreateSchema)
    .use(rateLimit(postRateLimits, undefined, { sharedKey: 'post:create' }))
    .mutation(createPostHandler),
  createWithImages: guardedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(createPostWithImagesSchema)
    .use(rateLimit(postRateLimits, undefined, { sharedKey: 'post:create' }))
    .mutation(createPostWithImagesHandler),
  update: verifiedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(postUpdateSchema)
    .use(isOwnerOrModerator)
    // A publish that submits a drafted continuation counts against the submit quota. Every one
    // carries `expectedPrice`: without it the price check refuses the submission.
    .use(
      rateLimit(
        {
          limit: STORYLINE_SUBMIT_RATE_LIMIT.limit,
          period: STORYLINE_SUBMIT_RATE_LIMIT.period,
          errorMessage: STORYLINE_SUBMIT_RATE_LIMIT.errorMessage,
        },
        (input: PostUpdateInput) => input.expectedPrice !== undefined,
        { sharedKey: STORYLINE_SUBMIT_RATE_LIMIT.rateLimitKey }
      )
    )
    .mutation(updatePostHandler),
  delete: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaDelete })
    .input(getByIdSchema)
    .use(isOwnerOrModerator)
    .mutation(deletePostHandler),
  addImage: guardedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(postAddImageInput)
    .mutation(({ ctx, input }) => addPostImage({ ...input, user: ctx.user })),
  updateImage: verifiedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(updatePostImageSchema)
    .use(isImageOwnerOrModerator)
    .mutation(updatePostImageHandler),
  addResourceToImage: verifiedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(addResourceToPostImageInput)
    .use(isImageOwnerOrModerator)
    .mutation(addResourceToPostImageHandler),
  removeResourceFromImage: verifiedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(removeResourceFromPostImageInput)
    .use(isImageOwnerOrModerator)
    .mutation(removeResourceFromPostImageHandler),
  reorderImages: verifiedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(reorderPostImagesSchema)
    .use(isOwnerOrModerator)
    .mutation(reorderPostImagesHandler),
  getImageMoveTargets: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getImageMoveTargetsSchema)
    .query(({ ctx, input }) => getImageMoveTargets({ ...input, userId: ctx.user.id })),
  moveImages: verifiedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(moveImagesToPostSchema)
    .mutation(({ ctx, input }) => moveImagesToPost({ ...input, userId: ctx.user.id })),
  getTags: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getPostTagsSchema)
    .use(applyUserPreferences)
    .query(getPostTagsHandler),
  addTag: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(addPostTagSchema)
    .use(isOwnerOrModerator)
    .mutation(addPostTagHandler),
  removeTag: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(removePostTagSchema)
    .use(isOwnerOrModerator)
    .mutation(removePostTagHandler),
  getResources: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getByIdSchema)
    .query(getPostResourcesHandler),
  getContestCollectionDetails: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getByIdSchema)
    .query(getPostContestCollectionDetailsHandler),
  updateCollectionTagId: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(updatePostCollectionTagIdInput)
    .use(isOwnerOrModerator)
    .mutation(updatePostCollectionTagIdHandler),
  getScheduled: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getScheduledPostsSchema)
    .use(isFlagProtected('postPlanner'))
    .query(({ ctx, input }) => getScheduledPosts({ ...input, user: ctx.user })),
  getPlannerDetail: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(plannerPostIdSchema)
    .use(isFlagProtected('postPlanner'))
    .query(({ ctx, input }) => getPlannerPostDetail({ ...input, user: ctx.user })),
  reschedule: verifiedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(plannerRescheduleSchema)
    .use(rateLimit({ limit: 60, period: CacheTTL.md }, undefined, { sharedKey: 'post:planner' }))
    .use(isFlagProtected('postPlanner'))
    .mutation(({ ctx, input }) =>
      reschedulePlannerPost({
        id: input.id,
        target: input.publishedAt,
        expectedScope: input.expectedScope,
        ctx,
      })
    ),
  publishNow: verifiedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(plannerPublishNowSchema)
    .use(rateLimit({ limit: 60, period: CacheTTL.md }, undefined, { sharedKey: 'post:planner' }))
    .use(isFlagProtected('postPlanner'))
    .mutation(({ ctx, input }) =>
      reschedulePlannerPost({
        id: input.id,
        target: 'now',
        expectedScope: input.expectedScope,
        ctx,
      })
    ),
  unschedule: verifiedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(plannerUnscheduleSchema)
    .use(rateLimit({ limit: 60, period: CacheTTL.md }, undefined, { sharedKey: 'post:planner' }))
    .use(isFlagProtected('postPlanner'))
    .mutation(({ ctx, input }) => unschedulePlannerPosts({ ...input, user: ctx.user })),
  shiftSchedule: verifiedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(plannerShiftSchema)
    .use(rateLimit({ limit: 60, period: CacheTTL.md }, undefined, { sharedKey: 'post:planner' }))
    .use(isFlagProtected('postPlanner'))
    .mutation(({ ctx, input }) => shiftPlannerPosts({ ...input, user: ctx.user })),
  validateBatchSchedule: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(validateBatchScheduleSchema)
    .use(isFlagProtected('batchPostScheduling'))
    .query(({ ctx, input }) => validateBatchSchedule({ input, user: ctx.user })),
  scheduleBatch: guardedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(scheduleBatchSchema)
    .use(isFlagProtected('batchPostScheduling'))
    .use(rateLimit({ limit: 30, period: CacheTTL.hour }))
    .mutation(({ ctx, input }) => scheduleBatch({ input, ctx })),
  enqueueNsfwLevelUpdate: moderatorProcedure.input(getByIdSchema).mutation(({ input }) =>
    enqueueJobs([
      {
        entityId: input.id,
        entityType: EntityType.Post,
        type: JobQueueType.UpdateNsfwLevel,
      },
    ])
  ),
});
