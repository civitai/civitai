import { router, protectedProcedure, publicProcedure, isFlagProtected } from '~/server/trpc';
import {
  createBuzzOrderHandler,
  getStatus,
  getTransactionStatusHandler,
} from '~/server/controllers/emerchantpay.controller';
import { getByIdStringSchema } from '~/server/schema/base.schema';
import { createBuzzChargeSchema } from '~/server/schema/emerchantpay.schema';
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const emerchantpayRouter = router({
  getStatus: publicProcedure
    .meta({ requiredScope: TokenScope.Full })
    .use(isFlagProtected('emerchantpayPayments'))
    .query(() => getStatus()),

  createBuzzOrder: protectedProcedure
    .meta({ requiredScope: TokenScope.Full })
    .input(createBuzzChargeSchema)
    .use(isFlagProtected('emerchantpayPayments'))
    .mutation(({ input, ctx }) => createBuzzOrderHandler({ input, ctx })),

  getTransactionStatus: protectedProcedure
    .meta({ requiredScope: TokenScope.Full })
    .input(getByIdStringSchema)
    .use(isFlagProtected('emerchantpayPayments'))
    .query(({ input, ctx }) => getTransactionStatusHandler({ input, ctx })),
});
