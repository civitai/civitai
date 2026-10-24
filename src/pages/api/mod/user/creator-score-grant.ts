import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import { userId } from '~/server/schema/moderator/user';
import { hasModeratorGrant } from '~/server/services/moderator-grants';
import {
  CREATOR_SCORE_GRANT_LIMITS,
  grantCreatorScore,
} from '~/server/services/creator-score-grant.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('user.creator-score-grant', {
  summary: 'Award Creator Score to an account by hand. It shows as "Staff awarded" in their score.',
  returns: '{ id, amount, createdAt, total }',
  notes: [
    'Requires the moderator app permission `user.creatorScore.grant`.',
    `Whole points from 1 to ${CREATOR_SCORE_GRANT_LIMITS.maxAmount}; a moderator cannot grant to their own account.`,
    `Up to ${CREATOR_SCORE_GRANT_LIMITS.largeMaxAmount} per grant also requires \`user.creatorScore.grantLarge\`.`,
    `At most ${CREATOR_SCORE_GRANT_LIMITS.dailyPerModerator} grants per moderator in any 24 hours.`,
    'The grant, a ModActivity row and the account’s new total are written together; tier milestones and their notifications follow as for any score rise.',
  ],
  rateLimit: { max: 5, windowSeconds: 60 },
  input: z.object({
    userId,
    amount: z.coerce.number().int().min(1).max(CREATOR_SCORE_GRANT_LIMITS.largeMaxAmount),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(CREATOR_SCORE_GRANT_LIMITS.maxReasonLength)
      .describe('Why: an audit note for moderators. The user does not see it.'),
  }),
  async handler(input, ctx) {
    if (!(await hasModeratorGrant(ctx.actor, 'user.creatorScore.grant')))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Granting Creator Score needs the "user.creatorScore.grant" moderator permission.',
      });
    const allowLarge = input.amount > CREATOR_SCORE_GRANT_LIMITS.maxAmount;
    if (allowLarge && !(await hasModeratorGrant(ctx.actor, 'user.creatorScore.grantLarge')))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: `Grants over ${CREATOR_SCORE_GRANT_LIMITS.maxAmount} need the "user.creatorScore.grantLarge" moderator permission.`,
      });

    const granted = await grantCreatorScore({
      userId: input.userId,
      amount: input.amount,
      reason: input.reason,
      moderatorId: ctx.actor.id,
      allowLarge,
    });
    return { ...granted, affected: { userIds: [input.userId] } };
  },
});
