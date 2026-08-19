import { bulkDeleteComments } from '~/server/services/comment.service';
import { bulkDeleteCommentsV2 } from '~/server/services/commentsv2.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import {
  commentAffected,
  commentIdSchema,
  ensureAtLeastOneList,
} from '~/server/schema/moderator/comment';

export default defineModeratorEndpoint('comment.bulkDelete', {
  summary: 'Delete comments in bulk, across both comment tables.',
  returns: '{ commentDeleted, commentV2Deleted }',
  notes: ['At least one of the two id lists must be non-empty.', 'Metric updates are queued.'],
  rateLimit: { max: 30, windowSeconds: 60 },
  input: commentIdSchema,
  async handler(input) {
    ensureAtLeastOneList(input);
    const v1 = input.commentIds?.length
      ? await bulkDeleteComments({ ids: input.commentIds })
      : { count: 0 };
    const v2 = input.commentV2Ids?.length
      ? await bulkDeleteCommentsV2({ ids: input.commentV2Ids })
      : { count: 0 };
    return {
      commentDeleted: v1.count,
      commentV2Deleted: v2.count,
      affected: commentAffected(input),
    };
  },
});
