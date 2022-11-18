import { z } from 'zod';
import { handleDbError } from '~/server/services/errorHandling';
import { publicProcedure, router } from '~/server/trpc/trpc';

export const tagRouter = router({
  getAll: publicProcedure
    .input(
      z
        .object({
          limit: z.number().optional(),
          query: z.string().optional(),
        })
        .optional()
    )
    .query(async ({ input, ctx }) => {
      try {
        return await ctx.prisma.tag.findMany({
          take: input?.limit,
          select: {
            id: true,
            name: true,
          },
          where: {
            name: input?.query
              ? {
                  contains: input.query,
                  mode: 'insensitive',
                }
              : undefined,
          },
        });
      } catch (error) {
        return handleDbError({ code: 'INTERNAL_SERVER_ERROR', error });
      }
    }),
});
