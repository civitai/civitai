import { createTransactionHandler } from '~/server/controllers/paddle.controller';
import { router, protectedProcedure } from '~/server/trpc';
import { transactionCreateSchema } from '~/server/schema/paddle.schema';

export const paddleRouter = router({
  createTrasaction: protectedProcedure
    .input(transactionCreateSchema)
    .mutation(createTransactionHandler),
});
