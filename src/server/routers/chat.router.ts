import {
  createChatHandler,
  createMessageHandler,
  getChatsForUserHandler,
  getInfiniteMessagesHandler,
  getMessageByIdHandler,
  getUnreadMessagesForUserHandler,
  getUserSettingsHandler,
  isTypingHandler,
  markAllAsReadHandler,
  modifyUserHandler,
  setUserSettingsHandler,
} from '~/server/controllers/chat.controller';
import {
  createChatInput,
  createMessageInput,
  getInfiniteMessagesInput,
  getMessageByIdInput,
  isTypingInput,
  modifyUserInput,
  userSettingsChat,
} from '~/server/schema/chat.schema';
import { guardedProcedure, protectedProcedure, router } from '~/server/trpc';

// nb: muted users can perform read actions but no communication actions (except responding to mod chat)

export const chatRouter = router({
  getUserSettings: protectedProcedure.query(getUserSettingsHandler),
  setUserSettings: protectedProcedure.input(userSettingsChat).mutation(setUserSettingsHandler),
  getAllByUser: protectedProcedure.query(getChatsForUserHandler),
  createChat: guardedProcedure.input(createChatInput).mutation(createChatHandler),
  // addUser: guardedProcedure.input(addUsersInput).mutation(addUsersHandler),
  modifyUser: protectedProcedure.input(modifyUserInput).mutation(modifyUserHandler),
  markAllAsRead: protectedProcedure.mutation(markAllAsReadHandler),
  getInfiniteMessages: protectedProcedure
    .input(getInfiniteMessagesInput)
    .query(getInfiniteMessagesHandler),
  getMessageById: protectedProcedure.input(getMessageByIdInput).query(getMessageByIdHandler),
  createMessage: protectedProcedure.input(createMessageInput).mutation(createMessageHandler),
  // updateMessage: guardedProcedure.input(updateMessageInput).mutation(updateMessageHandler),
  isTyping: protectedProcedure.input(isTypingInput).mutation(isTypingHandler),
  getUnreadCount: protectedProcedure.query(getUnreadMessagesForUserHandler),
});
