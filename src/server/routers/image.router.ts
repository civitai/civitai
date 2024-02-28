import { cacheIt, edgeCacheIt, queryMiddleware } from './../middleware.trpc';
import {
  getEntitiesCoverImageHandler,
  getImageDetailHandler,
  getImageHandler,
  getImageResourcesHandler,
  getImagesAsPostsInfiniteHandler,
  getInfiniteImagesHandler,
  getModeratorReviewQueueHandler,
} from './../controllers/image.controller';
import {
  updateImageSchema,
  getInfiniteImagesSchema,
  imageModerationSchema,
  getImageSchema,
  getEntitiesCoverImage,
  imageReviewQueueInputSchema,
  imageSchema,
  createImageSchema,
} from './../schema/image.schema';
import {
  deleteImageHandler,
  setTosViolationHandler,
  moderateImageHandler,
  updateImageHandler,
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
import { applyUserPreferences } from '~/server/middleware.trpc';
import {
  ingestImageById,
  removeImageResource,
  getModeratorPOITags,
  get404Images,
  reportCsamImages,
  createImage,
  createArticleCoverImage,
  ingestArticleCoverImages,
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
  createArticleCoverImage: protectedProcedure
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
  // Unused
  // update: protectedProcedure
  //   .input(updateImageSchema)
  //   .use(isOwnerOrModerator)
  //   .mutation(updateImageHandler),
  getDetail: publicProcedure.input(getByIdSchema).query(getImageDetailHandler),
  getInfinite: publicProcedure
    .input(getInfiniteImagesSchema)
    .use(queryMiddleware)
    .query(getInfiniteImagesHandler),
  getImagesAsPostsInfinite: publicProcedure
    .input(getInfiniteImagesSchema)
    .use(queryMiddleware)
    .query(getImagesAsPostsInfiniteHandler),
  get: publicProcedure.input(getImageSchema).query(getImageHandler),
  getResources: publicProcedure
    .input(getByIdSchema)
    .use(
      edgeCacheIt({
        ttl: CacheTTL.month, // Cache is purged on remove resource
        tags: (i) => ['image-resources', `image-resources-${i.id}`],
      })
    )
    .query(getImageResourcesHandler),
  removeResource: protectedProcedure
    .input(getByIdSchema)
    .mutation(({ input, ctx }) => removeImageResource({ ...input, user: ctx.user })),
  rescan: moderatorProcedure.input(getByIdSchema).mutation(({ input }) => ingestImageById(input)),
  getEntitiesCoverImage: publicProcedure
    .input(getEntitiesCoverImage)
    .query(getEntitiesCoverImageHandler),
  getModeratorReviewQueue: moderatorProcedure
    .input(imageReviewQueueInputSchema)
    .query(getModeratorReviewQueueHandler),
  getModeratorPOITags: moderatorProcedure.query(() => getModeratorPOITags()),
  getNotFoundImages: publicProcedure
    .use(edgeCacheIt({ ttl: CacheTTL.month }))
    .use(cacheIt({ ttl: CacheTTL.week }))
    .query(() => get404Images()),
  reportCsamImages: moderatorProcedure
    .input(z.number().array())
    .mutation(({ input: imageIds, ctx }) =>
      reportCsamImages({ imageIds, user: ctx.user, ip: ctx.ip })
    ),
});
