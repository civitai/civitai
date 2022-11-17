import { PrismaClientKnownRequestError } from '@prisma/client/runtime';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { handleAuthorizationError, handleDbError } from '~/server/utils/errorHandling';
import { protectedProcedure, publicProcedure, router } from '~/server/trpc';
import { prisma } from '~/server/db/client';

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
        return await prisma.user.findMany({
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
      const user = await prisma.user.findUnique({ where: { id } });

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
          tos: z.boolean(),
          image: z.string().nullable(),
        })
        .partial()
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
      const currentUser = ctx.user;
      if (id !== currentUser.id) return handleAuthorizationError();

      try {
        const updatedUser = await prisma.user.update({ where: { id }, data });
        if (!updatedUser) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: `There was a problem processing your request`,
          });
        }

        return updatedUser;
      } catch (error) {
        if (error instanceof PrismaClientKnownRequestError) {
          // TODO Error Handling: Add more robust TRPC<->prisma error handling
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
      const { id } = input;
      const currentUser = ctx.user;
      if (id !== currentUser.id) return handleAuthorizationError();

      try {
        const user = await prisma.user.delete({ where: { id } });

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
