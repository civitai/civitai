import { bulkDeleteCommentsV2 } from '~/server/services/commentsv2.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { commentAffected, commentIdSchema } from '~/server/schema/moderator/comment';

export default defineModeratorEndpoint('comment.bulkDelete', {
  summary: 'Delete comments in bulk.',
  returns: '{ commentV2Deleted }',
  notes: [
    'Every comment changes in one transaction: either all of it happens or none of it.',
    'A comment with replies stays as a placeholder for them.',
  ],
  rateLimit: { max: 30, windowSeconds: 60 },
  input: commentIdSchema,
  async handler(input) {
    const { deleted } = await bulkDeleteCommentsV2({ ids: input.commentV2Ids });
    return { commentV2Deleted: deleted, affected: commentAffected(input) };
  },
});
