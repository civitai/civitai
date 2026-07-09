import * as z from 'zod';
import { CacheTTL } from '~/server/common/constants';
import {
  deleteImageHandler,
  handleUpdateImageNsfwLevel,
  moderateImageHandler,
  setTosViolationHandler,
  setVideoThumbnailController,
  updateImageAcceptableMinorHandler,
} from '~/server/controllers/image.controller';
import { dbRead } from '~/server/db/client';
import { getByIdSchema } from '~/server/schema/base.schema';
import {
  addImageTechniques,
  addImageTools,
  get404Images,
  getDownleveledImages,
  getImageDetail,
  getImageGenerationData,
  getImageRatingRequests,
  getImagesByUserIdForModeration,
  getIngestionErrorImages,
  resolveIngestionError,
  getImagesForModelVersionCache,
  getImagesPendingIngestion,
  getModeratorPOITags,
  getMyImages,
  ingestArticleCoverImages,
  ingestImageById,
  removeImageResource,
  removeImageTechniques,
  removeImageTools,
  reportCsamImages,
  toggleImageFlag,
  updateImageTechniques,
  updateImageTools,
  getImageModerationCounts,
  refreshImageResources,
} from '~/server/services/image.service';
import {
  middleware,
  heavyProcedure,
  moderatorProcedure,
  protectedProcedure,
  publicProcedure,
  router,
  verifiedProcedure,
} from '~/server/trpc';
import { throwAuthorizationError } from '~/server/utils/errorHandling';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import {
  getEntitiesCoverImageHandler,
  getImageContestCollectionDetailsHandler,
  getImageHandler,
  getImageResourcesHandler,
  getImagesAsPostsInfiniteHandler,
  getInfiniteImagesHandler,
  getModeratorReviewQueueHandler,
} from './../controllers/image.controller';
import { cacheIt, edgeCacheIt } from './../middleware.trpc';
import {
  addOrRemoveImageTechniquesSchema,
  addOrRemoveImageToolsSchema,
  downleveledReviewInput,
  getEntitiesCoverImage,
  getImageSchema,
  getInfiniteImagesSchema,
  getMyImagesInput,
  imageModerationSchema,
  imageRatingReviewInput,
  imageReviewQueueInputSchema,
  ingestionErrorReviewInput,
  resolveIngestionErrorInput,
  removeImageResourceSchema,
  reportCsamImagesSchema,
  setTosViolationSchema,
  setVideoThumbnailSchema,
  toggleImageFlagSchema,
  updateImageAcceptableMinorSchema,
  updateImageNsfwLevelSchema,
  updateImageTechniqueSchema,
  updateImageToolsSchema,
} from './../schema/image.schema';

const isOwnerOrModerator = middleware(async ({ ctx, next, input = {} }) => {
  if (!ctx.user) throw throwAuthorizationError();

  const { id } = input as { id: number };

  const userId = ctx.user.id;
  let ownerId = userId;
  if (id) {
    const isModerator = ctx?.user?.isModerator;
    ownerId = (await dbRead.image.findUnique({ where: { id } }))?.userId ?? 0;
    if (!isModerator) {
      if (ownerId !== userId) throw throwAuthorizationError();
    }
  }

  return next({
    ctx: {
      // infers the `user` as non-nullable
      user: ctx.user,
      ownerId,
    },
  });
});

