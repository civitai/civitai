import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import { userId } from '~/server/schema/moderator/user';
import { hasModeratorGrant } from '~/server/services/moderator-grants';
import { sendAsCivitaiOnce } from '~/server/services/message-as-civitai.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { MAX_CHAT_MESSAGE_LENGTH } from '~/shared/utils/chat';

export default defineModeratorEndpoint('user.messageAsCivitai', {
  summary: 'Send a chat message to a user as the shared Civitai Moderation account.',
  returns: '{ chatId, messageId, deduped }',
  notes: [
    'Requires the moderator app permission `user.message.asCivitai`. The user sees only "Civitai Moderation"; the acting moderator is recorded.',
    'Send an `idempotencyKey` and reuse it on a retry: a repeat returns the first result with `deduped: true`.',
    'Refused while another moderator holds the claim on the thread, and once the user has the capped number of unanswered messages in 24 h.',
  ],
  rateLimit: { max: 30, windowSeconds: 60 },
  input: z.object({
    userId,
    message: z.string().trim().min(1).max(MAX_CHAT_MESSAGE_LENGTH),
    idempotencyKey: z.string().min(8).max(128).optional(),
    context: z
      .object({ reportId: z.number().int().optional(), appealId: z.number().int().optional() })
      .optional(),
  }),
  async handler(input, ctx) {
    if (!(await hasModeratorGrant(ctx.actor, 'user.message.asCivitai')))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Messaging as Civitai needs the "user.message.asCivitai" moderator permission.',
      });
    const result = await sendAsCivitaiOnce({ ...input, actorId: ctx.actor.id });
    return { ...result, affected: { userId: input.userId, chatId: result.chatId } };
  },
});
