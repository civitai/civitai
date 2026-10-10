import * as z from 'zod';
import { bountyId, bountyPoiRateLimit } from '~/server/schema/moderator/bounty-poi';
import { resolveBountyPoiAppeal } from '~/server/services/text-scan/actions/bounty-poi';
import { defineModeratorEndpoint, moderatorBoolean } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('bountyPoi.resolveAppeal', {
  summary: 'Rule on a pending appeal against a text-scan real-person flag on a bounty.',
  returns: '{ resolved, bountyId, rescanQueued }',
  notes: [
    'Upholding refuses if the bounty is no longer flagged.',
    'Overturning restores the prior availability and keeps `poi` locked false.',
    'Overturning refuses, leaving the appeal open, when the bounty text cannot be read.',
  ],
  rateLimit: bountyPoiRateLimit,
  input: z.object({
    bountyId,
    uphold: moderatorBoolean.describe('True upholds the flag, false overturns it.'),
  }),
  async handler(input, ctx) {
    const { rescanQueued } = await resolveBountyPoiAppeal({
      bountyId: input.bountyId,
      uphold: input.uphold,
      userId: ctx.actor.id,
    });
    return {
      resolved: input.uphold ? 'upheld' : 'overturned',
      bountyId: input.bountyId,
      rescanQueued,
      affected: { bountyIds: [input.bountyId] },
    };
  },
});
