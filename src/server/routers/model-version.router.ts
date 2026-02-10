import {
  declineReviewHandler,
  deleteModelVersionHandler,
  earlyAccessModelVersionsOnTimeframeHandler,
  getModelVersionForTrainingReviewHandler,
  getModelVersionHandler,
  getModelVersionOwnerHandler,
  getModelVersionRunStrategiesHandler,
  getVersionLicenseHandler,
  modelVersionDonationGoalsHandler,
  modelVersionEarlyAccessPurchaseHandler,
  modelVersionGeneratedImagesOnTimeframeHandler,
  publishModelVersionHandler,
  publishPrivateModelVersionHandler,
  recheckModelVersionTrainingStatusHandler,
  requestReviewHandler,
  toggleNotifyEarlyAccessHandler,
  unpublishModelVersionHandler,
  upsertModelVersionHandler,
} from '~/server/controllers/model-version.controller';
import { getByIdSchema } from '~/server/schema/base.schema';
import {
  deleteExplorationPromptSchema,
  earlyAccessModelVersionsOnTimeframeSchema,
  getModelVersionByModelTypeSchema,
  getModelVersionPopularityInput,
  getModelVersionSchema,
  getModelVersionsPopularityInput,
  modelVersionEarlyAccessPurchase,
  modelVersionsGeneratedImagesOnTimeframeSchema,
  modelVersionUpsertSchema2,
  publishVersionSchema,
  upsertExplorationPromptSchema,
  getModelVersionsByIdsInput,
} from '~/server/schema/model-version.schema';
import { declineReviewSchema, unpublishModelSchema } from '~/server/schema/model.schema';
import { enqueueJobs } from '~/server/services/job-queue.service';
import {
  deleteExplorationPrompt,
  getExplorationPromptsById,
  getModelVersionPopularity,
  getModelVersionsByModelType,
  getModelVersionsPopularity,
  getVersionById,
  getVersionsByIds,
  upsertExplorationPrompt,
  bustMvCache,
} from '~/server/services/model-version.service';
import { getModel } from '~/server/services/model.service';
import {
  guardedProcedure,
  isFlagProtected,
  middleware,
  moderatorProcedure,
  protectedProcedure,
  publicProcedure,
  router,
} from '~/server/trpc';
import { throwAuthorizationError } from '~/server/utils/errorHandling';
import { EntityType, JobQueueType } from '~/shared/utils/prisma/enums';

const isOwnerOrModerator = middleware(async ({ ctx, input, next }) => {
  if (!ctx.user) throw throwAuthorizationError();
  if (ctx.user.isModerator) return next({ ctx: { user: ctx.user } });

  const { id: userId } = ctx.user;
  const { id } = input as { id: number };

  if (id) {
    const modelId = (await getVersionById({ id, select: { modelId: true } }))?.modelId ?? 0;
    const ownerId = (await getModel({ id: modelId, select: { userId: true } }))?.userId ?? -1;

    if (userId !== ownerId) throw throwAuthorizationError();
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

export const modelVersionRouter = router({
  getById: publicProcedure.input(getModelVersionSchema).query(getModelVersionHandler),
  getOwner: publicProcedure.input(getByIdSchema).query(getModelVersionOwnerHandler),
  getRunStrategies: publicProcedure.input(getByIdSchema).query(getModelVersionRunStrategiesHandler),
  getPopularity: publicProcedure
    .input(getModelVersionPopularityInput)
    .query(({ input }) => getModelVersionPopularity(input)),
  getPopularities: publicProcedure
    .input(getModelVersionsPopularityInput)
    .query(({ input }) => getModelVersionsPopularity(input)),
  getVersionsByIds: publicProcedure
    .input(getModelVersionsByIdsInput)
    .query(({ input }) => getVersionsByIds(input)),
  getExplorationPromptsById: publicProcedure
    .input(getByIdSchema)
    .query(({ input }) => getExplorationPromptsById(input)),
  toggleNotifyEarlyAccess: protectedProcedure
    .input(getByIdSchema)
    .use(isFlagProtected('earlyAccessModel'))
    .mutation(toggleNotifyEarlyAccessHandler),
  upsert: guardedProcedure
    .input(modelVersionUpsertSchema2)
    .use(isOwnerOrModerator)
    .mutation(upsertModelVersionHandler),
  delete: protectedProcedure
    .input(getByIdSchema)
    .use(isOwnerOrModerator)
    .mutation(deleteModelVersionHandler),
  publish: guardedProcedure
    .input(publishVersionSchema)
    .use(isOwnerOrModerator)
    .mutation(publishModelVersionHandler),
  unpublish: protectedProcedure
    .input(unpublishModelSchema)
    .use(isOwnerOrModerator)
    .mutation(unpublishModelVersionHandler),
  upsertExplorationPrompt: protectedProcedure
    .input(upsertExplorationPromptSchema)
    .use(isOwnerOrModerator)
    .mutation(({ input }) => upsertExplorationPrompt(input)),
  deleteExplorationPrompt: protectedProcedure
    .input(deleteExplorationPromptSchema)
    .use(isOwnerOrModerator)
    .mutation(({ input }) => deleteExplorationPrompt(input)),
  requestReview: protectedProcedure
    .input(getByIdSchema)
    .use(isOwnerOrModerator)
    .mutation(requestReviewHandler),
  declineReview: moderatorProcedure.input(declineReviewSchema).mutation(declineReviewHandler),
  getModelVersionsByModelType: protectedProcedure
    .input(getModelVersionByModelTypeSchema)
    .query(({ input }) => getModelVersionsByModelType(input)),
  earlyAccessModelVersionsOnTimeframe: protectedProcedure
    .input(earlyAccessModelVersionsOnTimeframeSchema)
    .query(earlyAccessModelVersionsOnTimeframeHandler),
  modelVersionsGeneratedImagesOnTimeframe: protectedProcedure
    .input(modelVersionsGeneratedImagesOnTimeframeSchema)
    .query(modelVersionGeneratedImagesOnTimeframeHandler),
  getLicense: publicProcedure.input(getByIdSchema).query(getVersionLicenseHandler),
  earlyAccessPurchase: protectedProcedure
    .input(modelVersionEarlyAccessPurchase)
    .mutation(modelVersionEarlyAccessPurchaseHandler),
  donationGoals: publicProcedure.input(getByIdSchema).query(modelVersionDonationGoalsHandler),
  getTrainingDetails: moderatorProcedure
    .input(getByIdSchema)
    .query(getModelVersionForTrainingReviewHandler),
  publishPrivateModelVersion: guardedProcedure
    .input(getByIdSchema)
    .mutation(publishPrivateModelVersionHandler),
  bustCache: moderatorProcedure.input(getByIdSchema).mutation(({ input }) => bustMvCache(input.id)),
  enqueueNsfwLevelUpdate: moderatorProcedure.input(getByIdSchema).mutation(({ input }) =>
    enqueueJobs([
      {
        entityId: input.id,
        entityType: EntityType.ModelVersion,
        type: JobQueueType.UpdateNsfwLevel,
      },
    ])
  ),
  recheckTrainingStatus: guardedProcedure
    .input(getByIdSchema)
    .use(isOwnerOrModerator)
    .mutation(recheckModelVersionTrainingStatusHandler),
});
