import * as z from 'zod';
import { dbWrite } from '~/server/db/client';
import { imageSchema } from '~/server/schema/image.schema';
import { middleware, moderatorProcedure, protectedProcedure, router } from '~/server/trpc';
import { throwAuthorizationError } from '~/server/utils/errorHandling';
import {
  addPostTagHandler,
  addResourceToPostImageHandler,
  createPostHandler,
  deletePostHandler,
  getPostContestCollectionDetailsHandler,
  getPostHandler,
  getPostResourcesHandler,
  getPostsInfiniteHandler,
  getPostTagsHandler,
  removePostTagHandler,
  removeResourceFromPostImageHandler,
  reorderPostImagesHandler,
  updatePostCollectionTagIdHandler,
  updatePostHandler,
  updatePostImageHandler,
} from './../controllers/post.controller';
import { applyUserPreferences } from './../middleware.trpc';
import { getByIdSchema } from './../schema/base.schema';
import {
  addPostTagSchema,
  addResourceToPostImageInput,
  getPostTagsSchema,
  postCreateSchema,
  postsQuerySchema,
  postUpdateSchema,
  removePostTagSchema,
  removeResourceFromPostImageInput,
  reorderPostImagesSchema,
  updatePostCollectionTagIdInput,
  updatePostImageSchema,
} from './../schema/post.schema';
import { addPostImage, getPostEditDetail } from './../services/post.service';
import { guardedProcedure, publicProcedure, verifiedProcedure } from './../trpc';
import { enqueueJobs } from '~/server/services/job-queue.service';
import { EntityType, JobQueueType } from '~/shared/utils/prisma/enums';

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

  const userId = ctx.user.id;
  const isModerator = ctx?.user?.isModerator;

  const { id: inputId } = input as { id: number | number[] | null };

  if (!isModerator && !!inputId) {
    const ids = !Array.isArray(inputId) ? [inputId] : inputId;
    const images = await dbWrite.image.findMany({
      where: { id: { in: ids } },
      select: { userId: true },
    });
    if (images.some((i) => i.userId !== userId)) throw throwAuthorizationError();
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
  update: verifiedProcedure
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
  updateImage: verifiedProcedure
    .input(updatePostImageSchema)
    .use(isImageOwnerOrModerator)
    .mutation(updatePostImageHandler),
  addResourceToImage: verifiedProcedure
    .input(addResourceToPostImageInput)
    .use(isImageOwnerOrModerator)
    .mutation(addResourceToPostImageHandler),
  removeResourceFromImage: verifiedProcedure
    .input(removeResourceFromPostImageInput)
    .use(isImageOwnerOrModerator)
    .mutation(removeResourceFromPostImageHandler),
  reorderImages: verifiedProcedure
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
  enqueueNsfwLevelUpdate: moderatorProcedure.input(getByIdSchema).mutation(({ input }) =>
    enqueueJobs([
      {
        entityId: input.id,
        entityType: EntityType.Post,
        type: JobQueueType.UpdateNsfwLevel,
      },
    ])
  ),
});
