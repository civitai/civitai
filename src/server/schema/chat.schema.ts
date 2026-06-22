import { ChatMemberStatus, ChatMessageType } from '~/shared/utils/prisma/enums';
import * as z from 'zod';
import { infiniteQuerySchema } from '~/server/schema/base.schema';

export type CreateChatInput = z.infer<typeof createChatInput>;
export const createChatInput = z.object({
  userIds: z.array(z.number()),
});

export type AddUsersInput = z.infer<typeof addUsersInput>;
export const addUsersInput = z.object({
  chatId: z.number(),
  userIds: z.array(z.number()),
});

export type ModifyUserInput = z.infer<typeof modifyUserInput>;
export const modifyUserInput = z.object({
  chatMemberId: z.number(),
  // isOwner: z.boolean().optional(), // probably shouldn't be able to change this for now
  isMuted: z.boolean().optional(),
  status: z.enum(ChatMemberStatus).optional(),
  lastViewedMessageId: z.number().optional(),
});

// Per-chat read tracking for headless/agent (MCP) use. The website only exposes
// blanket markAllAsRead and a low-level modifyUser (which requires the caller to
// already know the latest message id). markChatRead resolves the caller's
// chatMember + latest message id server-side and marks just that one chat read.
export type MarkChatReadInput = z.infer<typeof markChatReadInput>;
export const markChatReadInput = z.object({
  chatId: z.number(),
});

export type CreateMessageInput = z.infer<typeof createMessageInput>;
export const createMessageInput = z.object({
  chatId: z.number(),
  content: z.string().min(1).max(2000),
  contentType: z.enum(ChatMessageType).optional().default('Markdown'),
  referenceMessageId: z.number().optional(),
});

export type UpdateMessageInput = z.infer<typeof updateMessageInput>;
export const updateMessageInput = z.object({
  messageId: z.number(),
  content: z.string().min(1),
});

// maybe increase default limit from 20
export type GetInfiniteMessagesInput = z.infer<typeof getInfiniteMessagesInput>;
export const getInfiniteMessagesInput = infiniteQuerySchema.merge(
  z.object({
    chatId: z.number(),
    sortDirection: z.enum(['asc', 'desc']).optional().default('desc'),
    // this is high for now because of issues with scrolling
    limit: z.coerce.number().min(1).default(1000),
  })
);

export type GetMessageByIdInput = z.infer<typeof getMessageByIdInput>;
export const getMessageByIdInput = z.object({
  messageId: z.number(),
});

export type IsTypingInput = z.infer<typeof isTypingInput>;
export const isTypingInput = z.object({
  chatId: z.number(),
  userId: z.number(),
  isTyping: z.boolean(),
});
export type isTypingOutput = IsTypingInput & { username: string };

export type UserSettingsChat = z.infer<typeof userSettingsChat>;
export const userSettingsChat = z.object({
  muteSounds: z.boolean().optional(),
  acknowledged: z.boolean().optional(),
  replaceBadWords: z.boolean().optional(),
});

/**
 * Default chat settings used when a user has none stored. Shared by the
 * `chat.getUserSettings` resolver AND the `_app` SSR bootstrap seed so the
 * seeded `initialData` is byte-identical to the resolver output (#2471 gotcha)
 * — a drift here would mismatch the primed cache and force the bootstrap
 * refetch the seed exists to cut. Leaf module (zod-only) so both the server
 * resolver and the client-bundled `_app` graph can import it safely.
 */
export const DEFAULT_CHAT_SETTINGS: UserSettingsChat = {
  muteSounds: false,
  replaceBadWords: false,
  acknowledged: false,
};

/** Resolve a user's chat settings, substituting the shared default when absent. */
export function resolveChatSettings(chat: UserSettingsChat | undefined): UserSettingsChat {
  return chat ?? DEFAULT_CHAT_SETTINGS;
}
