import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import { userId } from '~/server/schema/moderator/user';
import { hasModeratorGrant } from '~/server/services/moderator-grants';
import {
  CREATOR_SCORE_GRANT_LIMITS,
  revokeCreatorScoreGrant,
} from '~/server/services/creator-score-grant.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('user.creator-score-grant-revoke', {
  summary: 'Revoke a Creator Score grant on this account and recompute its score.',
  returns: '{ id, revokedAt, total }',
  notes: [
    'Requires the moderator app permission `user.creatorScore.grant`.',
    'The grant is stamped with the revoking moderator and reason, not deleted; a revoked grant is refused (409).',
    'A tier milestone the grant already earned stays earned.',
  ],
  rateLimit: { max: 10, windowSeconds: 60 },
  input: z.object({
    userId,
    grantId: z.coerce.number().int().positive(),
    reason: z.string().trim().min(1).max(CREATOR_SCORE_GRANT_LIMITS.maxReasonLength),
  }),
  async handler(input, ctx) {
    if (!(await hasModeratorGrant(ctx.actor, 'user.creatorScore.grant')))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Revoking Creator Score needs the "user.creatorScore.grant" moderator permission.',
      });

    const revoked = await revokeCreatorScoreGrant({
      grantId: input.grantId,
      userId: input.userId,
      reason: input.reason,
      moderatorId: ctx.actor.id,
    });
    return { ...revoked, affected: { userIds: [input.userId] } };
  },
});
