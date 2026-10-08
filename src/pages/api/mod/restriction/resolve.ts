import * as z from 'zod';
import {
  RESOLUTION_NOTE_MAX_LENGTH,
  resolutionReasonError,
} from '@civitai/shared/resolution-reasons';
import { resolveUserRestriction } from '~/server/services/user-restriction-resolve.service';
import { UserRestrictionStatus } from '~/shared/utils/prisma/enums';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('restriction.resolve', {
  summary: 'Rule on a pending generation restriction.',
  returns: '{ resolved }',
  notes: [
    'Clearing the mute alone resolves nothing — this is the write path that also closes the row, the subscription and the notification.',
  ],
  rateLimit: { max: 30, windowSeconds: 60 },
  input: z.object({
    userRestrictionId: z.coerce.number().int().positive().describe('The restriction to rule on.'),
    // Pending is not offered: it is the state being ruled on, and the service refuses anything
    // already resolved.
    status: z
      .enum([UserRestrictionStatus.Overturned, UserRestrictionStatus.Upheld])
      .describe('The verdict.'),
    resolvedMessage: z.string().trim().max(1000).optional().describe('Shown to the user.'),
    resolvedReason: z
      .string()
      .trim()
      .optional()
      .describe('A reason slug from @civitai/shared/resolution-reasons for this verdict.'),
    internalNotes: z
      .string()
      .trim()
      .max(RESOLUTION_NOTE_MAX_LENGTH)
      .optional()
      .describe('Moderator-only note. Never shown to the user.'),
  }),
  async handler(input, ctx) {
    // Optional so the older callers keep working, but a reason that IS sent is checked against the
    // verdict: an unchecked slug is a mislabelled row in the data this column exists to collect.
    if (input.resolvedReason) {
      const invalid = resolutionReasonError(
        'restriction',
        input.status,
        input.resolvedReason,
        input.internalNotes
      );
      if (invalid) throw throwBadRequestError(invalid);
    }
    const { userId } = await resolveUserRestriction({
      userRestrictionId: input.userRestrictionId,
      status: input.status,
      resolvedMessage: input.resolvedMessage,
      resolvedReason: input.resolvedReason || undefined,
      internalNotes: input.internalNotes || undefined,
      moderatorId: ctx.actor.id,
    });
    return { resolved: input.status, affected: { userIds: [userId] } };
  },
});
