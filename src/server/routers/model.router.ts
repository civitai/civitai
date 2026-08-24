import * as z from 'zod';
import { getActiveSalesForModels } from '~/server/services/paid-access.service';
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
import type { EarlyAccessRefundSummary } from '~/server/services/model-early-access-refund.service';
import { toEarlyAccessRefundSummary } from '~/server/services/model-early-access-refund.service';
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
  getModelTemplateFieldsSchema,
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
  getModelEarlyAccessRefundRequirement,
  getSimpleModelWithVersions,
  migrateResourceToCollection,
  setAssociatedResources,
  setModelOfficial,
  setModelsCategory,
  toggleCannotPromote,
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

/**
 * Marks `getAll` un-edge-cacheable when its response would be caller-dependent.
 *
 * Runs UPSTREAM of `edgeCacheIt` deliberately, and that is the only position that
 * works: `edgeCacheIt` reads `ctx.cache.skip` to compute the TTL *before* it calls
 * the resolver, so a resolver (or controller) assigning `ctx.cache.skip` is inert.
 * See the comment in `system.router.ts`.
 *
 * 🔴 `!!ctx.user` is load-bearing, not belt-and-braces. `createContext` defaults
 * `edgeTTL` to 0 for a session, but `edgeCacheIt` overwrites that default with its
 * own `ttl` without consulting `ctx.user` — so for an authenticated caller this
 * middleware is the ONLY thing standing between the response and a shared,
 * `public, s-maxage=60` edge entry keyed on nothing but the URL.
 *
 * The response really is caller-dependent:
 * `getModelsWithImagesAndModelVersions` branches on `user.isModerator` when
 * filtering by status and on `model.user.id === user?.id` for owner-only fields,
 * and the controller reads the per-user feature flags `getAllModelImagesSlim` and
 * `modelMetricPrivacyReadtime`. None of that is expressible in an edge cache key.
 *
 * Anonymous callers are unaffected — they have no `ctx.user`, their response is the
 * same for all of them, and they are the bulk of this procedure's cache hits.
 * `canCache = false` (set later, when a result `isPrivate`) is NOT a substitute:
 * it makes the middleware skip the block that assigns the TTLs, which leaves the
 * context defaults in place — and for an anonymous caller that default is 60.
 */
const skipEdgeCache = middleware(async ({ input, ctx, next }) => {
  const _input = input as GetAllModelsOutput;

  return next({
    ctx: {
      user: ctx.user,
      cache: {
        ...ctx.cache,
        skip: !!ctx.user || !!_input.favorites || !!_input.hidden,
      },
    },
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
    .use(
      cacheIt({
        ttl: 60,
        varyBy: (ctx) => ({ isModerator: ctx.user?.isModerator ?? false }),
      })
    )
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
  // Which of the cards on screen are on sale. Kept off the feed query and out of the search document:
  // a sale turns on and off at a wall-clock moment, so indexing it would mean re-indexing at every edge.
  getActiveSales: publicProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    // Bounded on its own schema: this is a public procedure reaching raw SQL, and the shared
    // getByIdsSchema has no cap.
    .input(z.object({ ids: z.number().array().max(500) }))
    .query(({ input }) => getActiveSalesForModels(input.ids)),
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
  getEarlyAccessRefundRequirement: protectedProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(getByIdSchema)
    .use(isOwnerOrModerator)
    // Annotated so dropping a field is a type error rather than a silently missing dialog: the
    // caller reads `exemptBuyerCount > 0`, which an absent field answers with `false`.
    .query(
      async ({ input }): Promise<EarlyAccessRefundSummary> =>
        toEarlyAccessRefundSummary(await getModelEarlyAccessRefundRequirement(input))
    ),
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
    .input(getModelTemplateFieldsSchema)
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
  setOfficial: moderatorProcedure
    .input(setModelOfficialSchema)
    .mutation(({ input, ctx }) =>
      setModelOfficial({ ...input, isModerator: ctx.user.isModerator ?? false })
    ),
  setMinor: moderatorProcedure.input(setModelMinorSchema).mutation(setModelMinorHandler),
});
