import { TRPCError } from '@trpc/server';
import { bulkDeleteComments } from '~/server/services/comment.service';
import { isLegalHoldAbort } from '~/server/services/legal-hold.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import {
  commentAffected,
  commentIdSchema,
  ensureAtLeastOneList,
} from '~/server/schema/moderator/comment';

export default defineModeratorEndpoint('comment.bulkDelete', {
  summary: 'Delete comments in bulk, across both comment tables.',
  returns: '{ commentDeleted, commentV2Deleted, retainedHidden }',
  notes: [
    'At least one of the two id lists must be non-empty.',
    'Both tables change in one transaction: either all of it happens or none of it.',
    'Metric updates are queued.',
    'A comment that may not be deleted is kept hidden instead, and counted in `retainedHidden`.',
  ],
  rateLimit: { max: 30, windowSeconds: 60 },
  input: commentIdSchema,
  async handler(input) {
    ensureAtLeastOneList(input);
    try {
      const result = await bulkDeleteComments({
        commentIds: input.commentIds ?? [],
        commentV2Ids: input.commentV2Ids ?? [],
      });
      return { ...result, affected: commentAffected(input) };
    } catch (e) {
      // The database error names what stopped it; the moderator gets neutral wording instead.
      if (isLegalHoldAbort(e))
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'The delete could not finish, so no comment was deleted. Reload and try again.',
        });
      throw e;
    }
  },
});
