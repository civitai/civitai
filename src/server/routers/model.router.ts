import * as z from 'zod';
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
  rescanModel,
  setAssociatedResources,
  setModelsCategory,
  toggleCannotPromote,
  toggleCannotPublish,
  toggleLockComments,
} from '~/server/services/model.service';
import {
  guardedProcedure,
  middleware,
  moderatorProcedure,
  protectedProcedure,
  publicProcedure,
  router,
} from '~/server/trpc';
import { throwAuthorizationError } from '~/server/utils/errorHandling';

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
  getById: publicProcedure.input(getModelByIdSchema).query(getModelHandler),
  getOwner: publicProcedure.input(getByIdSchema).query(getModelOwnerHandler),
  getAll: publicProcedure
    .input(getAllModelsSchema.extend({ page: z.never().optional() }))
    .use(skipEdgeCache)
    .use(edgeCacheIt({ ttl: 60 }))
    .query(getModelsInfiniteHandler),
  getAllPagedSimple: publicProcedure
    .input(getAllModelsSchema.extend({ cursor: z.never().optional() }))
    .use(cacheIt({ ttl: 60 }))
    .query(getModelsPagedSimpleHandler),
  getAllInfiniteSimple: guardedProcedure
    .input(getSimpleModelsInfiniteSchema)
    .query(getSimpleModelsInfiniteHandler),
  getVersions: publicProcedure.input(getModelVersionsSchema).query(getModelVersionsHandler),
  getMyDraftModels: protectedProcedure.input(getAllQuerySchema).query(getMyDraftModelsHandler),
  getMyTrainingModels: protectedProcedure
    .input(getMyTrainingModelsSchema)
    .query(getMyTrainingModelsHandler),
  getMyAvailableModels: protectedProcedure.query(({ ctx }) =>
    getAvailableModelsByUserId({ userId: ctx.user.id })
  ),
  getAvailableTrainingModels: protectedProcedure
    .input(limitOnly)
    .query(getAvailableTrainingModelsHandler),
  getRecentlyManuallyAdded: protectedProcedure
    .input(limitOnly)
    .query(({ ctx, input }) => getRecentlyManuallyAdded({ userId: ctx.user.id, ...input })),
  getRecentlyRecommended: protectedProcedure
    .input(limitOnly)
    .query(({ ctx, input }) => getRecentlyRecommended({ userId: ctx.user.id, ...input })),
  getRecentlyBid: protectedProcedure
    .input(limitOnly)
    .query(({ ctx, input }) => getRecentlyBid({ userId: ctx.user.id, ...input })),
  getFeaturedModels: publicProcedure.query(() => getFeaturedModels()),
  upsert: guardedProcedure.input(modelUpsertSchema).mutation(upsertModelHandler),
  delete: protectedProcedure
    .input(deleteModelSchema)
    .use(isOwnerOrModerator)
    .mutation(deleteModelHandler),
  publish: guardedProcedure
    .input(publishModelSchema)
    .use(isOwnerOrModerator)
    .mutation(publishModelHandler),
  unpublish: protectedProcedure
    .input(unpublishModelSchema)
    .use(isOwnerOrModerator)
    .mutation(unpublishModelHandler),
  // TODO - TEMP HACK for reporting modal
  getModelReportDetails: publicProcedure.input(getByIdSchema).query(getModelReportDetailsHandler),
  getModelDetailsForReview: publicProcedure
    .input(getByIdSchema)
    .query(getModelDetailsForReviewHandler),
  restore: moderatorProcedure.input(getByIdSchema).mutation(restoreModelHandler),
  getDownloadCommand: protectedProcedure.input(getDownloadSchema).query(getDownloadCommandHandler),
  reorderVersions: protectedProcedure
    .input(reorderModelVersionsSchema)
    .use(isOwnerOrModerator)
    .mutation(reorderModelVersionsHandler),
  toggleLock: protectedProcedure
    .input(toggleModelLockSchema)
    .use(isOwnerOrModerator)
    .mutation(toggleModelLockHandler),
  toggleLockComments: protectedProcedure
    .input(toggleModelLockSchema)
    .use(isOwnerOrModerator)
    .mutation(({ input }) => toggleLockComments(input)),
  getSimple: publicProcedure
    .input(getByIdSchema)
    .query(({ input, ctx }) => getSimpleModelWithVersions({ id: input.id, ctx })),
  requestReview: protectedProcedure
    .input(getByIdSchema)
    .use(isOwnerOrModerator)
    .mutation(requestReviewHandler),
  declineReview: protectedProcedure
    .input(declineReviewSchema)
    .use(isOwnerOrModerator)
    .mutation(declineReviewHandler),
  changeMode: protectedProcedure
    .input(changeModelModifierSchema)
    .use(isOwnerOrModerator)
    .mutation(changeModelModifierHandler),
  getWithCategoriesSimple: publicProcedure
    .input(getModelsWithCategoriesSchema)
    .query(({ input }) => getAllModelsWithCategories(input)),
  setCategory: protectedProcedure
    .input(setModelsCategorySchema)
    .mutation(({ input, ctx }) => setModelsCategory({ ...input, userId: ctx.user?.id })),
  findResourcesToAssociate: protectedProcedure
    .input(findResourcesToAssociateSchema)
    .query(findResourcesToAssociateHandler),
  getAssociatedResourcesCardData: publicProcedure
    .input(getAssociatedResourcesSchema)
    .query(getAssociatedResourcesCardDataHandler),
  getAssociatedResourcesSimple: publicProcedure
    .input(getAssociatedResourcesSchema)
    .query(({ input }) => getAssociatedResourcesSimple(input)),
  setAssociatedResources: guardedProcedure
    .input(setAssociatedResourcesSchema)
    .mutation(({ input, ctx }) => setAssociatedResources(input, ctx.user)),
  rescan: moderatorProcedure.input(getByIdSchema).mutation(({ input }) => rescanModel(input)),
  getModelsByHash: publicProcedure.input(modelByHashesInput).mutation(getModelByHashesHandler),
  getTemplateFields: guardedProcedure.input(getByIdSchema).query(getModelTemplateFieldsHandler),
  getModelTemplateFieldsFromBounty: guardedProcedure
    .input(getByIdSchema)
    .query(getModelTemplateFromBountyHandler),
  getGallerySettings: publicProcedure.input(getByIdSchema).query(getModelGallerySettingsHandler),
  updateGallerySettings: guardedProcedure
    .input(updateGallerySettingsSchema)
    .use(isOwnerOrModerator)
    .mutation(updateGallerySettingsHandler),
  toggleCheckpointCoverage: moderatorProcedure
    .input(toggleCheckpointCoverageSchema)
    .mutation(toggleCheckpointCoverageHandler),
  copyGallerySettings: guardedProcedure
    .input(copyGallerySettingsSchema)
    .use(isOwnerOrModerator)
    .mutation(copyGalleryBrowsingLevelHandler),
  getCollectionShowcase: publicProcedure
    .input(getByIdSchema)
    .query(getModelCollectionShowcaseHandler),
  setCollectionShowcase: protectedProcedure
    .input(setModelCollectionShowcaseSchema)
    .use(isOwnerOrModerator)
    .mutation(setModelCollectionShowcaseHandler),
  migrateToCollection: guardedProcedure
    .input(migrateResourceToCollectionSchema)
    .use(isOwnerOrModerator)
    .mutation(({ input }) => migrateResourceToCollection(input)),
  privateModelFromTraining: guardedProcedure
    .input(privateModelFromTrainingSchema)
    .mutation(privateModelFromTrainingHandler),
  publishPrivateModel: guardedProcedure
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
});
