import { getStatus, createBuzzOrderHandler } from '~/server/controllers/coinbase.controller';
import { createBuzzChargeSchema } from '~/server/schema/coinbase.schema';
import { protectedProcedure, router } from '~/server/trpc';

export const coinbaseRouter = router({
  getStatus: protectedProcedure.query(getStatus),
  createBuzzOrder: protectedProcedure
    .input(createBuzzChargeSchema)
    .mutation(createBuzzOrderHandler),
});
