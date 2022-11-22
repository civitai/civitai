import {
  addApiKeyHandler,
  deleteApiKeyHandler,
  getApiKeyHandler,
  getUserApiKeysHandler,
} from '~/server/controllers/api-key.controller';
import {
  addApiKeyInputSchema,
  getApiKeyInputSchema,
  deleteApiKeyInputSchema,
  getUserApiKeysInputSchema,
} from '~/server/schema/api-key.schema';
import { protectedProcedure, publicProcedure, router } from '~/server/trpc';

export const apiKeyRouter = router({
  verifyKey: publicProcedure.input(getApiKeyInputSchema).query(getApiKeyHandler),
  getAllUserKeys: protectedProcedure.input(getUserApiKeysInputSchema).query(getUserApiKeysHandler),
  add: protectedProcedure.input(addApiKeyInputSchema).mutation(addApiKeyHandler),
  delete: protectedProcedure.input(deleteApiKeyInputSchema).mutation(deleteApiKeyHandler),
});
