import * as z from 'zod';
import {
  RESOLUTION_NOTE_MAX_LENGTH,
  resolutionReasonError,
} from '@civitai/shared/resolution-reasons';
import { bountyId, bountyPoiRateLimit } from '~/server/schema/moderator/bounty-poi';
import { resolveBountyPoiAppeal } from '~/server/services/text-scan/actions/bounty-poi';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { defineModeratorEndpoint, moderatorBoolean } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('bountyPoi.resolveAppeal', {
  summary: 'Rule on a pending appeal against a text-scan real-person flag on a bounty.',
  returns: '{ resolved, bountyId, rescanQueued }',
  notes: [
    'Upholding refuses if the bounty is no longer flagged.',
    'Overturning restores the prior availability and keeps `poi` locked false.',
    'Overturning refuses, leaving the appeal open, when the bounty text cannot be read.',
    '`resolvedReason` is optional; when sent it must belong to the verdict (`flagAppeal`: Rejected for an uphold, Approved for an overturn) and to the real-person flag, or the request is refused.',
    '`rescanQueued` is always false and kept for compatibility: an overturn covers the text as last scanned.',
  ],
  rateLimit: bountyPoiRateLimit,
  input: z.object({
    bountyId,
    uphold: moderatorBoolean.describe('True upholds the flag, false overturns it.'),
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
    if (input.resolvedReason) {
      const invalid = resolutionReasonError(
        'flagAppeal',
        input.uphold ? 'Rejected' : 'Approved',
        input.resolvedReason,
        input.internalNotes,
        ['poi']
      );
      if (invalid) throw throwBadRequestError(invalid);
    }
    const { rescanQueued } = await resolveBountyPoiAppeal({
      bountyId: input.bountyId,
      uphold: input.uphold,
      userId: ctx.actor.id,
      resolvedReason: input.resolvedReason || undefined,
      internalNotes: input.internalNotes || undefined,
    });
    return {
      resolved: input.uphold ? 'upheld' : 'overturned',
      bountyId: input.bountyId,
      rescanQueued,
      affected: { bountyIds: [input.bountyId] },
    };
  },
});
