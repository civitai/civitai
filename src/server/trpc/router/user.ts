import { PrismaClientKnownRequestError } from '@prisma/client/runtime';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { handleDbError } from '~/server/services/errorHandling';
import { protectedProcedure, publicProcedure, router } from '~/server/trpc/trpc';

export const userRouter = router({
  getAll: publicProcedure
    .input(
      z.object({
        limit: z.number().optional(),
        query: z.string().optional(),
        email: z.string().optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      try {
        return await ctx.prisma.user.findMany({
          take: input.limit,
          select: {
            username: true,
            id: true,
          },
          where: {
            username: input.query
              ? {
                  contains: input.query,
                  mode: 'insensitive',
                }
              : undefined,
            email: input.email,
          },
        });
      } catch (error) {
        return handleDbError({ code: 'INTERNAL_SERVER_ERROR', error });
      }
    }),
  getById: publicProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
    try {
      const { id } = input;
      const user = await ctx.prisma.user.findUnique({ where: { id } });

      if (!user) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `No user with id ${id}`,
        });
      }

      return user;
    } catch (error) {
      return handleDbError({ code: 'INTERNAL_SERVER_ERROR', error });
    }
  }),
  update: protectedProcedure
    .input(
      z
        .object({
          id: z.number(),
          username: z.string(),
          showNsfw: z.boolean(),
          blurNsfw: z.boolean(),
        })
        .partial()
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
      try {
        const updatedUser = await ctx.prisma.user.update({ where: { id }, data });
        if (!updatedUser) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: `There was a problem processing your request`,
          });
        }

        return updatedUser;
      } catch (error) {
        if (error instanceof PrismaClientKnownRequestError) {
          // TODO - more robust error handling
          // console.log('___ERROR___');
          // console.log(error.code);
          // console.log(error.meta?.target); // target is the field(s) that had a problem
          if (error.code === 'P2002')
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'This username is not available.',
            });
        }
        return handleDbError({ code: 'INTERNAL_SERVER_ERROR', error });
      }
    }),
  delete: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      try {
        const { id } = input;
        const user = await ctx.prisma.user.delete({ where: { id } });

        if (!user) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: `No user with id ${id}`,
          });
        }

        return user;
      } catch (error) {
        return handleDbError({ code: 'INTERNAL_SERVER_ERROR', error });
      }
    }),
});
