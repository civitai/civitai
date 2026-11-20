import {
  addApiKeyHandler,
  deleteApiKeyHandler,
  getApiKeyHandler,
  getApiKeySpendHandler,
  getUserApiKeysHandler,
  setBuzzLimitHandler,
} from '~/server/controllers/api-key.controller';
import {
  addApiKeyInputSchema,
  getApiKeyInputSchema,
  deleteApiKeyInputSchema,
  getUserApiKeysInputSchema,
  setBuzzLimitInputSchema,
} from '~/server/schema/api-key.schema';
import { assertNotImpersonating } from '~/server/auth/refuse-while-impersonating';
import { protectedProcedure, router, verifiedProcedure } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const apiKeyRouter = router({
  verifyKey: protectedProcedure
    .meta({ requiredScope: TokenScope.Full })
    .input(getApiKeyInputSchema)
    .query(getApiKeyHandler),
  getAllUserKeys: protectedProcedure
    .meta({ requiredScope: TokenScope.Full })
    .input(getUserApiKeysInputSchema)
    .query(getUserApiKeysHandler),
  getSpend: protectedProcedure
    .meta({ requiredScope: TokenScope.Full })
    .query(getApiKeySpendHandler),
  add: verifiedProcedure
    .meta({ requiredScope: TokenScope.Full, requireFullUserCredential: true })
    .input(addApiKeyInputSchema)
    .mutation((opts) => {
      assertNotImpersonating(opts.ctx, "API keys can't be created while impersonating");
      return addApiKeyHandler(opts);
    }),
  setBuzzLimit: protectedProcedure
    .meta({ requiredScope: TokenScope.Full, requireFullUserCredential: true })
    .input(setBuzzLimitInputSchema)
    .mutation(setBuzzLimitHandler),
  delete: protectedProcedure
    .meta({ requiredScope: TokenScope.Full, requireFullUserCredential: true })
    .input(deleteApiKeyInputSchema)
    .mutation(deleteApiKeyHandler),
});
