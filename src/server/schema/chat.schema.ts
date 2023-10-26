import { z } from 'zod';
import { ChatMemberStatus } from '@prisma/client';

export type ChatGetAllSchema = z.infer<typeof chatGetAllSchema>;
export const chatGetAllSchema = z.object({
  status: z.nativeEnum(ChatMemberStatus),
});

export type ChatGetUnreadMessagesSchema = z.infer<typeof chatGetUnreadMessagesSchema>;
export const chatGetUnreadMessagesSchema = z.object({
  userId: z.number(),
});
