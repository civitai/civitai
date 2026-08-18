import * as z from 'zod';
import { chatAuditEventTypes } from '~/server/common/chat-audit.constants';

export type GetChatAuditInput = z.infer<typeof getChatAuditInput>;
export const getChatAuditInput = z.object({
  /** Scope to one conversation, one actor, or neither for the whole feed. */
  chatId: z.number().int().positive().optional(),
  actorId: z.number().int().positive().optional(),
  type: z.enum(chatAuditEventTypes).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  /** Keyset pagination: the `createdAt` of the last row you were shown. */
  cursor: z.coerce.date().optional(),
});
