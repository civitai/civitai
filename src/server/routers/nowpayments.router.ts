import {
  getDepositAddressHandler,
  getBuzzConversionRateHandler,
  getDepositHistoryHandler,
  getMinAmountHandler,
  getSupportedCurrenciesHandler,
  reconcileUserDepositsHandler,
} from '~/server/controllers/nowpayments.controller';
import {
  depositHistoryInputSchema,
  getDepositAddressInputSchema,
  getBuzzConversionRateInputSchema,
  getMinAmountInputSchema,
} from '~/server/schema/nowpayments.schema';
import { edgeCacheIt, rateLimit } from '~/server/middleware.trpc';
import { CacheTTL } from '~/server/common/constants';
import { moderatorProcedure, protectedProcedure, router } from '~/server/trpc';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import * as z from 'zod';
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const nowPaymentsRouter = router({
  // NOTE: This is a query with write side effects (creates address on first call).
  // Safe because the service layer uses distributed lock + DB dedup, so retries are idempotent.
  // Consider migrating to .mutation() with corresponding client-side useMutation() call.
  getDepositAddress: protectedProcedure
    .meta({ requiredScope: TokenScope.Full })
    .input(getDepositAddressInputSchema)
    .use(rateLimit({ limit: 60, period: CacheTTL.hour }))
    .query(getDepositAddressHandler),
  getDepositHistory: protectedProcedure
    .meta({ requiredScope: TokenScope.Full })
    .input(depositHistoryInputSchema)
    .query(getDepositHistoryHandler),
  getSupportedCurrencies: protectedProcedure
    .meta({ requiredScope: TokenScope.Full })
    .use(edgeCacheIt({ ttl: CacheTTL.hour }))
    .query(getSupportedCurrenciesHandler),
  getMinAmount: protectedProcedure
    .meta({ requiredScope: TokenScope.Full })
    .input(getMinAmountInputSchema)
    .use(edgeCacheIt({ ttl: CacheTTL.hour }))
    .query(getMinAmountHandler),
  getBuzzConversionRate: protectedProcedure
    .meta({ requiredScope: TokenScope.Full })
    .input(getBuzzConversionRateInputSchema)
    .use(edgeCacheIt({ ttl: CacheTTL.hour }))
    .query(getBuzzConversionRateHandler),
  reconcileMyDeposits: protectedProcedure
    .meta({ requiredScope: TokenScope.Full })
    .use(rateLimit({ limit: 1, period: 60 }))
    .mutation(reconcileUserDepositsHandler),
  reconcileUserDeposits: moderatorProcedure
    .input(z.object({ userId: z.number() }))
    .mutation(({ input }) =>
      import('~/server/services/nowpayments.service').then((m) =>
        m.reconcileUserDeposits(input.userId)
      )
    ),
  flushCurrencyCache: moderatorProcedure.mutation(async () => {
    await redis.del(REDIS_KEYS.CACHES.SUPPORTED_CRYPTO_CURRENCIES);
    return { flushed: true };
  }),
});
