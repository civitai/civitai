import * as z from 'zod';
import { router, protectedProcedure } from '~/server/trpc';
import {
  createBuzzOrderZkp2pHandler,
  getTransactionStatusByKeyHandler,
} from '../controllers/zkp2p.controller';

const createBuzzChargeZkp2pSchema = z.object({
  buzzAmount: z.number().min(1),
  unitAmount: z.number().min(1),
});

export const zkp2pRouter = router({
  createBuzzOrderOnramp: protectedProcedure
    .input(createBuzzChargeZkp2pSchema)
    .mutation(({ input, ctx }) => createBuzzOrderZkp2pHandler({ ...input, userId: ctx.user.id })),

  getTransactionStatusByKey: protectedProcedure
    .input(z.object({ key: z.string() }))
    .query(({ input, ctx }) =>
      getTransactionStatusByKeyHandler({ userId: ctx.user.id, key: input.key })
    ),
});
