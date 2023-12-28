import { applyBrowsingMode, cacheIt, edgeCacheIt } from './../middleware.trpc';
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
  getImagesByCategorySchema,
  getImageSchema,
  getEntitiesCoverImage,
  imageReviewQueueInputSchema,
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
  getImagesByCategory,
  ingestImageById,
  removeImageResource,
  getModeratorPOITags,
  get404Images,
} from '~/server/services/image.service';
import { CacheTTL } from '~/server/common/constants';

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
  moderate: moderatorProcedure.input(imageModerationSchema).mutation(moderateImageHandler),
  delete: protectedProcedure
    .input(getByIdSchema)
    .use(isOwnerOrModerator)
    .mutation(deleteImageHandler),
  setTosViolation: protectedProcedure.input(getByIdSchema).mutation(setTosViolationHandler),
  update: protectedProcedure
    .input(updateImageSchema)
    .use(isOwnerOrModerator)
    .mutation(updateImageHandler),
  getDetail: publicProcedure.input(getByIdSchema).query(getImageDetailHandler),
  getInfinite: publicProcedure
    .input(getInfiniteImagesSchema)
    .use(applyUserPreferences())
    .use(applyBrowsingMode())
    .query(getInfiniteImagesHandler),
  getImagesAsPostsInfinite: publicProcedure
    .input(getInfiniteImagesSchema)
    .use(applyUserPreferences())
    .use(applyBrowsingMode())
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
  getImagesByCategory: publicProcedure
    .input(getImagesByCategorySchema)
    .use(applyUserPreferences())
    // .use(cacheIt())
    .query(({ input, ctx }) => getImagesByCategory({ ...input, userId: ctx.user?.id })),
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
});
