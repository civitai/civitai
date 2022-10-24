import { ModelType } from '@prisma/client';
import { z } from 'zod';
import { modelSchema } from '~/server/common/validation/model';
import { handleDbError } from '~/server/services/errorHandling';
import { getAllModels, getAllModelsSchema } from '~/server/services/models/getAllModels';
import { protectedProcedure, publicProcedure, router } from '../trpc';

const baseQuerySelect = {
  id: true,
  name: true,
  description: true,
  trainedWords: true,
  nsfw: true,
  type: true,
  user: {
    select: {
      id: true,
      name: true,
      email: true,
      image: true,
    },
  },
  modelVersions: {
    select: {
      id: true,
      name: true,
      description: true,
      steps: true,
      epochs: true,
      trainingDataUrl: true,
      url: true,
      sizeKB: true,
      images: {
        select: {
          index: true,
          image: {
            select: {
              id: true,
              name: true,
              url: true,
              nsfw: true,
              prompt: true,
            },
          },
        },
      },
    },
  },
  reviews: { select: { text: true, rating: true, user: true } },
  tagsOnModels: { select: { tag: true } },
};

export const modelRouter = router({
  getAll: publicProcedure.input(getAllModelsSchema).query(async ({ input = {} }) => {
    try {
      return await getAllModels(input);
    } catch (error) {
      return handleDbError({ code: 'INTERNAL_SERVER_ERROR', error });
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
        return handleDbError({
          code: 'NOT_FOUND',
          message: `No model with id ${id}`,
        });
      }

      return model;
    } catch (error) {
      return handleDbError({ code: 'INTERNAL_SERVER_ERROR', error });
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
              images: {
                create: images.map((image, index) => ({
                  index,
                  image: { create: { name: image.name, url: image.url, userId: image.userId } },
                })),
              },
            })),
          },
          tagsOnModels: {
            create: tags?.map((tag) => ({ tag: { create: { name: tag } } })),
          },
        },
      });

      return createdModels;
    } catch (error) {
      return handleDbError({ code: 'INTERNAL_SERVER_ERROR', error });
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
          return handleDbError({
            code: 'NOT_FOUND',
            message: `No model with id ${id}`,
          });
        }

        return model;
      } catch (error) {
        return handleDbError({ code: 'INTERNAL_SERVER_ERROR', error });
      }
    }),
  delete: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      try {
        const { id } = input;
        const model = await ctx.prisma.model.delete({ where: { id } });

        if (!model) {
          return handleDbError({
            code: 'NOT_FOUND',
            message: `No model with id ${id}`,
          });
        }

        return model;
      } catch (error) {
        return handleDbError({ code: 'INTERNAL_SERVER_ERROR', error });
      }
    }),
});
