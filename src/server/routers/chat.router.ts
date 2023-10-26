import { isFlagProtected, protectedProcedure, router } from '~/server/trpc';
import { getUserAccountHandler } from '~/server/controllers/buzz.controller';
import { chatGetAllSchema } from '~/server/schema/chat.schema';

export const chatRouter = router({
  getAll: protectedProcedure
    .use(isFlagProtected('chat'))
    .input(chatGetAllSchema)
    .query(getUserAccountHandler),
});
