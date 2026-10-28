import * as z from 'zod';
import { listDisputedServiceDeals } from '~/server/services/creator-service-deal.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('creatorServices.disputes', {
  method: 'GET',
  summary: 'The Creator Services dispute queue: Disputed deals, longest-waiting dispute first.',
  returns:
    '{ items: [{ id, offering, buyer, seller: { id, username, unavailable }, price, buzzType, revisionsUsed, disputeOpenedAt, disputeReason, cancellationReason, completedAt, deliveredAt, finalsClear, events, latestReview }], nextCursor? }',
  notes: [
    "`disputeReason` is the buyer's text, `cancellation_declined`, or a system hold: `seller_unavailable` (banned or deleted at payout) or `final_scan_failed`. It is null when the buyer gave only a code or was muted; the code is on the `Disputed` event's `reasonCode` (for `cancellation_declined`, on the latest `CancellationRequested` event).",
    "`finalsClear` false means Release will be refused: the round's finals have not all passed scanning.",
    '`latestReview` is the most recent dispute review ({ id, class, proposal, confidence, rationale, agentVersion, mode, createdAt }), or null. `proposal` null means it escalated to a human.',
  ],
  grantHolders: ['creatorServices.reviewDispute'],
  input: z.object({
    cursor: z.string().max(64).optional().describe('`nextCursor` from the previous page.'),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  }),
  handler: (input, { actor }) => listDisputedServiceDeals({ ...input, viewerId: actor.id }),
});
