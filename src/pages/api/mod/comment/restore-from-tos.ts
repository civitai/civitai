import { bulkClearCommentTosViolation } from '~/server/services/comment.service';
import { bulkClearCommentV2TosViolation } from '~/server/services/commentsv2.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import {
  commentAffected,
  commentIdSchema,
  ensureAtLeastOneList,
} from '~/server/schema/moderator/comment';

const EMPTY = { count: 0, reopenedReports: 0 };

export default defineModeratorEndpoint('comment.restoreFromTos', {
  summary: 'Clear a ToS flag from comments and reopen the reports that flag closed.',
  returns: '{ comment, commentV2 } — each { count, reopenedReports }',
  notes: [
    'At least one of the two id lists must be non-empty.',
    'The reverse of comment.removeAsTos, except for two steps it deliberately does not undo: Buzz already paid to reporters is not clawed back, and the owner is not notified.',
    'Only reports this flag ACTIONED are reopened, and they return to Pending rather than being dismissed — the flag being wrong does not make the report wrong.',
  ],
  rateLimit: { max: 30, windowSeconds: 60 },
  input: commentIdSchema,
  async handler(input) {
    ensureAtLeastOneList(input);

    const v1 = input.commentIds?.length
      ? await bulkClearCommentTosViolation({ ids: input.commentIds })
      : EMPTY;
    const v2 = input.commentV2Ids?.length
      ? await bulkClearCommentV2TosViolation({ ids: input.commentV2Ids })
      : EMPTY;

    return { comment: v1, commentV2: v2, affected: commentAffected(input) };
  },
});
