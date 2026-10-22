import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import { userId } from '~/server/schema/moderator/user';
import { isAccountUnderLegalHold } from '~/server/services/legal-hold.service';
import { hasModeratorGrant } from '~/server/services/moderator-grants';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('user.legalHold', {
  method: 'GET',
  summary: 'Whether an account is under a legal hold, which blocks deleting or purging it.',
  returns: '{ userId, held }',
  notes: [
    'Requires the moderator app permission `user.deleteAccount` or `user.purge`, the same as the actions it gates.',
    '`held` is null when the status cannot be read; treat that as held. `/api/mod/user/delete` checks again itself.',
  ],
  rateLimit: { max: 20, windowSeconds: 60 },
  input: z.object({ userId }),
  async handler(input, ctx) {
    if (
      !(await hasModeratorGrant(ctx.actor, 'user.deleteAccount')) &&
      !(await hasModeratorGrant(ctx.actor, 'user.purge'))
    )
      throw new TRPCError({
        code: 'FORBIDDEN',
        message:
          'Reading a legal hold needs the "user.deleteAccount" or "user.purge" moderator permission.',
      });
    return { userId: input.userId, held: await isAccountUnderLegalHold(input.userId) };
  },
});
