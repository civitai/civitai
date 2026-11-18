import { bulkClearCommentV3TosViolation } from '~/server/services/commentv3/moderation.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { commentAffected, commentIdSchema } from '~/server/schema/moderator/comment';

export default defineModeratorEndpoint('comment.restoreFromTos', {
  summary: 'Clear a ToS flag from comments and reopen the reports that flag closed.',
  returns: '{ comments: { count, reopenedReports, failed } }',
  notes: [
    'The reverse of comment.removeAsTos, except for two steps it deliberately does not undo: Buzz already paid to reporters is not clawed back, and the owner is not notified.',
    'Only reports this flag ACTIONED are reopened, and they return to Pending rather than being dismissed — the flag being wrong does not make the report wrong.',
    '`failed` counts comments whose clear errored: they stay hidden, nothing about them changed, and a retry may restore them.',
  ],
  rateLimit: { max: 30, windowSeconds: 60 },
  input: commentIdSchema,
  async handler(input) {
    const comments = await bulkClearCommentV3TosViolation({ ids: input.commentIds });
    return { comments, affected: commentAffected(input) };
  },
});
