import { CacheTTL } from '~/server/common/constants';
import { rateLimit } from '~/server/middleware.trpc';
import { addPostText, deletePostText, setPostText } from '~/server/services/post-text.service';
import { throwAuthorizationError } from '~/server/utils/errorHandling';
import {
  addOwnerChapterSchema,
  createStorylineSchema,
  getStorylinesInfiniteSchema,
  followStorylineSchema,
  insertStorylineChapterSchema,
  joinStorylineEarlyAccessSchema,
  leaveStorylineSchema,
  linkStorylineChapterSchema,
  moveStorylineChapterSchema,
  removeStorylineChapterSchema,
  moderateStorylineTitleSchema,
  setCanonChapterSchema,
  setFirstChapterSchema,
  setStorylineImageCaptionSchema,
  addStorylineTextSchema,
  setStorylineTextSchema,
  storylineTextIdSchema,
  setStorylineTakedownSchema,
  storylineBranchChoiceSchema,
  getStorylineSchema,
  getStorylinesForPostsSchema,
  storylinePendingForPostSchema,
  storylinePostImageCaptionsSchema,
  storylineChapterReadSchema,
  storylineCollaboratorSchema,
  storylineIdSchema,
  storylineLinkTargetsSchema,
  storylinePathSchema,
  updateStorylineSchema,
} from '~/server/schema/storyline.schema';
import {
  addOwnerChapter,
  addOwnerChapterAtEnd,
  addStorylineCollaborator,
  createStoryline,
  deleteStoryline,
  removeStorylineChapter,
  getStoryline,
  getStorylineCanonAhead,
  getStorylineChapterLevels,
  getStorylineChildren,
  getStorylinePath,
  getStorylineEarlyAccessStats,
  getStorylineEarlyAccessStatus,
  getStorylineForkShares,
  getStorylineGraph,
  getPendingChapterForPost,
  getStorylineLinkTargets,
  getStorylinesForPosts,
  getStorylinesInfinite,
  insertStorylineChapter,
  joinStorylineEarlyAccess,
  linkStorylineChapter,
  moderateStorylineTitle,
  moveStorylineChapter,
  recordStorylineBranchChoice,
  recordStorylineCreateClick,
  removePendingChapter,
  removeStorylineCollaborator,
  acceptStorylineInvite,
  followStoryline,
  getStorylineFollow,
  unfollowStoryline,
  setCanonChapter,
  setFirstChapter,
  setStorylineTakedown,
  updateStoryline,
} from '~/server/services/storyline.service';
import {
  getPostImageCaptions,
  setStorylineImageCaption,
} from '~/server/services/storyline-caption.service';
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
// Text items between a chapter's images, behind their own flag.
const storylineTextProcedure = guardedProcedure
  .use(isFlagProtected('storylines'))
  .use(isFlagProtected('storylineText'));
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

  getPath: storylineReadProcedure.input(storylinePathSchema).query(({ input, ctx }) =>
    getStorylinePath({
      chapterId: input.chapterId,
      via: input.via,
      viewer: ctx.user,
      browsingLevel: storylineReaderLevel(ctx, input.browsingLevel),
      withTexts: !!ctx.features.storylineText,
    })
  ),

  getGraph: storylineReadProcedure.input(getStorylineSchema).query(({ input, ctx }) =>
    getStorylineGraph({
      id: input.id,
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
      userId: input.userId,
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

  getPendingForPost: storylineMemberProcedure
    .input(storylinePendingForPostSchema)
    .query(({ input, ctx }) =>
      getPendingChapterForPost({
        postId: input.postId,
        userId: ctx.user.id,
        isModerator: ctx.user.isModerator,
      })
    ),

  getPostImageCaptions: storylineMemberProcedure
    .input(storylinePostImageCaptionsSchema)
    .query(({ input, ctx }) =>
      getPostImageCaptions({
        postId: input.postId,
        userId: ctx.user.id,
        isModerator: ctx.user.isModerator,
      })
    ),

  removePending: storylineMemberProcedure
    .input(storylinePendingForPostSchema)
    .mutation(({ input, ctx }) =>
      removePendingChapter({ postId: input.postId, userId: ctx.user.id })
    ),

  getFollow: storylineMemberProcedure
    .input(storylineIdSchema)
    .query(({ input, ctx }) => getStorylineFollow({ storylineId: input.id, userId: ctx.user.id })),

  follow: storylineMemberProcedure.input(followStorylineSchema).mutation(({ input, ctx }) =>
    followStoryline({
      storylineId: input.storylineId,
      scope: input.scope,
      viewer: ctx.user,
      browsingLevel: storylineReaderLevel(ctx, input.browsingLevel),
    })
  ),

  unfollow: storylineMemberProcedure
    .input(storylineIdSchema)
    .mutation(({ input, ctx }) =>
      unfollowStoryline({ storylineId: input.id, userId: ctx.user.id })
    ),

  getEarlyAccessStatus: storylineMemberProcedure.query(({ ctx }) =>
    getStorylineEarlyAccessStatus(ctx.user.id)
  ),

  getEarlyAccessStats: moderatorProcedure.query(() => getStorylineEarlyAccessStats()),

  moderateTitle: moderatorProcedure
    .input(moderateStorylineTitleSchema)
    .mutation(({ input, ctx }) => moderateStorylineTitle({ ...input, moderatorId: ctx.user.id })),

  setTakedown: moderatorProcedure
    .input(setStorylineTakedownSchema)
    .mutation(({ input }) => setStorylineTakedown(input)),

  create: storylineWriteProcedure.input(createStorylineSchema).mutation(({ input, ctx }) => {
    // A creator turns sparks off through their remix gallery, which only this flag shows them.
    if (input.sparkImageId && !ctx.features.remixGallery)
      throw throwAuthorizationError('Starting a story from an image is not available yet');
    return createStoryline({ ...input, userId: ctx.user.id, isModerator: ctx.user.isModerator });
  }),

  update: storylineWriteProcedure
    .input(updateStorylineSchema)
    .mutation(({ input, ctx }) =>
      updateStoryline({ ...input, userId: ctx.user.id, isModerator: ctx.user.isModerator })
    ),

  delete: storylineWriteProcedure
    .input(storylineIdSchema)
    .mutation(({ input, ctx }) =>
      deleteStoryline({ id: input.id, userId: ctx.user.id, isModerator: ctx.user.isModerator })
    ),

  setImageCaption: storylineWriteProcedure
    .input(setStorylineImageCaptionSchema)
    .mutation(({ input, ctx }) =>
      setStorylineImageCaption({ ...input, userId: ctx.user.id, isModerator: ctx.user.isModerator })
    ),

  addText: storylineTextProcedure
    .input(addStorylineTextSchema)
    .mutation(({ input, ctx }) => addPostText({ ...input, userId: ctx.user.id })),

  // The editor saves 2 s after typing stops, and each save that changes the text bills a scan.
  setText: storylineTextProcedure
    .input(setStorylineTextSchema)
    .use(rateLimit({ limit: 300, period: CacheTTL.hour }))
    .mutation(({ input, ctx }) =>
      setPostText({ ...input, userId: ctx.user.id, isModerator: ctx.user.isModerator })
    ),

  deleteText: storylineTextProcedure
    .input(storylineTextIdSchema)
    .mutation(({ input, ctx }) =>
      deletePostText({ ...input, userId: ctx.user.id, isModerator: ctx.user.isModerator })
    ),

  setFirstChapter: storylineWriteProcedure
    .input(setFirstChapterSchema)
    .mutation(({ input, ctx }) => setFirstChapter({ ...input, userId: ctx.user.id })),

  addChapter: storylineWriteProcedure
    .input(addOwnerChapterSchema)
    .mutation(({ input, ctx }) => addOwnerChapter({ ...input, userId: ctx.user.id })),

  addChapterAtEnd: storylineWriteProcedure
    .input(setFirstChapterSchema)
    .mutation(({ input, ctx }) => addOwnerChapterAtEnd({ ...input, userId: ctx.user.id })),

  setCanon: storylineWriteProcedure.input(setCanonChapterSchema).mutation(({ input, ctx }) =>
    setCanonChapter({
      chapterId: input.chapterId,
      parentChapterId: input.parentChapterId,
      userId: ctx.user.id,
      isModerator: ctx.user.isModerator,
    })
  ),

  insertChapter: storylineWriteProcedure
    .input(insertStorylineChapterSchema)
    .mutation(({ input, ctx }) =>
      insertStorylineChapter({ ...input, userId: ctx.user.id, isModerator: ctx.user.isModerator })
    ),

  moveChapter: storylineWriteProcedure
    .input(moveStorylineChapterSchema)
    .mutation(({ input, ctx }) =>
      moveStorylineChapter({ ...input, userId: ctx.user.id, isModerator: ctx.user.isModerator })
    ),

  removeChapter: storylineWriteProcedure
    .input(removeStorylineChapterSchema)
    .mutation(({ input, ctx }) =>
      removeStorylineChapter({ ...input, userId: ctx.user.id, isModerator: ctx.user.isModerator })
    ),

  linkChapter: storylineWriteProcedure
    .input(linkStorylineChapterSchema)
    .mutation(({ input, ctx }) =>
      linkStorylineChapter({ ...input, userId: ctx.user.id, isModerator: ctx.user.isModerator })
    ),

  getLinkTargets: storylineMemberProcedure
    .input(storylineLinkTargetsSchema)
    .query(({ input, ctx }) =>
      getStorylineLinkTargets({
        parentChapterId: input.parentChapterId,
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
      })
    ),

  // A collaborator steps down through `leave`, not here: removal is guarded because it is someone
  // else's access being changed, and a muted collaborator must still be able to leave a storyline
  // they were added to without being asked.
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

  acceptInvite: storylineWriteProcedure
    .input(leaveStorylineSchema)
    .mutation(({ input, ctx }) =>
      acceptStorylineInvite({ storylineId: input.storylineId, userId: ctx.user.id })
    ),

  leave: storylineMemberProcedure.input(leaveStorylineSchema).mutation(({ input, ctx }) =>
    removeStorylineCollaborator({
      storylineId: input.storylineId,
      targetUserId: ctx.user.id,
      userId: ctx.user.id,
    })
  ),
});
