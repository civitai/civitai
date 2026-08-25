import {
  addUsersHandler,
  clearChatHandler,
  createChatHandler,
  createMessageHandler,
  deleteMessageHandler,
  getChatAuditHandler,
  getModeratorChatHandler,
  getChatsForUserHandler,
  updateChatHandler,
  updateMessageHandler,
  getInfiniteMessagesHandler,
  getMessageByIdHandler,
  getUnreadMessagesForUserHandler,
  getUserSettingsHandler,
  isTypingHandler,
  markAllAsReadHandler,
  markChatReadHandler,
  modifyUserHandler,
  setUserSettingsHandler,
} from '~/server/controllers/chat.controller';
import {
  addUsersInput,
  clearChatInput,
  createChatInput,
  createMessageInput,
  deleteMessageInput,
  updateChatInput,
  updateMessageInput,
  getInfiniteMessagesInput,
  getMessageByIdInput,
  isTypingInput,
  markChatReadInput,
  modifyUserInput,
  userSettingsChat,
} from '~/server/schema/chat.schema';
import { getChatAuditInput, getModeratorChatInput } from '~/server/schema/chat-audit.schema';
import { guardedProcedure, moderatorProcedure, protectedProcedure, router } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';

// nb: muted users can perform read actions but no communication actions (except responding to mod chat)

export const chatRouter = router({
  getUserSettings: protectedProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .query(getUserSettingsHandler),
  setUserSettings: protectedProcedure
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(userSettingsChat)
    .mutation(setUserSettingsHandler),
  getAllByUser: protectedProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .query(getChatsForUserHandler),
  createChat: guardedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(createChatInput)
    .mutation(createChatHandler),
  addUser: guardedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(addUsersInput)
    .mutation(addUsersHandler),
  updateChat: guardedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(updateChatInput)
    .mutation(updateChatHandler),
  modifyUser: protectedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(modifyUserInput)
    .mutation(modifyUserHandler),
  clearChat: protectedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(clearChatInput)
    .mutation(clearChatHandler),
  markAllAsRead: protectedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .mutation(markAllAsReadHandler),
  markChatRead: protectedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(markChatReadInput)
    .mutation(markChatReadHandler),
  getInfiniteMessages: protectedProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .input(getInfiniteMessagesInput)
    .query(getInfiniteMessagesHandler),
  getMessageById: protectedProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .input(getMessageByIdInput)
    .query(getMessageByIdHandler),
  createMessage: protectedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(createMessageInput)
    .mutation(createMessageHandler),
  deleteMessage: protectedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(deleteMessageInput)
    .mutation(deleteMessageHandler),
  updateMessage: protectedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(updateMessageInput)
    .mutation(updateMessageHandler),
  isTyping: protectedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(isTypingInput)
    .mutation(isTypingHandler),
  getAudit: moderatorProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .input(getChatAuditInput)
    .query(getChatAuditHandler),
  getModeratorChat: moderatorProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .input(getModeratorChatInput)
    .query(getModeratorChatHandler),
  getUnreadCount: protectedProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .query(getUnreadMessagesForUserHandler),
});
