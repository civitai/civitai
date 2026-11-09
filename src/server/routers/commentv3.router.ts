import {
  deleteCommentV3Handler,
  getCommentRepliesHandler,
  getCommentSectionHandler,
  getCommentThreadHandler,
  setTosViolationV3Handler,
  toggleHideCommentV3Handler,
  togglePinCommentV3Handler,
  createCommentV3Handler,
  updateCommentV3Handler,
  getSectionLockHandler,
  toggleSectionLockHandler,
  getSectionMutedHandler,
  toggleSectionMuteHandler,
  getThreadMutedHandler,
  toggleThreadMuteHandler,
} from '~/server/controllers/commentv3.controller';
import { rateLimit } from '~/server/middleware.trpc';
import { COMMENT_V3_RATE_LIMIT_KEY, commentRateLimits } from '~/server/schema/comment.schema';
import {
  commentV3IdSchema,
  getCommentRepliesSchema,
  getCommentSectionSchema,
  getCommentThreadSchema,
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

/**
 * The v3 comment suite (`src/components/CommentsV3`). Writes serve only
 * `constants.comments.v3WriteSurfaces`; model comments still write through the v1 `comment`
 * router.
 */
export const commentv3Router = router({
  getSection: publicProcedure.input(getCommentSectionSchema).query(getCommentSectionHandler),
  getReplies: publicProcedure.input(getCommentRepliesSchema).query(getCommentRepliesHandler),
  getThread: publicProcedure.input(getCommentThreadSchema).query(getCommentThreadHandler),
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
  getSectionLock: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(commentSectionSchema)
    .query(getSectionLockHandler),
  toggleSectionLock: moderatorProcedure
    .input(commentSectionSchema)
    .mutation(toggleSectionLockHandler),
  getThreadMuted: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(commentMuteSchema)
    .query(getThreadMutedHandler),
  // `protectedProcedure`, not guarded: a muted or restricted account must still be able to
  // silence its notifications.
  toggleThreadMute: protectedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(commentMuteSchema)
    .use(rateLimit(muteRateLimits, undefined, { sharedKey: 'commentv3:mute' }))
    .mutation(toggleThreadMuteHandler),
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
