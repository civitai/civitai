import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { handleDbError } from '~/server/utils/errorHandling';
import { protectedProcedure, router } from '~/server/trpc';
import { prisma } from '~/server/db/client';

export const accountRouter = router({
  getAll: protectedProcedure.input(z.object({}).optional()).query(async ({ ctx }) => {
    const user = ctx.user;
    if (!user) throw new TRPCError({ code: 'UNAUTHORIZED' });

    try {
      return await prisma.account.findMany({
        where: { userId: user.id },
        select: {
          id: true,
          provider: true,
        },
      });
    } catch (error) {
      return handleDbError({ code: 'INTERNAL_SERVER_ERROR', error });
    }
  }),
  delete: protectedProcedure
    .input(z.object({ accountId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const user = ctx.user;
      if (!user) throw new TRPCError({ code: 'UNAUTHORIZED' });

      try {
        await prisma.account.deleteMany({
          where: {
            userId: user.id,
            id: input.accountId,
          },
        });
      } catch (error) {
        return handleDbError({ code: 'INTERNAL_SERVER_ERROR', error });
      }
    }),
});
