import { ModelType } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { modelSchema } from '~/server/common/validation/model';
import { handleDbError } from '~/server/services/errorHandling';
import { getAllModels, getAllModelsSchema } from '~/server/services/models/getAllModels';
import { protectedProcedure, publicProcedure, router } from '../trpc';

const baseQuerySelect = {
  modelVersions: { select: { url: true, description: true } },
  reviews: { select: { text: true, rating: true, user: true } },
  tagsOnModels: { select: { tag: true } },
  imagesOnModels: { select: { image: true } },
};

export const modelRouter = router({
  getAll: publicProcedure.input(getAllModelsSchema).query(async ({ input = {} }) => {
    try {
      return await getAllModels(input);
    } catch (error) {
      return handleDbError('INTERNAL_SERVER_ERROR', error);
    }
  }),
  getById: publicProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
    try {
      const { id } = input;
      const model = await ctx.prisma.model.findUnique({
        where: { id },
        select: baseQuerySelect,
      });

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
  add: protectedProcedure.input(modelSchema).mutation(async ({ ctx, input }) => {
    try {
      const userId = ctx.session.user.id;
      const { id, modelVersions, tags, ...data } = input;
      const createdModels = await ctx.prisma.model.create({
        data: {
          ...data,
          userId,
          modelVersions: {
            create: modelVersions.map(({ images, ...version }) => ({
              ...version,
              imagesOnModels: {
                create: images.map((image, index) => ({
                  index,
                  image,
                })),
              },
            })),
          },
          tagsOnModels: {
            create: tags?.map((tag) => ({ tag })),
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
