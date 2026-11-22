import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import { dbWrite } from '~/server/db/client';
import { userId } from '~/server/schema/moderator/user';
import { hasModeratorGrant } from '~/server/services/moderator-grants';
import { countUserReactions } from '~/server/services/user-reaction-erasure.service';
import { throwNotFoundError } from '~/server/utils/errorHandling';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('user.reactions', {
  method: 'GET',
  summary: "Count an account's reactions in every reaction table, before removing them.",
  returns: '{ userId, counts: { ImageReaction, ArticleReaction, ... } }',
  notes: [
    'Requires the moderator app permission `user.removeReactions`, the same as the removal it previews.',
  ],
  rateLimit: { max: 30, windowSeconds: 60 },
  input: z.object({ userId }),
  async handler(input, ctx) {
    if (!(await hasModeratorGrant(ctx.actor, 'user.removeReactions')))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Counting reactions needs the "user.removeReactions" moderator permission.',
      });
    const target = await dbWrite.user.findFirst({
      where: { id: input.userId },
      select: { id: true },
    });
    if (!target) throw throwNotFoundError(`No user with id ${input.userId}`);

    return { userId: input.userId, counts: await countUserReactions(input.userId) };
  },
});
