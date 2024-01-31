import {
  addUsersHandler,
  createChatHandler,
  createMessageHandler,
  getChatsForUserHandler,
  getInfiniteMessagesHandler,
  getUnreadMessagesForUserHandler,
  getUserSettingsHandler,
  isTypingHandler,
  modifyUserHandler,
  setUserSettingsHandler,
  updateMessageHandler,
} from '~/server/controllers/chat.controller';
import {
  addUsersInput,
  createChatInput,
  createMessageInput,
  getInfiniteMessagesInput,
  isTypingInput,
  modifyUserInput,
  updateMessageInput,
  userSettingsChat,
} from '~/server/schema/chat.schema';
import { guardedProcedure, protectedProcedure, router } from '~/server/trpc';

// nb: muted users can perform read actions but no communication actions

export const chatRouter = router({
  getUserSettings: protectedProcedure.query(getUserSettingsHandler),
  setUserSettings: protectedProcedure.input(userSettingsChat).mutation(setUserSettingsHandler),
  getAllByUser: protectedProcedure.query(getChatsForUserHandler),
  createChat: guardedProcedure.input(createChatInput).mutation(createChatHandler),
  addUser: guardedProcedure.input(addUsersInput).mutation(addUsersHandler),
  modifyUser: protectedProcedure.input(modifyUserInput).mutation(modifyUserHandler),
  getInfiniteMessages: protectedProcedure
    .input(getInfiniteMessagesInput)
    .query(getInfiniteMessagesHandler),
  createMessage: guardedProcedure.input(createMessageInput).mutation(createMessageHandler),
  updateMessage: guardedProcedure.input(updateMessageInput).mutation(updateMessageHandler),
  isTyping: guardedProcedure.input(isTypingInput).mutation(isTypingHandler),
  getUnreadCount: protectedProcedure.query(getUnreadMessagesForUserHandler),
});