// TODO.cleanup - remove unused router methods
export const imageRouter = router({
  ingestArticleImages: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(z.array(z.object({ imageId: z.number(), articleId: z.number() })))
    .mutation(({ input }) => ingestArticleCoverImages(input)),
  moderate: moderatorProcedure.input(imageModerationSchema).mutation(moderateImageHandler),
  delete: verifiedProcedure
    .meta({ requiredScope: TokenScope.MediaDelete })
    .input(getByIdSchema)
    .use(isOwnerOrModerator)
    .mutation(deleteImageHandler),
  setTosViolation: moderatorProcedure.input(setTosViolationSchema).mutation(setTosViolationHandler),
  getDetail: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getByIdSchema)
    .query(({ input }) => getImageDetail({ ...input })),
  getInfinite: heavyProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getInfiniteImagesSchema)
    .query(getInfiniteImagesHandler),
  getImagesForModelVersion: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getByIdSchema)
    .query(({ input }) => getImagesForModelVersionCache([input.id])),
  getImagesAsPostsInfinite: heavyProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getInfiniteImagesSchema)
    .query(getImagesAsPostsInfiniteHandler),
  get: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getImageSchema)
    .query(getImageHandler),
  getResources: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getByIdSchema)
    .use(
      edgeCacheIt({
        ttl: CacheTTL.sm,
      })
    )
    .query(getImageResourcesHandler),
  removeResource: moderatorProcedure
    .input(removeImageResourceSchema)
    .mutation(({ input }) => removeImageResource(input)),
  rescan: moderatorProcedure.input(getByIdSchema).mutation(({ input }) => ingestImageById(input)),
  getEntitiesCoverImage: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getEntitiesCoverImage)
    .query(getEntitiesCoverImageHandler),
  getModeratorReviewQueue: moderatorProcedure
    .input(imageReviewQueueInputSchema)
    .query(getModeratorReviewQueueHandler),
  getModeratorReviewQueueCounts: moderatorProcedure.query(getImageModerationCounts),
  getModeratorPOITags: moderatorProcedure.query(() => getModeratorPOITags()),
  get404Images: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .use(edgeCacheIt({ ttl: CacheTTL.month }))
    .use(cacheIt({ ttl: CacheTTL.week }))
    .query(() => get404Images()),
  reportCsamImages: moderatorProcedure
    .input(reportCsamImagesSchema)
    .mutation(({ input, ctx }) => reportCsamImages({ ...input, user: ctx.user, ip: ctx.ip })),
  updateImageNsfwLevel: protectedProcedure
    .meta({ requiredScope: TokenScope.Full })
    .input(updateImageNsfwLevelSchema)
    .mutation(handleUpdateImageNsfwLevel),
  getImageRatingRequests: moderatorProcedure
    .input(imageRatingReviewInput)
    .query(({ input, ctx }) => getImageRatingRequests({ ...input, user: ctx.user })),
  getIngestionErrorImages: moderatorProcedure
    .input(ingestionErrorReviewInput)
    .query(({ input }) => getIngestionErrorImages(input)),
  resolveIngestionError: moderatorProcedure
    .input(resolveIngestionErrorInput)
    .mutation(({ input, ctx }) => resolveIngestionError({ ...input, userId: ctx.user.id })),
  getDownleveledImages: moderatorProcedure
    .input(downleveledReviewInput)
    .query(({ input, ctx }) => getDownleveledImages({ ...input, user: ctx.user })),
  getGenerationData: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getByIdSchema)
    // TODO: Add edgeCacheIt back after fixing the cache invalidation.
    // .use(
    //   edgeCacheIt({
    //     ttl: CacheTTL.day, // Cache is purged on remove resource
    //     tags: (i) => ['image-generation-data', `image-generation-data-${i.id}`],
    //   })
    // )
    .query(({ input }) => getImageGenerationData(input)),

  // #region [tools]
  addTools: verifiedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(addOrRemoveImageToolsSchema)
    .mutation(({ input, ctx }) => addImageTools({ ...input, user: ctx.user })),
  removeTools: verifiedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(addOrRemoveImageToolsSchema)
    .mutation(({ input, ctx }) => removeImageTools({ ...input, user: ctx.user })),
  updateTools: verifiedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(updateImageToolsSchema)
    .mutation(({ input, ctx }) => updateImageTools({ ...input, user: ctx.user })),
  // #endregion

  // #region [techniques]
  addTechniques: verifiedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(addOrRemoveImageTechniquesSchema)
    .mutation(({ input, ctx }) => addImageTechniques({ ...input, user: ctx.user })),
  removeTechniques: verifiedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(addOrRemoveImageTechniquesSchema)
    .mutation(({ input, ctx }) => removeImageTechniques({ ...input, user: ctx.user })),
  updateTechniques: verifiedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(updateImageTechniqueSchema)
    .mutation(({ input, ctx }) => updateImageTechniques({ ...input, user: ctx.user })),
  // #endregion

  // #region [collections]
  getContestCollectionDetails: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getByIdSchema)
    .query(getImageContestCollectionDetailsHandler),
  // #endregion

  // #region [moderation]
  getImagesByUserIdForModeration: moderatorProcedure
    .input(z.object({ userId: z.number() }))
    .query(({ input, ctx }) => getImagesByUserIdForModeration(input.userId)),

  getAllImagesPendingIngestion: moderatorProcedure.query(getImagesPendingIngestion),
  // #endregion

  // #region [thumbnail]
  setThumbnail: verifiedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(setVideoThumbnailSchema)
    .mutation(setVideoThumbnailController),
  // #endregion

  updateAccetableMinor: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(updateImageAcceptableMinorSchema)
    .mutation(updateImageAcceptableMinorHandler),
  getMyImages: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getMyImagesInput)
    .query(({ input, ctx }) => getMyImages({ ...input, userId: ctx.user.id })),
  toggleImageFlag: moderatorProcedure
    .input(toggleImageFlagSchema)
    .mutation(({ input, ctx }) => toggleImageFlag({ ...input })),
  refreshImageResources: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(getByIdSchema)
    .mutation(({ input }) => refreshImageResources(input.id)),
});
