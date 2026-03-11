import {
  bustDepositCacheHandler,
  createDepositAddressHandler,
  getBuzzConversionRateHandler,
  getDepositHistoryHandler,
  getMinAmountHandler,
  getSupportedCurrenciesHandler,
} from '~/server/controllers/nowpayments.controller';
import {
  depositHistoryInputSchema,
  getBuzzConversionRateInputSchema,
  getMinAmountInputSchema,
} from '~/server/schema/nowpayments.schema';
import { edgeCacheIt } from '~/server/middleware.trpc';
import { CacheTTL } from '~/server/common/constants';
import { moderatorProcedure, protectedProcedure, router } from '~/server/trpc';

export const nowPaymentsRouter = router({
  createDepositAddress: protectedProcedure.mutation(createDepositAddressHandler),
  getDepositHistory: protectedProcedure
    .input(depositHistoryInputSchema)
    .query(getDepositHistoryHandler),
  bustDepositCache: moderatorProcedure.mutation(bustDepositCacheHandler),
  getSupportedCurrencies: protectedProcedure
    .use(edgeCacheIt({ ttl: CacheTTL.hour }))
    .query(getSupportedCurrenciesHandler),
  getMinAmount: protectedProcedure
    .input(getMinAmountInputSchema)
    .use(edgeCacheIt({ ttl: CacheTTL.hour }))
    .query(getMinAmountHandler),
  getBuzzConversionRate: protectedProcedure
    .input(getBuzzConversionRateInputSchema)
    .use(edgeCacheIt({ ttl: CacheTTL.hour }))
    .query(getBuzzConversionRateHandler),
});
