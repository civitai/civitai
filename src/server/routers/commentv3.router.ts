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
} from '~/server/controllers/commentv3.controller';
import { rateLimit } from '~/server/middleware.trpc';
import { commentRateLimits } from '~/server/schema/comment.schema';
import {
  commentV3IdSchema,
  getCommentRepliesSchema,
  getCommentSectionSchema,
  getCommentThreadSchema,
  createCommentV3Schema,
  updateCommentV3Schema,
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
 * `constants.comments.v3WriteSurfaces`; the rest still write through `commentv2`.
 */
export const commentv3Router = router({
  getSection: publicProcedure.input(getCommentSectionSchema).query(getCommentSectionHandler),
  getReplies: publicProcedure.input(getCommentRepliesSchema).query(getCommentRepliesHandler),
  getThread: publicProcedure.input(getCommentThreadSchema).query(getCommentThreadHandler),
  // One budget with commentv2.upsert, so the routers do not double it.
  create: guardedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(createCommentV3Schema)
    .use(rateLimit(commentRateLimits, undefined, { sharedKey: 'commentv2:upsert' }))
    .mutation(createCommentV3Handler),
  update: guardedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(updateCommentV3Schema)
    .use(rateLimit(commentRateLimits, undefined, { sharedKey: 'commentv2:upsert' }))
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
});
