import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import { hasModeratorGrant } from '~/server/services/moderator-grants';
import { getInbox } from '~/server/services/message-as-civitai.service';
import { defineModeratorEndpoint, moderatorBoolean } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('messages.inbox', {
  method: 'GET',
  summary: 'Threads with the Civitai Moderation account, oldest awaiting a reply first.',
  returns:
    '{ threads: [{ chatId, userId, username, lastMessage, lastMessageAt, lastMessageFromCivitai, claimedBy, claimExpiresAt }] }',
  notes: ['`awaitingOnly=false` lists every thread, newest first.'],
  rateLimit: { max: 60, windowSeconds: 60 },
  input: z.object({
    awaitingOnly: moderatorBoolean.optional().default(true),
    limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  }),
  async handler(input, ctx) {
    if (!(await hasModeratorGrant(ctx.actor, 'user.message.asCivitai')))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message:
          'Reading Civitai Moderation threads needs the "user.message.asCivitai" moderator permission.',
      });
    return { threads: await getInbox(input) };
  },
});
