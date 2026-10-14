import {
  addOwnerChapterSchema,
  createStorylineSchema,
  getStorylinesInfiniteSchema,
  joinStorylineEarlyAccessSchema,
  moderateStorylineTitleSchema,
  storylineBranchChoiceSchema,
  getStorylineSchema,
  getStorylinesForPostsSchema,
  storylineChapterReadSchema,
  storylineChapterSchema,
  storylineCollaboratorSchema,
  storylineIdSchema,
  updateStorylineSchema,
} from '~/server/schema/storyline.schema';
import {
  addOwnerChapter,
  addStorylineCollaborator,
  createStoryline,
  getStoryline,
  getStorylineCanonAhead,
  getStorylineChapterLevels,
  getStorylineChildren,
  getStorylinePath,
  getStorylineEarlyAccessStats,
  getStorylineEarlyAccessStatus,
  getStorylineForkShares,
  getStorylinesForPosts,
  getStorylinesInfinite,
  joinStorylineEarlyAccess,
  moderateStorylineTitle,
  recordStorylineBranchChoice,
  recordStorylineCreateClick,
  removeStorylineCollaborator,
  setCanonChapter,
  updateStoryline,
} from '~/server/services/storyline.service';
import {
  guardedProcedure,
  isFlagProtected,
  moderatorProcedure,
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

  getCanonAhead: storylineReadProcedure.input(storylineChapterReadSchema).query(({ input, ctx }) =>
    getStorylineCanonAhead({
      chapterId: input.chapterId,
      viewer: ctx.user,
      browsingLevel: storylineReaderLevel(ctx, input.browsingLevel),
    })
  ),

  getChapterLevels: storylineMemberProcedure.input(storylineIdSchema).query(({ input, ctx }) =>
    getStorylineChapterLevels({
      id: input.id,
      userId: ctx.user.id,
      isModerator: ctx.user.isModerator,
    })
  ),

  getForkShares: storylineReadProcedure.input(storylineChapterReadSchema).query(({ input, ctx }) =>
    getStorylineForkShares({
      chapterId: input.chapterId,
      viewer: ctx.user,
      browsingLevel: storylineReaderLevel(ctx, input.browsingLevel),
    })
  ),

  getInfinite: storylineReadProcedure.input(getStorylinesInfiniteSchema).query(({ input, ctx }) =>
    getStorylinesInfinite({
      filter: input.filter,
      sort: input.sort,
      cursor: input.cursor,
      limit: input.limit,
      viewer: ctx.user,
      browsingLevel: storylineReaderLevel(ctx, input.browsingLevel),
    })
  ),

  // Signed-in readers only: a choice from a signed-out reader is not counted, so the share
  // cannot be stuffed by repeated anonymous requests.
  trackBranchChoice: storylineMemberProcedure
    .input(storylineBranchChoiceSchema)
    .mutation(({ input, ctx }) =>
      recordStorylineBranchChoice({
        fromChapterId: input.fromChapterId,
        toChapterId: input.toChapterId,
        viewer: ctx.user,
        browsingLevel: storylineReaderLevel(ctx, input.browsingLevel),
      })
    ),

  trackCreateClick: storylineMemberProcedure
    .input(storylineChapterReadSchema)
    .mutation(({ input, ctx }) =>
      recordStorylineCreateClick({
        chapterId: input.chapterId,
        viewer: ctx.user,
        browsingLevel: storylineReaderLevel(ctx, input.browsingLevel),
      })
    ),

  joinEarlyAccess: storylineMemberProcedure
    .input(joinStorylineEarlyAccessSchema)
    .mutation(({ input, ctx }) =>
      joinStorylineEarlyAccess({ storylineId: input.storylineId, userId: ctx.user.id })
    ),

  getEarlyAccessStatus: storylineMemberProcedure.query(({ ctx }) =>
    getStorylineEarlyAccessStatus(ctx.user.id)
  ),

  getEarlyAccessStats: moderatorProcedure.query(() => getStorylineEarlyAccessStats()),

  moderateTitle: moderatorProcedure
    .input(moderateStorylineTitleSchema)
    .mutation(({ input }) => moderateStorylineTitle(input)),

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

  setCanon: storylineWriteProcedure.input(storylineChapterSchema).mutation(({ input, ctx }) =>
    setCanonChapter({
      chapterId: input.chapterId,
      userId: ctx.user.id,
      isModerator: ctx.user.isModerator,
    })
  ),

  addCollaborator: storylineWriteProcedure
    .input(storylineCollaboratorSchema)
    .mutation(({ input, ctx }) =>
      addStorylineCollaborator({
        storylineId: input.storylineId,
        targetUserId: input.userId,
        userId: ctx.user.id,
        isModerator: ctx.user.isModerator,
      })
    ),

  removeCollaborator: storylineWriteProcedure
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
