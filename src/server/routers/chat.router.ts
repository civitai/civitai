import {
  addUsersHandler,
  createChatHandler,
  createMessageHandler,
  getChatHandler,
  getChatsForUserHandler,
  getInfiniteMessagesHandler,
  modifyUserHandler,
  updateMessageHandler,
} from '~/server/controllers/chat.controller';
import { getByIdSchema } from '~/server/schema/base.schema';
import {
  addUsersInput,
  createChatInput,
  createMessageInput,
  getInfiniteMessages,
  modifyUserInput,
  updateMessageInput,
} from '~/server/schema/chat.schema';
import { guardedProcedure, router } from '~/server/trpc';

// TODO should we be allowing muted users to see chats?
export const chatRouter = router({
  getById: guardedProcedure.input(getByIdSchema).query(getChatHandler),
  getAllByUser: guardedProcedure.query(getChatsForUserHandler),
  createChat: guardedProcedure.input(createChatInput).mutation(createChatHandler),
  addUser: guardedProcedure.input(addUsersInput).mutation(addUsersHandler),
  modifyUser: guardedProcedure.input(modifyUserInput).mutation(modifyUserHandler),
  getInfiniteMessages: guardedProcedure
    .input(getInfiniteMessages)
    .query(getInfiniteMessagesHandler),
  createMessage: guardedProcedure.input(createMessageInput).mutation(createMessageHandler),
  updateMessage: guardedProcedure.input(updateMessageInput).mutation(updateMessageHandler),
});
