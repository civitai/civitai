import {
  deleteCommentV3Handler,
  getCommentRepliesHandler,
  getCommentSectionHandler,
  getCommentThreadHandler,
  getTimedCommentsHandler,
  setTosViolationV3Handler,
  toggleCommentLockV3Handler,
  toggleHideCommentV3Handler,
  togglePinCommentV3Handler,
  createCommentV3Handler,
  updateCommentV3Handler,
  getSectionLockHandler,
  toggleSectionLockHandler,
  getSectionMutedHandler,
  toggleSectionMuteHandler,
  getCommentMutedHandler,
  toggleCommentMuteHandler,
} from '~/server/controllers/commentv3.controller';
import { rateLimit } from '~/server/middleware.trpc';
import {
  COMMENT_V3_RATE_LIMIT_KEY,
  commentRateLimits,
  commentV3IdSchema,
  getCommentRepliesSchema,
  getCommentSectionSchema,
  getCommentThreadSchema,
  getTimedCommentsSchema,
  createCommentV3Schema,
  updateCommentV3Schema,
  commentMuteSchema,
  commentSectionSchema,
  muteRateLimits,
} from '~/server/schema/commentv3.schema';
import {
  guardedProcedure,
  moderatorProcedure,
  protectedProcedure,
  publicProcedure,
  router,
} from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/** The v3 comment suite (`src/components/CommentsV3`), for every comment surface. */
export const commentv3Router = router({
  getSection: publicProcedure.input(getCommentSectionSchema).query(getCommentSectionHandler),
  getReplies: publicProcedure.input(getCommentRepliesSchema).query(getCommentRepliesHandler),
  getThread: publicProcedure.input(getCommentThreadSchema).query(getCommentThreadHandler),
  /** A song's timed comments, for the global player's waveform. */
  getTimed: publicProcedure.input(getTimedCommentsSchema).query(getTimedCommentsHandler),
  create: guardedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(createCommentV3Schema)
    .use(rateLimit(commentRateLimits, undefined, { sharedKey: COMMENT_V3_RATE_LIMIT_KEY }))
    .mutation(createCommentV3Handler),
  update: guardedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(updateCommentV3Schema)
    .use(rateLimit(commentRateLimits, undefined, { sharedKey: COMMENT_V3_RATE_LIMIT_KEY }))
    .mutation(updateCommentV3Handler),
  delete: protectedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(commentV3IdSchema)
    .mutation(deleteCommentV3Handler),
  toggleHide: protectedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(commentV3IdSchema)
    .mutation(toggleHideCommentV3Handler),
  togglePinned: protectedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(commentV3IdSchema)
    .mutation(togglePinCommentV3Handler),
  setTosViolation: moderatorProcedure.input(commentV3IdSchema).mutation(setTosViolationV3Handler),
  toggleLock: moderatorProcedure.input(commentV3IdSchema).mutation(toggleCommentLockV3Handler),
  getSectionLock: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(commentSectionSchema)
    .query(getSectionLockHandler),
  toggleSectionLock: moderatorProcedure
    .input(commentSectionSchema)
    .mutation(toggleSectionLockHandler),
  getCommentMuted: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(commentMuteSchema)
    .query(getCommentMutedHandler),
  // `protectedProcedure`, not guarded: a muted or restricted account must still be able to
  // silence its notifications.
  toggleCommentMute: protectedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(commentMuteSchema)
    .use(rateLimit(muteRateLimits, undefined, { sharedKey: 'commentv3:mute' }))
    .mutation(toggleCommentMuteHandler),
  getSectionMuted: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(commentSectionSchema)
    .query(getSectionMutedHandler),
  toggleSectionMute: protectedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(commentSectionSchema)
    .use(rateLimit(muteRateLimits, undefined, { sharedKey: 'commentv3:mute' }))
    .mutation(toggleSectionMuteHandler),
});
