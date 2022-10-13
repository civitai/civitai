import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { protectedProcedure, publicProcedure, router } from '../trpc';

export const modelRouter = router({
  hello: publicProcedure
    .input(z.object({ text: z.string().nullish() }).nullish())
    .query(({ input }) => ({
      greeting: `Hello ${input?.text ?? 'world'}`,
    })),
  getAll: publicProcedure
    .input(
      z
        .object({ query: z.string().nullish(), type: z.enum(['Checkpoint', 'TextualInversion']) })
        .nullish()
    )
    .query(async ({ ctx, input }) =>
      ctx.prisma.model.findMany({
        where: {
          OR: {
            name: { contains: input?.query ?? '' },
            type: { equals: input?.type },
          },
        },
      })
    ),
  byId: publicProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    const { id } = input;
    const model = await ctx.prisma.model.findUnique({ where: { id } });

    if (!model) {
      return new TRPCError({
        code: 'NOT_FOUND',
        message: `No model with id ${id}`,
      });
    }

    return model;
  }),
  add: protectedProcedure
    .input(
      z.object({
        name: z.string(),
        description: z.string(),
        type: z.enum(['Checkpoint', 'TextualInversion']),
        trainedWords: z.array(z.string()),
      })
    )
    .mutation(({ ctx, input }) => ctx.prisma.model.create({ data: input })),
  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string(),
        description: z.string(),
        type: z.enum(['Checkpoint', 'TextualInversion']),
        trainedWords: z.array(z.string()),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
      const model = await ctx.prisma.model.update({ where: { id }, data });

      if (!model) {
        return new TRPCError({
          code: 'NOT_FOUND',
          message: `No model with id ${id}`,
        });
      }

      return model;
    }),
  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { id } = input;
      const model = await ctx.prisma.model.delete({ where: { id } });

      if (!model) {
        return new TRPCError({
          code: 'NOT_FOUND',
          message: `No model with id ${id}`,
        });
      }

      return model;
    }),
});
