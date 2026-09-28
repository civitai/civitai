import * as z from 'zod';
import { repayBountyAward } from '~/server/services/bountyEntry.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('bounty.repayAward', {
  summary: 'Resend the Buzz payout for a bounty award that was recorded but not paid.',
  returns: '{ bountyId, winnerUserId, amount }',
  notes: [
    'Use for awards listed by the `bounty-award` "Award committed but the Buzz payout failed" error.',
    'Idempotent: the payout reuses the award\'s externalTransactionId, so an award that was paid is not paid twice.',
    'Refuses legacy awards without transaction ids.',
  ],
  rateLimit: { max: 30, windowSeconds: 60 },
  input: z.object({
    entryId: z.number().int().positive(),
    benefactorUserId: z.number().int().positive(),
  }),
  async handler(input) {
    const result = await repayBountyAward(input);
    return { ...result, affected: { userIds: [result.winnerUserId] } };
  },
});
