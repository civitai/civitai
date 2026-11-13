import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import { hasModeratorGrant } from '~/server/services/moderator-grants';
import { userId } from '~/server/schema/moderator/user';
import { getThread } from '~/server/services/message-as-civitai.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('messages.thread', {
  method: 'GET',
  summary:
    "A user's thread with the Civitai Moderation account, with the moderator behind each message.",
  returns:
    '{ chatId, claim, messages: [{ id, fromCivitai, content, createdAt, sentById, sentByUsername }] }',
  rateLimit: { max: 60, windowSeconds: 60 },
  input: z.object({ userId }),
  async handler(input, ctx) {
    if (!(await hasModeratorGrant(ctx.actor, 'user.message.asCivitai')))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message:
          'Reading Civitai Moderation threads needs the "user.message.asCivitai" moderator permission.',
      });
    return getThread(input);
  },
});
