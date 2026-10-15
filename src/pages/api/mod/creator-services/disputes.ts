import * as z from 'zod';
import { listDisputedServiceDeals } from '~/server/services/creator-service-deal.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('creatorServices.disputes', {
  method: 'GET',
  summary: 'The Creator Services dispute queue: Disputed deals, oldest first.',
  returns:
    '{ items: [{ id, offering, buyer, seller: { id, username, unavailable }, price, buzzType, revisionsUsed, disputeOpenedAt, disputeReason, cancellationReason, completedAt, deliveredAt, finalsClear, events }], nextCursor? }',
  notes: [
    "`disputeReason` is the buyer's text, `cancellation_declined`, or a system hold: `seller_unavailable` (banned or deleted at payout) or `final_scan_failed`.",
    "`finalsClear` false means Release will be refused: the round's finals have not all passed scanning.",
  ],
  input: z.object({
    cursor: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  }),
  handler: (input) => listDisputedServiceDeals(input),
});
