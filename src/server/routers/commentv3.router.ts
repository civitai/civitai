import {
  getCommentRepliesHandler,
  getCommentSectionHandler,
  getCommentThreadHandler,
} from '~/server/controllers/commentv3.controller';
import {
  getCommentRepliesSchema,
  getCommentSectionSchema,
  getCommentThreadSchema,
} from '~/server/schema/commentv3.schema';
import { publicProcedure, router } from '~/server/trpc';

/**
 * Reads for the v3 comment suite (`src/components/CommentsV3`). Writes stay on `commentv2` until a
 * surface's write flip; the suite's mutation adapter decides which router a surface writes through.
 */
export const commentv3Router = router({
  getSection: publicProcedure.input(getCommentSectionSchema).query(getCommentSectionHandler),
  getReplies: publicProcedure.input(getCommentRepliesSchema).query(getCommentRepliesHandler),
  getThread: publicProcedure.input(getCommentThreadSchema).query(getCommentThreadHandler),
});
