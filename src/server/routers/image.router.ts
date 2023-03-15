import { getImageDetailHandler } from './../controllers/image.controller';
import { GetGalleryImageInput, updateImageSchema } from './../schema/image.schema';
import {
  deleteImageHandler,
  getGalleryImageDetailHandler,
  getGalleryImagesHandler,
  getGalleryImagesInfiniteHandler,
  getImageConnectionDataHandler,
  getModelVersionImagesHandler,
  getReviewImagesHandler,
  setTosViolationHandler,
  moderateImageHandler,
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
import { getHiddenTagsForUser, getHiddenUsersForUser } from '~/server/services/user-cache.service';

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

const applyUserPreferences = middleware(async ({ input, ctx, next }) => {
  const userId = ctx.user?.id;
  const _input = input as GetGalleryImageInput;
  const hiddenTags = await getHiddenTagsForUser({ userId });
  const hiddenUsers = await getHiddenUsersForUser({ userId });
  _input.excludedTagIds = [...hiddenTags, ...(_input.excludedTagIds ?? [])];
  _input.excludedUserIds = [...hiddenUsers, ...(_input.excludedUserIds ?? [])];

  return next({
    ctx: { user: ctx.user },
  });
});

export const imageRouter = router({
  getModelVersionImages: publicProcedure
    .input(getModelVersionImageSchema)
    .query(getModelVersionImagesHandler),
  getReviewImages: publicProcedure.input(getReviewImagesSchema).query(getReviewImagesHandler),
  getGalleryImagesInfinite: publicProcedure
    .input(getGalleryImageSchema)
    .use(applyUserPreferences)
    .query(getGalleryImagesInfiniteHandler),
  getGalleryImages: publicProcedure
    .input(getGalleryImageSchema)
    .use(applyUserPreferences)
    .query(getGalleryImagesHandler),
  getGalleryImageDetail: publicProcedure.input(getByIdSchema).query(getGalleryImageDetailHandler),
  getConnectionData: publicProcedure
    .input(getImageConnectionsSchema)
    .query(getImageConnectionDataHandler),
  moderate: protectedProcedure
    .input(imageUpdateSchema)
    .use(isOwnerOrModerator)
    .mutation(moderateImageHandler),
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
});
