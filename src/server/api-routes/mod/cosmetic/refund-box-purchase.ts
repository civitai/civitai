import * as z from 'zod';
import { refundBoxPurchase } from '~/server/services/mystery-box-refund.service';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('cosmetic.refundBoxPurchase', {
  summary: "Refund a creator's mystery box purchase: Buzz back, payout reversed.",
  returns: '{ status, refunded, clawedBack }',
  notes: [
    'Takes back the held box, or what it gave once opened, and returns the Buzz; the creator bears it.',
    'Running it again finishes a refund that began and did not return the Buzz.',
  ],
  rateLimit: { max: 30, windowSeconds: 60 },
  input: z.object({
    userId: z.coerce.number().int().positive().describe('The buyer.'),
    buzzTransactionId: z.string().min(1).describe('The purchase.'),
  }),
  async handler({ userId, buzzTransactionId }, ctx) {
    const outcome = await refundBoxPurchase({
      buzzTransactionId,
      userId,
      reason: 'moderator',
      actorId: ctx.actor.id,
    });
    if (outcome.status === 'skipped') throw throwBadRequestError(`Not refunded: ${outcome.reason}`);
    if (outcome.status === 'failed') throw throwBadRequestError(`Refund failed: ${outcome.error}`);
    return {
      status: outcome.status,
      refunded: outcome.refunded,
      clawedBack: outcome.clawedBack,
      payoutFailures: outcome.payoutFailures.length,
      affected: { userIds: [userId] },
    };
  },
});
