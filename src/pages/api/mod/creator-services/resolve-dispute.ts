import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import { resolveServiceDealDispute } from '~/server/services/creator-service-deal.service';
import { hasModeratorGrant } from '~/server/services/moderator-grants';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('creatorServices.resolveDispute', {
  summary: 'Settle a Disputed Creator Services deal: refund the buyer, or release to the seller.',
  returns:
    "{ status: 'resolved' | 'already-resolved', resolution } | { status: 'refused', reason: 'finals_not_passed', message }",
  notes: [
    'Requires the moderator app permission `creatorServices.resolveDispute`.',
    'Refund cancels the deal and returns the hold to the buyer. Release completes it and pays the seller, including one held as `seller_unavailable`.',
    "Release is refused while the round's finals have not all finished uploading and passed scanning: refund, or clear a failed scan in moderation first.",
    'Idempotent: a deal already resolved answers `already-resolved` with its resolution and moves no money. A deal that is not Disputed answers CONFLICT.',
    "A moderator who is the deal's buyer or seller answers FORBIDDEN, and nothing moves.",
  ],
  rateLimit: { max: 30, windowSeconds: 60 },
  input: z.object({
    dealId: z.coerce.number().int().positive(),
    resolution: z.enum(['Refund', 'Release']),
    note: z.string().trim().min(1).max(2000).optional().describe('Shown to both parties.'),
  }),
  async handler(input, ctx) {
    if (!(await hasModeratorGrant(ctx.actor, 'creatorServices.resolveDispute')))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message:
          'Resolving a dispute needs the "creatorServices.resolveDispute" moderator permission.',
      });

    const result = await resolveServiceDealDispute({
      dealId: input.dealId,
      moderatorId: ctx.actor.id,
      resolution: input.resolution,
      note: input.note,
    });
    return { ...result, affected: { serviceDealIds: [input.dealId] } };
  },
});
