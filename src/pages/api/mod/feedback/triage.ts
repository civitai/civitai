import { TRPCError } from '@trpc/server';
import { feedbackTriageRequest } from '@civitai/moderation';
import { FEEDBACK_TRIAGE_NOTE_APPEND_MAX_LENGTH } from '~/shared/constants/feedback.constants';
import { setFeedbackTriage } from '~/server/services/feedback-triage.service';
import { hasModeratorGrant } from '~/server/services/moderator-grants';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { throwNotFoundError } from '~/server/utils/errorHandling';

export default defineModeratorEndpoint('feedback.triage', {
  summary: "Set one feedback report's triage status, as the moderator queue's status buttons do.",
  returns: '{ id, status, changed }',
  notes: [
    'Requires the moderator app permission `feedback.status.set`, the one the queue requires.',
    'Pass the status you last read as `expectedStatus`: a report that has moved since is not changed (409). Read it again before retrying.',
    `\`noteAppend\` (at most ${FEEDBACK_TRIAGE_NOTE_APPEND_MAX_LENGTH} characters) is added below the internal triage note; it never replaces it.`,
    '`hqTaskUrl` (https://hq.civitai.com/t/<id> exactly) is recorded as the report’s HQ task link.',
    'With `status` equal to `expectedStatus`, only the note and the link are written; who triaged it, and when, stay as they were.',
  ],
  rateLimit: { max: 30, windowSeconds: 60 },
  input: feedbackTriageRequest,
  async handler(input, ctx) {
    if (!(await hasModeratorGrant(ctx.actor, 'feedback.status.set')))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Setting a feedback status needs the "feedback.status.set" moderator permission.',
      });

    const outcome = await setFeedbackTriage({ ...input, actorId: ctx.actor.id });
    if (outcome === 'gone') throw throwNotFoundError(`No feedback report ${input.id}.`);
    if (outcome === 'conflict')
      throw new TRPCError({
        code: 'CONFLICT',
        message: `Feedback report ${input.id} is no longer ${input.expectedStatus}; read it again before setting a status.`,
      });

    return {
      id: input.id,
      status: input.status,
      changed: true,
      affected: { feedbackIds: [input.id] },
    };
  },
});
