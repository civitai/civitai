import { ModelType } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { handleDbError } from '~/server/services/errorHandling';
import { protectedProcedure, publicProcedure, router } from '../trpc';

const baseQuerySelect = {
  modelVersions: { select: { url: true, description: true } },
  reviews: { select: { text: true, rating: true, user: true } },
  tagsOnModels: { select: { tag: true } },
  imagesOnModels: { select: { image: true } },
};

export const modelRouter = router({
  getAll: publicProcedure
    .input(
      z
        .object({
          query: z.string().optional(),
          type: z.nativeEnum(ModelType).optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      try {
        return await ctx.prisma.model.findMany({
          where: {
            OR: {
              name: { contains: input?.query },
              type: { equals: input?.type },
            },
          },
          select: baseQuerySelect,
        });
      } catch (error) {
        return handleDbError('INTERNAL_SERVER_ERROR', error);
      }
    }),
  getById: publicProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
    try {
      const { id } = input;
      const model = await ctx.prisma.model.findUnique({ where: { id }, select: baseQuerySelect });

      if (!model) {
        return new TRPCError({
          code: 'NOT_FOUND',
          message: `No model with id ${id}`,
        });
      }

      return model;
    } catch (error) {
      return handleDbError('INTERNAL_SERVER_ERROR', error);
    }
  }),
  add: protectedProcedure
    .input(
      z.object({
        name: z.string(),
        description: z.string(),
        type: z.nativeEnum(ModelType),
        trainedWords: z.array(z.string()),
        modelVersions: z.array(
          z.object({
            name: z.string(),
            description: z.string().optional(),
            url: z.string().url(),
            stepCount: z.number().optional(),
            epochs: z.number().optional(),
            sizeKB: z.number(),
          })
        ),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const { modelVersions, ...data } = input;
        const createdModels = await ctx.prisma.model.create({
          data: {
            ...data,
            modelVersions: {
              create: modelVersions,
            },
            user: {
              connect: { id: ctx.session.user.id },
            },
          },
        });

        return createdModels;
      } catch (error) {
        return handleDbError('INTERNAL_SERVER_ERROR', error);
      }
    }),
  update: protectedProcedure
    .input(
      z.object({
        id: z.number(),
        name: z.string(),
        description: z.string(),
        type: z.nativeEnum(ModelType),
        trainedWords: z.array(z.string()),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const { id, ...data } = input;
        const model = await ctx.prisma.model.update({ where: { id }, data });

        if (!model) {
          return new TRPCError({
            code: 'NOT_FOUND',
            message: `No model with id ${id}`,
          });
        }

        return model;
      } catch (error) {
        return handleDbError('INTERNAL_SERVER_ERROR', error);
      }
    }),
  delete: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      try {
        const { id } = input;
        const model = await ctx.prisma.model.delete({ where: { id } });

        if (!model) {
          return new TRPCError({
            code: 'NOT_FOUND',
            message: `No model with id ${id}`,
          });
        }

        return model;
      } catch (error) {
        return handleDbError('INTERNAL_SERVER_ERROR', error);
      }
    }),
});
