import { z } from 'zod';
import { publicProcedure, router } from '~/server/trpc/trpc';

export const userRouter = router({
  getAll: publicProcedure
    .input(
      z.object({
        email: z.string(),
      })
    )
    .query(({ input, ctx }) =>
      ctx.prisma.user.findMany({
        select: {
          name: true,
          id: true,
          email: true,
        },
        where: { email: input.email },
      })
    ),
});
