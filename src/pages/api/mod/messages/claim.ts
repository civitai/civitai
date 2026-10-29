import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import { userId } from '~/server/schema/moderator/user';
import { hasModeratorGrant } from '~/server/services/moderator-grants';
import { claimThread, getThreadChatIdForUser } from '~/server/services/message-as-civitai.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { throwNotFoundError } from '~/server/utils/errorHandling';

export default defineModeratorEndpoint('messages.claim', {
  summary:
    "Claim a user's Civitai Moderation thread for 30 minutes, so no other moderator answers it.",
  returns: '{ claimed, moderatorId, expiresAt }',
  rateLimit: { max: 60, windowSeconds: 60 },
  input: z.object({ userId }),
  async handler(input, ctx) {
    if (!(await hasModeratorGrant(ctx.actor, 'user.message.asCivitai')))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message:
          'Answering Civitai Moderation threads needs the "user.message.asCivitai" moderator permission.',
      });
    const chatId = await getThreadChatIdForUser(input.userId);
    if (chatId === null) throw throwNotFoundError('This user has no Civitai Moderation thread.');
    const claim = await claimThread({ chatId, moderatorId: ctx.actor.id });
    return { ...claim, affected: { userId: input.userId, chatId } };
  },
});
