import * as z from 'zod';
import { env } from '~/env/server';
import { CacheTTL } from '~/server/common/constants';
import {
  changeModelModifierHandler,
  copyGalleryBrowsingLevelHandler,
  declineReviewHandler,
  deleteModelHandler,
  findResourcesToAssociateHandler,
  getAssociatedResourcesCardDataHandler,
  getAvailableTrainingModelsHandler,
  getDownloadCommandHandler,
  getModelByHashesHandler,
  getModelCollectionShowcaseHandler,
  getModelDetailsForReviewHandler,
  getModelGallerySettingsHandler,
  getModelHandler,
  getModelOwnerHandler,
  getModelReportDetailsHandler,
  getModelsInfiniteHandler,
  getModelsPagedSimpleHandler,
  getModelTemplateFieldsHandler,
  getModelTemplateFromBountyHandler,
  getModelVersionsHandler,
  getMyDraftModelsHandler,
  getMyTrainingModelsHandler,
  getSimpleModelsInfiniteHandler,
  privateModelFromTrainingHandler,
  publishModelHandler,
  publishPrivateModelHandler,
  reorderModelVersionsHandler,
  requestReviewHandler,
  restoreModelHandler,
  setModelCollectionShowcaseHandler,
  setModelMinorHandler,
  toggleCheckpointCoverageHandler,
  toggleModelLockHandler,
  unpublishModelHandler,
  updateGallerySettingsHandler,
  upsertModelHandler,
} from '~/server/controllers/model.controller';
import { dbRead } from '~/server/db/client';
import { applyUserPreferences, cacheIt, edgeCacheIt } from '~/server/middleware.trpc';
import { getAllQuerySchema, getByIdSchema } from '~/server/schema/base.schema';
import type { GetAllModelsOutput } from '~/server/schema/model.schema';
import {
  changeModelModifierSchema,
  copyGallerySettingsSchema,
  declineReviewSchema,
  deleteModelSchema,
  findResourcesToAssociateSchema,
  getAllModelsSchema,
  getAssociatedResourcesSchema,
  getDownloadSchema,
  getModelByIdSchema,
  getModelsWithCategoriesSchema,
  getModelVersionsSchema,
  getResourceSelectSchema,
  getMyTrainingModelsSchema,
  getSimpleModelsInfiniteSchema,
  limitOnly,
  migrateResourceToCollectionSchema,
  modelByHashesInput,
  modelUpsertSchema,
  privateModelFromTrainingSchema,
  publishModelSchema,
  publishPrivateModelSchema,
  reorderModelVersionsSchema,
  setAssociatedResourcesSchema,
  setModelCollectionShowcaseSchema,
  setModelMinorSchema,
  setModelOfficialSchema,
  setModelsCategorySchema,
  toggleCheckpointCoverageSchema,
  toggleModelLockSchema,
  unpublishModelSchema,
  updateGallerySettingsSchema,
} from '~/server/schema/model.schema';
import {
  getAllModelsWithCategories,
  getAssociatedResourcesSimple,
  getAvailableModelsByUserId,
  getFeaturedModels,
  getRecentlyBid,
  getRecentlyManuallyAdded,
  getRecentlyRecommended,
  getSimpleModelWithVersions,
  migrateResourceToCollection,
  setAssociatedResources,
  setModelOfficial,
  setModelsCategory,
  toggleCannotPromote,
  toggleCannotPublish,
  toggleLockComments,
} from '~/server/services/model.service';
import { getResourceSelectModels } from '~/server/services/resource-select.service';
import { rescanModel } from '~/server/services/model-file-scan.service';
import {
  guardedProcedure,
  middleware,
  moderatorProcedure,
  protectedProcedure,
  publicProcedure,
  router,
} from '~/server/trpc';
import { throwAuthorizationError } from '~/server/utils/errorHandling';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const isOwnerOrModerator = middleware(async ({ ctx, next, input = {} }) => {
  if (!ctx.user) throw throwAuthorizationError();

  const { id } = input as { id: number };

  const userId = ctx.user.id;
  const isModerator = ctx?.user?.isModerator;
  if (!isModerator && !!id) {
    const ownerId = (await dbRead.model.findUnique({ where: { id }, select: { userId: true } }))
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

const skipEdgeCache = middleware(async ({ input, ctx, next }) => {
  const _input = input as GetAllModelsOutput;

  return next({
    ctx: { user: ctx.user, cache: { ...ctx.cache, skip: _input.favorites || _input.hidden } },
  });
});

export const modelRouter = router({
  getById: publicProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(getModelByIdSchema)
    .query(getModelHandler),
  getOwner: publicProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(getByIdSchema)
    .query(getModelOwnerHandler),
  getAll: publicProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(getAllModelsSchema.extend({ page: z.never().optional() }))
    .use(skipEdgeCache)
    .use(edgeCacheIt({ ttl: 60 }))
    .query(getModelsInfiniteHandler),
  getAllPagedSimple: publicProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(getAllModelsSchema.extend({ cursor: z.never().optional() }))
    .use(cacheIt({ ttl: 60 }))
    .query(getModelsPagedSimpleHandler),
  getAllInfiniteSimple: guardedProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(getSimpleModelsInfiniteSchema)
    .query(getSimpleModelsInfiniteHandler),
  getVersions: publicProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(getModelVersionsSchema)
    .query(getModelVersionsHandler),
  getMyDraftModels: protectedProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(getAllQuerySchema)
    .query(getMyDraftModelsHandler),
  getMyTrainingModels: protectedProcedure
    .meta({ requiredScope: TokenScope.ModelsRead | TokenScope.AIServicesRead })
    .input(getMyTrainingModelsSchema)
    .query(getMyTrainingModelsHandler),
  getMyAvailableModels: protectedProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .query(({ ctx }) => getAvailableModelsByUserId({ userId: ctx.user.id })),
  getAvailableTrainingModels: protectedProcedure
    .meta({ requiredScope: TokenScope.ModelsRead | TokenScope.AIServicesRead })
    .input(limitOnly)
    .query(getAvailableTrainingModelsHandler),
  getRecentlyManuallyAdded: protectedProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(limitOnly)
    .query(({ ctx, input }) => getRecentlyManuallyAdded({ userId: ctx.user.id, ...input })),
  getRecentlyRecommended: protectedProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(limitOnly)
    .query(({ ctx, input }) => getRecentlyRecommended({ userId: ctx.user.id, ...input })),
  getRecentlyBid: protectedProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(limitOnly)
    .query(({ ctx, input }) => getRecentlyBid({ userId: ctx.user.id, ...input })),
  getFeaturedModels: publicProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .query(() => getFeaturedModels()),
  getResourceSelect: publicProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(getResourceSelectSchema)
    .query(({ ctx, input }) => getResourceSelectModels(input, { user: ctx.user })),
  upsert: guardedProcedure
    .meta({ requiredScope: TokenScope.ModelsWrite })
    .input(modelUpsertSchema)
    .mutation(upsertModelHandler),
  delete: protectedProcedure
    .meta({ requiredScope: TokenScope.ModelsDelete })
    .input(deleteModelSchema)
    .use(isOwnerOrModerator)
    .mutation(deleteModelHandler),
  publish: guardedProcedure
    .meta({ requiredScope: TokenScope.ModelsWrite })
    .input(publishModelSchema)
    .use(isOwnerOrModerator)
    .mutation(publishModelHandler),
  unpublish: protectedProcedure
    .meta({ requiredScope: TokenScope.ModelsWrite })
    .input(unpublishModelSchema)
    .use(isOwnerOrModerator)
    .mutation(unpublishModelHandler),
  // TODO - TEMP HACK for reporting modal
  getModelReportDetails: publicProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(getByIdSchema)
    .query(getModelReportDetailsHandler),
  getModelDetailsForReview: publicProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(getByIdSchema)
    .query(getModelDetailsForReviewHandler),
  restore: moderatorProcedure.input(getByIdSchema).mutation(restoreModelHandler),
  getDownloadCommand: protectedProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(getDownloadSchema)
    .query(getDownloadCommandHandler),
  reorderVersions: protectedProcedure
    .meta({ requiredScope: TokenScope.ModelsWrite })
    .input(reorderModelVersionsSchema)
    .use(isOwnerOrModerator)
    .mutation(reorderModelVersionsHandler),
  toggleLock: protectedProcedure
    .meta({ requiredScope: TokenScope.ModelsWrite })
    .input(toggleModelLockSchema)
    .use(isOwnerOrModerator)
    .mutation(toggleModelLockHandler),
  toggleLockComments: protectedProcedure
    .meta({ requiredScope: TokenScope.ModelsWrite })
    .input(toggleModelLockSchema)
    .use(isOwnerOrModerator)
    .mutation(({ input }) => toggleLockComments(input)),
  getSimple: publicProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(getByIdSchema)
    .query(({ input, ctx }) => getSimpleModelWithVersions({ id: input.id, ctx })),
  requestReview: protectedProcedure
    .meta({ requiredScope: TokenScope.ModelsWrite })
    .input(getByIdSchema)
    .use(isOwnerOrModerator)
    .mutation(requestReviewHandler),
  declineReview: protectedProcedure
    .meta({ requiredScope: TokenScope.ModelsWrite })
    .input(declineReviewSchema)
    .use(isOwnerOrModerator)
    .mutation(declineReviewHandler),
  changeMode: protectedProcedure
    .meta({ requiredScope: TokenScope.ModelsWrite })
    .input(changeModelModifierSchema)
    .use(isOwnerOrModerator)
    .mutation(changeModelModifierHandler),
  getWithCategoriesSimple: publicProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(getModelsWithCategoriesSchema)
    .query(({ input }) => getAllModelsWithCategories(input)),
  setCategory: protectedProcedure
    .meta({ requiredScope: TokenScope.ModelsWrite })
    .input(setModelsCategorySchema)
    .mutation(({ input, ctx }) => setModelsCategory({ ...input, userId: ctx.user?.id })),
  findResourcesToAssociate: protectedProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(findResourcesToAssociateSchema)
    .query(findResourcesToAssociateHandler),
  getAssociatedResourcesCardData: publicProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(getAssociatedResourcesSchema)
    .query(getAssociatedResourcesCardDataHandler),
  getAssociatedResourcesSimple: publicProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(getAssociatedResourcesSchema)
    .query(({ input }) => getAssociatedResourcesSimple(input)),
  setAssociatedResources: guardedProcedure
    .meta({ requiredScope: TokenScope.ModelsWrite })
    .input(setAssociatedResourcesSchema)
    .mutation(({ input, ctx }) => setAssociatedResources(input, ctx.user)),
  rescan: moderatorProcedure.input(getByIdSchema).mutation(({ input }) => rescanModel(input)),
  getModelsByHash: publicProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(modelByHashesInput)
    .mutation(getModelByHashesHandler),
  getTemplateFields: guardedProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(getByIdSchema)
    .query(getModelTemplateFieldsHandler),
  getModelTemplateFieldsFromBounty: guardedProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(getByIdSchema)
    .query(getModelTemplateFromBountyHandler),
  getGallerySettings: publicProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(getByIdSchema)
    .query(getModelGallerySettingsHandler),
  updateGallerySettings: guardedProcedure
    .meta({ requiredScope: TokenScope.ModelsWrite })
    .input(updateGallerySettingsSchema)
    .use(isOwnerOrModerator)
    .mutation(updateGallerySettingsHandler),
  toggleCheckpointCoverage: moderatorProcedure
    .input(toggleCheckpointCoverageSchema)
    .mutation(toggleCheckpointCoverageHandler),
  copyGallerySettings: guardedProcedure
    .meta({ requiredScope: TokenScope.ModelsWrite })
    .input(copyGallerySettingsSchema)
    .use(isOwnerOrModerator)
    .mutation(copyGalleryBrowsingLevelHandler),
  getCollectionShowcase: publicProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(getByIdSchema)
    .query(getModelCollectionShowcaseHandler),
  setCollectionShowcase: protectedProcedure
    .meta({ requiredScope: TokenScope.ModelsWrite })
    .input(setModelCollectionShowcaseSchema)
    .use(isOwnerOrModerator)
    .mutation(setModelCollectionShowcaseHandler),
  migrateToCollection: guardedProcedure
    .meta({ requiredScope: TokenScope.ModelsWrite })
    .input(migrateResourceToCollectionSchema)
    .use(isOwnerOrModerator)
    .mutation(({ input }) => migrateResourceToCollection(input)),
  privateModelFromTraining: guardedProcedure
    .meta({ requiredScope: TokenScope.ModelsWrite })
    .input(privateModelFromTrainingSchema)
    .mutation(privateModelFromTrainingHandler),
  publishPrivateModel: guardedProcedure
    .meta({ requiredScope: TokenScope.ModelsWrite })
    .input(publishPrivateModelSchema)
    .use(isOwnerOrModerator)
    .mutation(publishPrivateModelHandler),
  toggleCannotPromote: moderatorProcedure
    .input(getByIdSchema)
    .mutation(({ input, ctx }) =>
      toggleCannotPromote({ ...input, isModerator: ctx.user.isModerator ?? false })
    ),
  toggleCannotPublish: moderatorProcedure
    .input(getByIdSchema)
    .mutation(({ input, ctx }) =>
      toggleCannotPublish({ ...input, isModerator: ctx.user.isModerator ?? false })
    ),
  setOfficial: moderatorProcedure
    .input(setModelOfficialSchema)
    .mutation(({ input, ctx }) =>
      setModelOfficial({ ...input, isModerator: ctx.user.isModerator ?? false })
    ),
  setMinor: moderatorProcedure.input(setModelMinorSchema).mutation(setModelMinorHandler),
});
