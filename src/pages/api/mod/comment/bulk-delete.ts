import { TRPCError } from '@trpc/server';
import { bulkDeleteComments } from '~/server/services/comment.service';
import { bulkDeleteCommentsV2 } from '~/server/services/commentsv2.service';
import { isLegalHoldAbort, LEGAL_HOLD_STOPPED } from '~/server/services/legal-hold.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import {
  commentAffected,
  commentIdSchema,
  ensureAtLeastOneList,
} from '~/server/schema/moderator/comment';

const EMPTY = { count: 0, retainedHidden: 0 };

export default defineModeratorEndpoint('comment.bulkDelete', {
  summary: 'Delete comments in bulk, across both comment tables.',
  returns: '{ commentDeleted, commentV2Deleted, retainedHidden }',
  notes: [
    'At least one of the two id lists must be non-empty.',
    'Metric updates are queued.',
    'A comment that may not be deleted is kept hidden instead, and counted in `retainedHidden`.',
  ],
  rateLimit: { max: 30, windowSeconds: 60 },
  input: commentIdSchema,
  async handler(input) {
    ensureAtLeastOneList(input);
    try {
      const v1 = input.commentIds?.length
        ? await bulkDeleteComments({ ids: input.commentIds })
        : EMPTY;
      const v2 = input.commentV2Ids?.length
        ? await bulkDeleteCommentsV2({ ids: input.commentV2Ids })
        : EMPTY;
      return {
        commentDeleted: v1.count,
        commentV2Deleted: v2.count,
        retainedHidden: v1.retainedHidden + v2.retainedHidden,
        affected: commentAffected(input),
      };
    } catch (e) {
      // The error names the view; the moderator gets the neutral message instead.
      if (isLegalHoldAbort(e))
        throw new TRPCError({ code: 'CONFLICT', message: LEGAL_HOLD_STOPPED });
      throw e;
    }
  },
});
