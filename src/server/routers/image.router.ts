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
  moderatorProcedure,
  protectedProcedure,
  publicProcedure,
  router,
  verifiedProcedure,
} from '~/server/trpc';
import { throwAuthorizationError } from '~/server/utils/errorHandling';
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
    .input(z.array(z.object({ imageId: z.number(), articleId: z.number() })))
    .mutation(({ input }) => ingestArticleCoverImages(input)),
  moderate: moderatorProcedure.input(imageModerationSchema).mutation(moderateImageHandler),
  delete: verifiedProcedure
    .input(getByIdSchema)
    .use(isOwnerOrModerator)
    .mutation(deleteImageHandler),
  setTosViolation: moderatorProcedure.input(getByIdSchema).mutation(setTosViolationHandler),
  getDetail: publicProcedure
    .input(getByIdSchema)
    .query(({ input }) => getImageDetail({ ...input })),
  getInfinite: publicProcedure.input(getInfiniteImagesSchema).query(getInfiniteImagesHandler),
  getImagesForModelVersion: publicProcedure
    .input(getByIdSchema)
    .query(({ input }) => getImagesForModelVersionCache([input.id])),
  getImagesAsPostsInfinite: publicProcedure
    .input(getInfiniteImagesSchema)
    .query(getImagesAsPostsInfiniteHandler),
  get: publicProcedure.input(getImageSchema).query(getImageHandler),
  getResources: publicProcedure
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
    .input(getEntitiesCoverImage)
    .query(getEntitiesCoverImageHandler),
  getModeratorReviewQueue: moderatorProcedure
    .input(imageReviewQueueInputSchema)
    .query(getModeratorReviewQueueHandler),
  getModeratorReviewQueueCounts: moderatorProcedure.query(getImageModerationCounts),
  getModeratorPOITags: moderatorProcedure.query(() => getModeratorPOITags()),
  get404Images: publicProcedure
    .use(edgeCacheIt({ ttl: CacheTTL.month }))
    .use(cacheIt({ ttl: CacheTTL.week }))
    .query(() => get404Images()),
  reportCsamImages: moderatorProcedure
    .input(reportCsamImagesSchema)
    .mutation(({ input, ctx }) => reportCsamImages({ ...input, user: ctx.user, ip: ctx.ip })),
  updateImageNsfwLevel: protectedProcedure
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
    .input(addOrRemoveImageToolsSchema)
    .mutation(({ input, ctx }) => addImageTools({ ...input, user: ctx.user })),
  removeTools: verifiedProcedure
    .input(addOrRemoveImageToolsSchema)
    .mutation(({ input, ctx }) => removeImageTools({ ...input, user: ctx.user })),
  updateTools: verifiedProcedure
    .input(updateImageToolsSchema)
    .mutation(({ input, ctx }) => updateImageTools({ ...input, user: ctx.user })),
  // #endregion

  // #region [techniques]
  addTechniques: verifiedProcedure
    .input(addOrRemoveImageTechniquesSchema)
    .mutation(({ input, ctx }) => addImageTechniques({ ...input, user: ctx.user })),
  removeTechniques: verifiedProcedure
    .input(addOrRemoveImageTechniquesSchema)
    .mutation(({ input, ctx }) => removeImageTechniques({ ...input, user: ctx.user })),
  updateTechniques: verifiedProcedure
    .input(updateImageTechniqueSchema)
    .mutation(({ input, ctx }) => updateImageTechniques({ ...input, user: ctx.user })),
  // #endregion

  // #region [collections]
  getContestCollectionDetails: publicProcedure
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
    .input(setVideoThumbnailSchema)
    .mutation(setVideoThumbnailController),
  // #endregion

  updateAccetableMinor: protectedProcedure
    .input(updateImageAcceptableMinorSchema)
    .mutation(updateImageAcceptableMinorHandler),
  getMyImages: protectedProcedure
    .input(getMyImagesInput)
    .query(({ input, ctx }) => getMyImages({ ...input, userId: ctx.user.id })),
  toggleImageFlag: moderatorProcedure
    .input(toggleImageFlagSchema)
    .mutation(({ input, ctx }) => toggleImageFlag({ ...input })),
  refreshImageResources: protectedProcedure
    .input(getByIdSchema)
    .mutation(({ input }) => refreshImageResources(input.id)),
});
