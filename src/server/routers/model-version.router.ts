import { finiteOrNull, monthlyPricingAllowance, pricingEligibility } from '@civitai/buzz';
import {
  countPricingSlotsThisMonth,
  getCreatorScore,
} from '~/server/services/pricing-slot.service';
import { getCapTier } from '~/server/services/subscriptions.service';
import {
  declineReviewHandler,
  deleteModelVersionHandler,
  earlyAccessModelVersionsOnTimeframeHandler,
  getModelVersionForEditHandler,
  getModelVersionHandler,
  getModelVersionOwnerHandler,
  getModelVersionRunStrategiesHandler,
  getVersionLicenseHandler,
  modelVersionDonationGoalHandler,
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
import { getUnpublishImpact } from '~/server/routers/model-version.unpublish-impact';
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
  getUserEarlyAccessModelVersions,
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
  const { id, modelId: inputModelId } = input as { id?: number; modelId?: number };

  // EVERY model the input names has to be owned, not just one of them. `id` names the version's
  // current model; `modelId` names the one the write will actually land on — upsertModelVersion reads
  // `data.modelId` on both its create and update branches, so a request carrying both moves the
  // version between them. Authorizing either alone leaves the other unchecked.
  const modelIds = new Set<number>();
  if (id) {
    const fromVersion = (await getVersionById({ id, select: { modelId: true } }))?.modelId;
    if (fromVersion) modelIds.add(fromVersion);
  }
  if (inputModelId) modelIds.add(inputModelId);

  // No resolvable model means nothing to authorize against, which is a refusal rather than a pass.
  if (modelIds.size === 0) throw throwAuthorizationError();

  for (const modelId of modelIds) {
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
  getPricingAllowance: protectedProcedure.query(async ({ ctx }) => {
    const [tier, used, score] = await Promise.all([
      getCapTier(ctx.user.id),
      countPricingSlotsThisMonth(ctx.user.id),
      getCreatorScore(ctx.user.id),
    ]);
    return {
      used,
      limit: finiteOrNull(monthlyPricingAllowance(tier)),
      eligibility: pricingEligibility(score),
    };
  }),
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
  getUserEarlyAccessVersions: protectedProcedure.query(({ ctx }) =>
    getUserEarlyAccessModelVersions({ userId: ctx.user.id })
  ),
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
  // Priced at the scope the unpublish will ACTUALLY run at. Taking down the last published version
  // takes the model with it, and the model-scoped requirement covers every version — including
  // siblings already down that still hold refundable grants, which a moderator take-down leaves in
  // place. A dialog priced per-version there would show a creator one figure and debit another, and
  // when the version figure is zero and the model figure is not, the mutation refuses with no way
  // to consent. `scope` is what the dialog words itself from; it is not decoration.
  getUnpublishImpact: protectedProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(getByIdSchema)
    .use(isOwnerOrModerator)
    .query(({ input }) => getUnpublishImpact(input.id)),
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
  donationGoal: publicProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(getByIdSchema)
    .query(modelVersionDonationGoalHandler),
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
