import { applyUserPreferences, applyBrowsingMode } from './../middleware.trpc';
import { getByIdSchema } from './../schema/base.schema';
import { publicProcedure } from './../trpc';
import {
  createPostHandler,
  updatePostHandler,
  getPostHandler,
  addPostImageHandler,
  reorderPostImagesHandler,
  deletePostHandler,
  addPostTagHandler,
  removePostTagHandler,
  getPostEditHandler,
  updatePostImageHandler,
  getPostTagsHandler,
  getPostsInfiniteHandler,
} from './../controllers/post.controller';
import {
  postCreateSchema,
  postUpdateSchema,
  addPostImageSchema,
  reorderPostImagesSchema,
  addPostTagSchema,
  removePostTagSchema,
  updatePostImageSchema,
  getPostTagsSchema,
  postsQuerySchema,
} from './../schema/post.schema';
import { dbWrite } from '~/server/db/client';
import { router, protectedProcedure, middleware } from '~/server/trpc';
import { throwAuthorizationError } from '~/server/utils/errorHandling';

const isOwnerOrModerator = middleware(async ({ ctx, next, input = {} }) => {
  if (!ctx.user) throw throwAuthorizationError();

  const { id } = input as { id: number };

  const userId = ctx.user.id;
  let ownerId = userId;
  if (id) {
    const isModerator = ctx?.user?.isModerator;
    ownerId =
      (await dbWrite.post.findUnique({ where: { id }, select: { userId: true } }))?.userId ?? 0;
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

export const postRouter = router({
  getInfinite: publicProcedure
    .input(postsQuerySchema)
    .use(applyUserPreferences())
    .use(applyBrowsingMode())
    .query(getPostsInfiniteHandler),
  get: publicProcedure.input(getByIdSchema).query(getPostHandler),
  getEdit: protectedProcedure.input(getByIdSchema).query(getPostEditHandler),
  create: protectedProcedure.input(postCreateSchema).mutation(createPostHandler),
  update: protectedProcedure
    .input(postUpdateSchema)
    .use(isOwnerOrModerator)
    .mutation(updatePostHandler),
  delete: protectedProcedure
    .input(getByIdSchema)
    .use(isOwnerOrModerator)
    .mutation(deletePostHandler),
  addImage: protectedProcedure
    .input(addPostImageSchema)
    .use(isOwnerOrModerator)
    .mutation(addPostImageHandler),
  updateImage: protectedProcedure
    .input(updatePostImageSchema)
    .use(isOwnerOrModerator)
    .mutation(updatePostImageHandler),
  reorderImages: protectedProcedure
    .input(reorderPostImagesSchema)
    .use(isOwnerOrModerator)
    .mutation(reorderPostImagesHandler),
  getTags: publicProcedure.input(getPostTagsSchema).query(getPostTagsHandler),
  addTag: protectedProcedure
    .input(addPostTagSchema)
    .use(isOwnerOrModerator)
    .mutation(addPostTagHandler),
  removeTag: protectedProcedure
    .input(removePostTagSchema)
    .use(isOwnerOrModerator)
    .mutation(removePostTagHandler),
});
