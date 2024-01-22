import { ChatMemberStatus, ChatMessageType } from '@prisma/client';
import { z } from 'zod';
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
  status: z.nativeEnum(ChatMemberStatus).optional(),
  lastViewedMessageId: z.number().optional(),
});

export type CreateMessageInput = z.infer<typeof createMessageInput>;
export const createMessageInput = z.object({
  chatId: z.number(),
  content: z.string().min(1),
  contentType: z.nativeEnum(ChatMessageType).optional().default('Markdown'),
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
    direction: z.enum(['asc', 'desc']).optional().default('asc'),
  })
);

export type IsTypingInput = z.infer<typeof isTypingInput>;
export const isTypingInput = z.object({
  chatId: z.number(),
  userId: z.number(),
  isTyping: z.boolean(),
});
export type isTypingOutput = IsTypingInput & { username: string };

export type GetUnreadInput = z.infer<typeof getUnreadInput>;
export const getUnreadInput = z.object({
  grouped: z.boolean().optional().default(false),
});
