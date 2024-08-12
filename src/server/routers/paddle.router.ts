import {
  createTransactionHandler,
  processCompleteBuzzTransactionHandler,
} from '~/server/controllers/paddle.controller';
import { router, protectedProcedure } from '~/server/trpc';
import { transactionCreateSchema } from '~/server/schema/paddle.schema';
import { getByIdStringSchema } from '~/server/schema/base.schema';

export const paddleRouter = router({
  createTrasaction: protectedProcedure
    .input(transactionCreateSchema)
    .mutation(createTransactionHandler),

  processCompleteBuzzTransaction: protectedProcedure
    .input(getByIdStringSchema)
    .mutation(processCompleteBuzzTransactionHandler),
});
