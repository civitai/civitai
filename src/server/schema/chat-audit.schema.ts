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

/**
 * Read a whole conversation as a moderator, ignoring the per-user hiding that
 * `deletedAt` and `clearedAt` apply. That is the point: a report filed after a
 * participant tidied their side has to stay reviewable.
 */
export type GetModeratorChatInput = z.infer<typeof getModeratorChatInput>;
export const getModeratorChatInput = z.object({
  chatId: z.number().int().positive(),
  limit: z.number().int().min(1).max(500).default(200),
});
