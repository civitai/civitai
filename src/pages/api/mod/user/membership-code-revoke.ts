import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import { userId } from '~/server/schema/moderator/user';
import { hasModeratorGrant } from '~/server/services/moderator-grants';
import { revokeSupportMembershipCode } from '~/server/services/support-membership-code.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('user.membership-code-revoke', {
  summary: 'Revoke an unredeemed support membership code minted for this account.',
  returns: '{ code, revokedAt }',
  notes: [
    'Requires the moderator app permission `user.membership.code`.',
    'Only codes minted by the support tool for this account; a redeemed, revoked or expired code is refused (409).',
    'The code is expired now and stamped with the revoking moderator; a ModActivity row is written against the account.',
  ],
  rateLimit: { max: 10, windowSeconds: 60 },
  input: z.object({
    userId,
    code: z
      .string()
      .regex(/^MB-[A-Z0-9]{4}-[A-Z0-9]{4}$/)
      .describe('The membership code, as shown in the panel.'),
  }),
  async handler(input, ctx) {
    if (!(await hasModeratorGrant(ctx.actor, 'user.membership.code')))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Revoking membership codes needs the "user.membership.code" moderator permission.',
      });

    const revoked = await revokeSupportMembershipCode({
      code: input.code,
      forUserId: input.userId,
      moderatorId: ctx.actor.id,
    });
    return { ...revoked, affected: { userIds: [input.userId] } };
  },
});
