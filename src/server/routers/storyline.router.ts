import {
  addOwnerChapterSchema,
  createStorylineSchema,
  getStorylineSchema,
  getStorylinesForPostsSchema,
  storylineChapterReadSchema,
  storylineChapterSchema,
  storylineCollaboratorSchema,
  updateStorylineSchema,
} from '~/server/schema/storyline.schema';
import {
  addOwnerChapter,
  addStorylineCollaborator,
  createStoryline,
  getStoryline,
  getStorylineChildren,
  getStorylinePath,
  getStorylinesForPosts,
  removeStorylineCollaborator,
  setCanonChapter,
  updateStoryline,
} from '~/server/services/storyline.service';
import {
  guardedProcedure,
  isFlagProtected,
  protectedProcedure,
  publicProcedure,
  router,
} from '~/server/trpc';
import { storylineReaderLevel } from '~/server/utils/storyline-reader-level';

const storylineReadProcedure = publicProcedure.use(isFlagProtected('storylines'));
const storylineWriteProcedure = guardedProcedure.use(isFlagProtected('storylines'));
const storylineMemberProcedure = protectedProcedure.use(isFlagProtected('storylines'));

export const storylineRouter = router({
  getById: storylineReadProcedure.input(getStorylineSchema).query(({ input, ctx }) =>
    getStoryline({
      id: input.id,
      viewer: ctx.user,
      browsingLevel: storylineReaderLevel(ctx, input.browsingLevel),
    })
  ),

  getForPosts: storylineReadProcedure.input(getStorylinesForPostsSchema).query(({ input, ctx }) =>
    getStorylinesForPosts({
      postIds: input.postIds,
      viewer: ctx.user,
      browsingLevel: storylineReaderLevel(ctx, input.browsingLevel),
    })
  ),

  getPath: storylineReadProcedure.input(storylineChapterReadSchema).query(({ input, ctx }) =>
    getStorylinePath({
      chapterId: input.chapterId,
      viewer: ctx.user,
      browsingLevel: storylineReaderLevel(ctx, input.browsingLevel),
    })
  ),

  getChildren: storylineReadProcedure.input(storylineChapterReadSchema).query(({ input, ctx }) =>
    getStorylineChildren({
      chapterId: input.chapterId,
      viewer: ctx.user,
      browsingLevel: storylineReaderLevel(ctx, input.browsingLevel),
    })
  ),

  create: storylineWriteProcedure
    .input(createStorylineSchema)
    .mutation(({ input, ctx }) =>
      createStoryline({ ...input, userId: ctx.user.id, isModerator: ctx.user.isModerator })
    ),

  update: storylineWriteProcedure
    .input(updateStorylineSchema)
    .mutation(({ input, ctx }) =>
      updateStoryline({ ...input, userId: ctx.user.id, isModerator: ctx.user.isModerator })
    ),

  addChapter: storylineWriteProcedure
    .input(addOwnerChapterSchema)
    .mutation(({ input, ctx }) => addOwnerChapter({ ...input, userId: ctx.user.id })),

  setCanon: storylineMemberProcedure.input(storylineChapterSchema).mutation(({ input, ctx }) =>
    setCanonChapter({
      chapterId: input.chapterId,
      userId: ctx.user.id,
      isModerator: ctx.user.isModerator,
    })
  ),

  addCollaborator: storylineMemberProcedure
    .input(storylineCollaboratorSchema)
    .mutation(({ input, ctx }) =>
      addStorylineCollaborator({
        storylineId: input.storylineId,
        targetUserId: input.userId,
        userId: ctx.user.id,
        isModerator: ctx.user.isModerator,
      })
    ),

  removeCollaborator: storylineMemberProcedure
    .input(storylineCollaboratorSchema)
    .mutation(({ input, ctx }) =>
      removeStorylineCollaborator({
        storylineId: input.storylineId,
        targetUserId: input.userId,
        userId: ctx.user.id,
        isModerator: ctx.user.isModerator,
      })
    ),
});
