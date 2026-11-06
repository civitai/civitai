import { bulkDeleteComments } from '~/server/services/comment.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import {
  commentAffected,
  commentIdSchema,
  ensureAtLeastOneList,
} from '~/server/schema/moderator/comment';

export default defineModeratorEndpoint('comment.bulkDelete', {
  summary: 'Delete comments in bulk, across both comment tables.',
  returns: '{ commentDeleted, commentV2Deleted }',
  notes: [
    'At least one of the two id lists must be non-empty.',
    'Both tables change in one transaction: either all of it happens or none of it.',
    'Metric updates are queued.',
  ],
  rateLimit: { max: 30, windowSeconds: 60 },
  input: commentIdSchema,
  async handler(input) {
    ensureAtLeastOneList(input);
    const result = await bulkDeleteComments({
      commentIds: input.commentIds ?? [],
      commentV2Ids: input.commentV2Ids ?? [],
    });
    return { ...result, affected: commentAffected(input) };
  },
});
