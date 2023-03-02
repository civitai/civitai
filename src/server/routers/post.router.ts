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
} from './../controllers/post.controller';
import {
  postCreateSchema,
  postUpdateSchema,
  addPostImageSchema,
  reorderPostImagesSchema,
  addPostTagSchema,
  removePostTagSchema,
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
  get: publicProcedure.input(getByIdSchema).query(getPostHandler),
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
  reorderImages: protectedProcedure
    .input(reorderPostImagesSchema)
    .use(isOwnerOrModerator)
    .mutation(reorderPostImagesHandler),
  addTag: protectedProcedure
    .input(addPostTagSchema)
    .use(isOwnerOrModerator)
    .mutation(addPostTagHandler),
  removeTag: protectedProcedure
    .input(removePostTagSchema)
    .use(isOwnerOrModerator)
    .mutation(removePostTagHandler),
});
