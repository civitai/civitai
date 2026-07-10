import {
  declineReviewHandler,
  deleteModelVersionHandler,
  earlyAccessModelVersionsOnTimeframeHandler,
  getModelVersionForEditHandler,
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
  mergeVersionsSchema,
  deleteExplorationPromptSchema,
  earlyAccessModelVersionsOnTimeframeSchema,
  getLicensingRootsSchema,
  getModelVersionByModelTypeSchema,
  getModelVersionPopularityInput,
  getModelVersionSchema,
  getModelVersionsPopularityInput,
  modelVersionEarlyAccessPurchase,
  modelVersionsGeneratedImagesOnTimeframeSchema,
  modelVersionUpsertSchema2,
  publishVersionSchema,
  addLinkedComponentSchema,
  linkOfficialFileByHashSchema,
  setLinkedComponentsSchema,
  upsertExplorationPromptSchema,
  getModelVersionsByIdsInput,
} from '~/server/schema/model-version.schema';
import { declineReviewSchema, unpublishModelSchema } from '~/server/schema/model.schema';
import { enqueueJobs } from '~/server/services/job-queue.service';
import {
  deleteExplorationPrompt,
  getExplorationPromptsById,
  getModelVersionPopularity,
  getLicensingRoots,
  getModelVersionsByModelType,
  getModelVersionsPopularity,
  getVersionById,
  getVersionsByIds,
  addLinkedComponent,
  linkOfficialFileByHash,
  setLinkedComponents,
  upsertExplorationPrompt,
  bustMvCache,
  mergeVersions,
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
import { TokenScope } from '~/shared/constants/token-scope.constants';

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
  getById: publicProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(getModelVersionSchema)
    .query(getModelVersionHandler),
  // Owner-only variant that reads from the primary DB. Used by the upload/edit
  // wizards and the files modal so a freshly-mutated file or linked-component
  // is immediately visible regardless of replication lag. Owner/moderator
  // middleware guards the primary-read load.
  getByIdForEdit: protectedProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(getModelVersionSchema)
    .use(isOwnerOrModerator)
    .query(getModelVersionForEditHandler),
  getOwner: publicProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(getByIdSchema)
    .query(getModelVersionOwnerHandler),
  getRunStrategies: publicProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(getByIdSchema)
    .query(getModelVersionRunStrategiesHandler),
  getPopularity: publicProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(getModelVersionPopularityInput)
    .query(({ input }) => getModelVersionPopularity(input)),
  getPopularities: publicProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(getModelVersionsPopularityInput)
    .query(({ input }) => getModelVersionsPopularity(input)),
  getVersionsByIds: publicProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(getModelVersionsByIdsInput)
    .query(({ input }) => getVersionsByIds(input)),
  getLicensingRoots: publicProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(getLicensingRootsSchema)
    .query(({ input }) => getLicensingRoots(input)),
  getExplorationPromptsById: publicProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(getByIdSchema)
    .query(({ input }) => getExplorationPromptsById(input)),
  toggleNotifyEarlyAccess: protectedProcedure
    .meta({ requiredScope: TokenScope.ModelsWrite })
    .input(getByIdSchema)
    .use(isFlagProtected('earlyAccessModel'))
    .mutation(toggleNotifyEarlyAccessHandler),
  setLinkedComponents: guardedProcedure
    .meta({ requiredScope: TokenScope.ModelsWrite })
    .input(setLinkedComponentsSchema)
    .use(isOwnerOrModerator)
    .mutation(async ({ input }) => setLinkedComponents(input)),
  addLinkedComponent: guardedProcedure
    .meta({ requiredScope: TokenScope.ModelsWrite })
    .input(addLinkedComponentSchema)
    .use(isOwnerOrModerator)
    .mutation(async ({ input, ctx }) =>
      addLinkedComponent({ ...input, userId: ctx.user.id, isModerator: ctx.user.isModerator })
    ),
  linkOfficialFileByHash: guardedProcedure
    .meta({ requiredScope: TokenScope.ModelsWrite })
    .input(linkOfficialFileByHashSchema)
    .use(isOwnerOrModerator)
    .mutation(async ({ input, ctx }) =>
      linkOfficialFileByHash({ ...input, userId: ctx.user.id, isModerator: ctx.user.isModerator })
    ),
  upsert: guardedProcedure
    .meta({ requiredScope: TokenScope.ModelsWrite })
    .input(modelVersionUpsertSchema2)
    .use(isOwnerOrModerator)
    .mutation(upsertModelVersionHandler),
  delete: protectedProcedure
    .meta({ requiredScope: TokenScope.ModelsDelete })
    .input(getByIdSchema)
    .use(isOwnerOrModerator)
    .mutation(deleteModelVersionHandler),
  publish: guardedProcedure
    .meta({ requiredScope: TokenScope.ModelsWrite })
    .input(publishVersionSchema)
    .use(isOwnerOrModerator)
    .mutation(publishModelVersionHandler),
  unpublish: protectedProcedure
    .meta({ requiredScope: TokenScope.ModelsWrite })
    .input(unpublishModelSchema)
    .use(isOwnerOrModerator)
    .mutation(unpublishModelVersionHandler),
  upsertExplorationPrompt: protectedProcedure
    .meta({ requiredScope: TokenScope.ModelsWrite })
    .input(upsertExplorationPromptSchema)
    .use(isOwnerOrModerator)
    .mutation(({ input }) => upsertExplorationPrompt(input)),
  deleteExplorationPrompt: protectedProcedure
    .meta({ requiredScope: TokenScope.ModelsWrite })
    .input(deleteExplorationPromptSchema)
    .use(isOwnerOrModerator)
    .mutation(({ input }) => deleteExplorationPrompt(input)),
  requestReview: protectedProcedure
    .meta({ requiredScope: TokenScope.ModelsWrite })
    .input(getByIdSchema)
    .use(isOwnerOrModerator)
    .mutation(requestReviewHandler),
  declineReview: moderatorProcedure.input(declineReviewSchema).mutation(declineReviewHandler),
  getModelVersionsByModelType: protectedProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(getModelVersionByModelTypeSchema)
    .query(({ input }) => getModelVersionsByModelType(input)),
  earlyAccessModelVersionsOnTimeframe: protectedProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(earlyAccessModelVersionsOnTimeframeSchema)
    .query(earlyAccessModelVersionsOnTimeframeHandler),
  modelVersionsGeneratedImagesOnTimeframe: protectedProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(modelVersionsGeneratedImagesOnTimeframeSchema)
    .query(modelVersionGeneratedImagesOnTimeframeHandler),
  getLicense: publicProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(getByIdSchema)
    .query(getVersionLicenseHandler),
  earlyAccessPurchase: protectedProcedure
    .meta({ requiredScope: TokenScope.ModelsWrite, blockApiKeys: true })
    .input(modelVersionEarlyAccessPurchase)
    .mutation(modelVersionEarlyAccessPurchaseHandler),
  donationGoals: publicProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(getByIdSchema)
    .query(modelVersionDonationGoalsHandler),
  getTrainingDetails: moderatorProcedure
    .input(getByIdSchema)
    .query(getModelVersionForTrainingReviewHandler),
  publishPrivateModelVersion: guardedProcedure
    .meta({ requiredScope: TokenScope.ModelsWrite })
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
    .meta({ requiredScope: TokenScope.ModelsWrite })
    .input(getByIdSchema)
    .use(isOwnerOrModerator)
    .mutation(recheckModelVersionTrainingStatusHandler),
  mergeVersions: guardedProcedure
    .meta({ requiredScope: TokenScope.ModelsWrite })
    .input(mergeVersionsSchema)
    .mutation(({ input, ctx }) => mergeVersions({ ...input, userId: ctx.user.id })),
});
