import { addPostImage, getPostEditDetail, getPostEditImages } from './../services/post.service';
import { applyUserPreferences, cacheIt } from './../middleware.trpc';
import { getByIdSchema } from './../schema/base.schema';
import { guardedProcedure, publicProcedure } from './../trpc';
import {
  createPostHandler,
  updatePostHandler,
  getPostHandler,
  reorderPostImagesHandler,
  deletePostHandler,
  addPostTagHandler,
  removePostTagHandler,
  updatePostImageHandler,
  getPostTagsHandler,
  getPostsInfiniteHandler,
  getPostResourcesHandler,
  getPostContestCollectionDetailsHandler,
  updatePostCollectionTagIdHandler,
} from './../controllers/post.controller';
import {
  postCreateSchema,
  postUpdateSchema,
  reorderPostImagesSchema,
  addPostTagSchema,
  removePostTagSchema,
  updatePostImageSchema,
  getPostTagsSchema,
  postsQuerySchema,
  updatePostCollectionTagIdInput,
} from './../schema/post.schema';
import { dbWrite } from '~/server/db/client';
import { router, protectedProcedure, middleware } from '~/server/trpc';
import { throwAuthorizationError } from '~/server/utils/errorHandling';
import { imageSchema } from '~/server/schema/image.schema';
import { z } from 'zod';

const isOwnerOrModerator = middleware(async ({ ctx, next, input = {} }) => {
  if (!ctx.user) throw throwAuthorizationError();

  const { id } = input as { id: number };

  const userId = ctx.user.id;
  const isModerator = ctx?.user?.isModerator;
  if (!isModerator && !!id) {
    const ownerId = (await dbWrite.post.findUnique({ where: { id }, select: { userId: true } }))
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

// TODO.hotfix: added this middleware to allow editing images and check if it's the owner
const isImageOwnerOrModerator = middleware(async ({ ctx, next, input = {} }) => {
  if (!ctx.user) throw throwAuthorizationError();

  const { id } = input as { id: number };

  const userId = ctx.user.id;
  const isModerator = ctx?.user?.isModerator;
  if (!isModerator && !!id) {
    const ownerId = (await dbWrite.image.findUnique({ where: { id }, select: { userId: true } }))
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

export const postRouter = router({
  getInfinite: publicProcedure
    .input(postsQuerySchema)
    .use(applyUserPreferences)
    .query(getPostsInfiniteHandler),
  get: publicProcedure.input(getByIdSchema).query(getPostHandler),
  getEdit: protectedProcedure
    .input(getByIdSchema)
    .query(({ ctx, input }) => getPostEditDetail({ ...input, user: ctx.user })),
  create: guardedProcedure.input(postCreateSchema).mutation(createPostHandler),
  update: guardedProcedure
    .input(postUpdateSchema)
    .use(isOwnerOrModerator)
    .mutation(updatePostHandler),
  delete: protectedProcedure
    .input(getByIdSchema)
    .use(isOwnerOrModerator)
    .mutation(deletePostHandler),
  addImage: guardedProcedure
    .input(imageSchema.extend({ postId: z.number() }))
    .use(isOwnerOrModerator)
    .mutation(({ ctx, input }) => addPostImage({ ...input, user: ctx.user })),
  updateImage: guardedProcedure
    .input(updatePostImageSchema)
    .use(isImageOwnerOrModerator)
    .mutation(updatePostImageHandler),
  reorderImages: guardedProcedure
    .input(reorderPostImagesSchema)
    .use(isOwnerOrModerator)
    .mutation(reorderPostImagesHandler),
  getTags: publicProcedure
    .input(getPostTagsSchema)
    .use(applyUserPreferences)
    .query(getPostTagsHandler),
  addTag: protectedProcedure
    .input(addPostTagSchema)
    .use(isOwnerOrModerator)
    .mutation(addPostTagHandler),
  removeTag: protectedProcedure
    .input(removePostTagSchema)
    .use(isOwnerOrModerator)
    .mutation(removePostTagHandler),
  getResources: publicProcedure.input(getByIdSchema).query(getPostResourcesHandler),
  getContestCollectionDetails: publicProcedure
    .input(getByIdSchema)
    .query(getPostContestCollectionDetailsHandler),
  updateCollectionTagId: protectedProcedure
    .input(updatePostCollectionTagIdInput)
    .use(isOwnerOrModerator)
    .mutation(updatePostCollectionTagIdHandler),
});
