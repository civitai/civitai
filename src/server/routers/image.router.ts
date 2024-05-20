import { cacheIt, edgeCacheIt } from './../middleware.trpc';
import {
  getEntitiesCoverImageHandler,
  getImageHandler,
  getImageResourcesHandler,
  getImagesAsPostsInfiniteHandler,
  getInfiniteImagesHandler,
  getModeratorReviewQueueHandler,
} from './../controllers/image.controller';
import {
  getInfiniteImagesSchema,
  imageModerationSchema,
  getImageSchema,
  getEntitiesCoverImage,
  imageReviewQueueInputSchema,
  createImageSchema,
  updateImageNsfwLevelSchema,
  imageRatingReviewInput,
  reportCsamImagesSchema,
  addOrRemoveImageToolsSchema,
  updateImageToolsSchema,
  updateImageTechniqueSchema,
  addOrRemoveImageTechniquesSchema,
} from './../schema/image.schema';
import {
  deleteImageHandler,
  setTosViolationHandler,
  moderateImageHandler,
} from '~/server/controllers/image.controller';
import { dbRead } from '~/server/db/client';
import { getByIdSchema } from '~/server/schema/base.schema';
import {
  middleware,
  moderatorProcedure,
  protectedProcedure,
  publicProcedure,
  router,
} from '~/server/trpc';
import { throwAuthorizationError } from '~/server/utils/errorHandling';
import {
  ingestImageById,
  removeImageResource,
  getModeratorPOITags,
  get404Images,
  reportCsamImages,
  createImage,
  createArticleCoverImage,
  ingestArticleCoverImages,
  getImagesForModelVersionCache,
  updateImageNsfwLevel,
  getImageRatingRequests,
  addImageTools,
  removeImageTools,
  updateImageTools,
  updateImageTechniques,
  removeImageTechniques,
  addImageTechniques,
  getImageDetail,
  getImageGenerationData,
} from '~/server/services/image.service';
import { CacheTTL } from '~/server/common/constants';
import { z } from 'zod';

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
  create: protectedProcedure
    .input(createImageSchema)
    .mutation(({ input, ctx }) => createImage({ ...input, userId: ctx.user.id })),
  createArticleCoverImage: moderatorProcedure
    .input(createImageSchema.extend({ userId: z.number() }))
    .mutation(({ input }) => createArticleCoverImage({ ...input })),
  ingestArticleImages: protectedProcedure
    .input(z.array(z.object({ imageId: z.number(), articleId: z.number() })))
    .mutation(({ input }) => ingestArticleCoverImages(input)),
  moderate: moderatorProcedure.input(imageModerationSchema).mutation(moderateImageHandler),
  delete: protectedProcedure
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
    .input(getByIdSchema)
    .mutation(({ input }) => removeImageResource(input)),
  rescan: moderatorProcedure.input(getByIdSchema).mutation(({ input }) => ingestImageById(input)),
  getEntitiesCoverImage: publicProcedure
    .input(getEntitiesCoverImage)
    .query(getEntitiesCoverImageHandler),
  getModeratorReviewQueue: moderatorProcedure
    .input(imageReviewQueueInputSchema)
    .query(getModeratorReviewQueueHandler),
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
    .mutation(({ input, ctx }) => updateImageNsfwLevel({ ...input, user: ctx.user })),
  getImageRatingRequests: moderatorProcedure
    .input(imageRatingReviewInput)
    .query(({ input, ctx }) => getImageRatingRequests({ ...input, user: ctx.user })),
  getGenerationData: publicProcedure
    .input(getByIdSchema)
    .use(
      edgeCacheIt({
        ttl: CacheTTL.day, // Cache is purged on remove resource
        tags: (i) => ['image-generation-data', `image-generation-data-${i.id}`],
      })
    )
    .query(({ input }) => getImageGenerationData(input)),

  // #region [tools]
  addTools: protectedProcedure
    .input(addOrRemoveImageToolsSchema)
    .mutation(({ input, ctx }) => addImageTools({ ...input, user: ctx.user })),
  removeTools: protectedProcedure
    .input(addOrRemoveImageToolsSchema)
    .mutation(({ input, ctx }) => removeImageTools({ ...input, user: ctx.user })),
  updateTools: protectedProcedure
    .input(updateImageToolsSchema)
    .mutation(({ input, ctx }) => updateImageTools({ ...input, user: ctx.user })),
  // #endregion

  // #region [techniques]
  addTechniques: protectedProcedure
    .input(addOrRemoveImageTechniquesSchema)
    .mutation(({ input, ctx }) => addImageTechniques({ ...input, user: ctx.user })),
  removeTechniques: protectedProcedure
    .input(addOrRemoveImageTechniquesSchema)
    .mutation(({ input, ctx }) => removeImageTechniques({ ...input, user: ctx.user })),
  updateTechniques: protectedProcedure
    .input(updateImageTechniqueSchema)
    .mutation(({ input, ctx }) => updateImageTechniques({ ...input, user: ctx.user })),
  // #endregion
});
