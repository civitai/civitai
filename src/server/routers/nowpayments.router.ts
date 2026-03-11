import {
  getDepositAddressHandler,
  getBuzzConversionRateHandler,
  getDepositHistoryHandler,
  getMinAmountHandler,
  getSupportedCurrenciesHandler,
} from '~/server/controllers/nowpayments.controller';
import {
  depositHistoryInputSchema,
  getDepositAddressInputSchema,
  getBuzzConversionRateInputSchema,
  getMinAmountInputSchema,
} from '~/server/schema/nowpayments.schema';
import { edgeCacheIt } from '~/server/middleware.trpc';
import { CacheTTL } from '~/server/common/constants';
import { protectedProcedure, router } from '~/server/trpc';

export const nowPaymentsRouter = router({
  // NOTE: This is a query with write side effects (creates address on first call).
  // Safe because the service layer uses distributed lock + DB dedup, so retries are idempotent.
  // Consider migrating to .mutation() with corresponding client-side useMutation() call.
  getDepositAddress: protectedProcedure
    .input(getDepositAddressInputSchema)
    .query(getDepositAddressHandler),
  getDepositHistory: protectedProcedure
    .input(depositHistoryInputSchema)
    .query(getDepositHistoryHandler),
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
