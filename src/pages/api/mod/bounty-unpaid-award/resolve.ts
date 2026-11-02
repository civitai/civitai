import { resolveUnpaidBountyAwardInputSchema } from '~/server/schema/bounty.schema';
import { resolveUnpaidBountyAward } from '~/server/services/bounty.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('bounty.resolveUnpaidAward', {
  summary: 'Record a ruling on a bounty award or supporter refund left for manual resolution.',
  returns: '{ recorded, bountyId, userId, ruling }',
  notes: [
    'Records the ruling only: it moves no Buzz.',
    '`paid_winner` is refused on a record with no winner (an unconfirmed supporter refund).',
    'Repeating the ruling a record already has returns `recorded: false`; a different ruling on a resolved record is refused with 409.',
  ],
  rateLimit: { max: 60, windowSeconds: 60 },
  input: resolveUnpaidBountyAwardInputSchema,
  async handler(input, ctx) {
    const { recorded } = await resolveUnpaidBountyAward({ ...input, moderatorId: ctx.actor.id });
    return {
      recorded,
      bountyId: input.bountyId,
      userId: input.userId,
      ruling: input.ruling,
      affected: { bountyIds: [input.bountyId], userIds: [input.userId] },
    };
  },
});
