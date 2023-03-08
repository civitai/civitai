import {
  deleteImageHandler,
  getGalleryImageDetailHandler,
  getGalleryImagesHandler,
  getGalleryImagesInfiniteHandler,
  getImageConnectionDataHandler,
  getModelVersionImagesHandler,
  getReviewImagesHandler,
  setTosViolationHandler,
  updateImageHandler,
} from '~/server/controllers/image.controller';
import { dbRead } from '~/server/db/client';
import { getByIdSchema } from '~/server/schema/base.schema';
import {
  getGalleryImageSchema,
  getImageConnectionsSchema,
  getModelVersionImageSchema,
  getReviewImagesSchema,
  imageUpdateSchema,
} from '~/server/schema/image.schema';
import { middleware, protectedProcedure, publicProcedure, router } from '~/server/trpc';
import { throwAuthorizationError } from '~/server/utils/errorHandling';

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

export const imageRouter = router({
  getModelVersionImages: publicProcedure
    .input(getModelVersionImageSchema)
    .query(getModelVersionImagesHandler),
  getReviewImages: publicProcedure.input(getReviewImagesSchema).query(getReviewImagesHandler),
  getGalleryImagesInfinite: publicProcedure
    .input(getGalleryImageSchema)
    .query(getGalleryImagesInfiniteHandler),
  getGalleryImages: publicProcedure.input(getGalleryImageSchema).query(getGalleryImagesHandler),
  getGalleryImageDetail: publicProcedure.input(getByIdSchema).query(getGalleryImageDetailHandler),
  getConnectionData: publicProcedure
    .input(getImageConnectionsSchema)
    .query(getImageConnectionDataHandler),
  update: protectedProcedure
    .input(imageUpdateSchema)
    .use(isOwnerOrModerator)
    .mutation(updateImageHandler),
  delete: protectedProcedure
    .input(getByIdSchema)
    .use(isOwnerOrModerator)
    .mutation(deleteImageHandler),
  setTosViolation: protectedProcedure.input(getByIdSchema).mutation(setTosViolationHandler),
});
