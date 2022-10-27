import { MetricTimeframe } from '@prisma/client';
import { z } from 'zod';
import { modelSchema } from '~/server/common/validation/model';
import { handleDbError } from '~/server/services/errorHandling';
import {
  getAllModelsOrderBy,
  getAllModelsSchema,
  getAllModelsSelect,
  getAllModelsTransform,
  getAllModelsWhere,
} from '~/server/services/models/getAllModels';
import { modelWithDetailsSelect } from '~/server/services/models/getById';
import { protectedProcedure, publicProcedure, router } from '../trpc';

export const modelRouter = router({
  getAll: publicProcedure
    .input(getAllModelsSchema.optional())
    .query(async ({ ctx, input = {} }) => {
      try {
        const session = ctx.session;
        const { cursor, limit = 50 } = input;
        input.showNsfw = session?.user?.showNsfw;

        const items = await ctx.prisma.model.findMany({
          take: limit + 1, // get an extra item at the end which we'll use as next cursor
          cursor: cursor ? { id: cursor } : undefined,
          where: getAllModelsWhere(input),
          orderBy: getAllModelsOrderBy(input),
          select: getAllModelsSelect,
        });

        let nextCursor: typeof cursor | undefined = undefined;
        if (items.length > limit) {
          const nextItem = items.pop();
          nextCursor = nextItem?.id;
        }

        const models = getAllModelsTransform(items);
        return { items: models, nextCursor };
      } catch (error) {
        return handleDbError({ code: 'INTERNAL_SERVER_ERROR', error });
      }
    }),
  getById: publicProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
    try {
      const { id } = input;
      const model = await ctx.prisma.model.findUnique({
        where: { id },
        select: modelWithDetailsSelect,
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
      const { modelVersions, tagsOnModels, ...data } = input;
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
                  image: { create: { name: image.name, url: image.url, userId } },
                })),
              },
            })),
          },
          tagsOnModels: {
            create: tagsOnModels?.map(({ name }) => ({ tag: { create: { name } } })),
          },
        },
      });

      return createdModels;
    } catch (error) {
      return handleDbError({ code: 'INTERNAL_SERVER_ERROR', error });
    }
  }),
  update: protectedProcedure
    .input(modelSchema.extend({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      try {
        const userId = ctx.session.user.id;
        const { id, modelVersions, tagsOnModels, ...data } = input;
        const { tagsToCreate, tagsToUpdate } = tagsOnModels?.reduce(
          (acc, current) => {
            if (!current.id) acc.tagsToCreate.push(current);
            else acc.tagsToUpdate.push(current);

            return acc;
          },
          {
            tagsToCreate: [] as Array<typeof tagsOnModels[number]>,
            tagsToUpdate: [] as Array<typeof tagsOnModels[number]>,
          }
        ) ?? { tagsToCreate: [], tagsToUpdate: [] };

        const model = await ctx.prisma.model.update({
          where: { id },
          data: {
            ...data,
            modelVersions: {
              upsert: modelVersions.map(({ id = -1, images, ...version }) => ({
                where: { id },
                create: {
                  ...version,
                  images: {
                    create: images.map((image, index) => ({
                      index,
                      image: { create: { name: image.name, url: image.url, userId } },
                    })),
                  },
                },
                update: {
                  ...version,
                  images: {
                    deleteMany: {},
                    create: images.map((image, index) => ({
                      index,
                      image: { create: { name: image.name, url: image.url, userId } },
                    })),
                  },
                },
              })),
            },
            tagsOnModels: {
              deleteMany: {},
              connectOrCreate: tagsToUpdate.map((tag) => ({
                where: { modelId_tagId: { modelId: id, tagId: tag.id as number } },
                create: { tagId: tag.id as number },
              })),
              create: tagsToCreate.map((tag) => ({
                tag: { create: { name: tag.name } },
              })),
            },
          },
        });

        if (!model) {
          return handleDbError({
            code: 'NOT_FOUND',
            message: `No model with id ${id}`,
          });
        }

        return model;
      } catch (error) {
        console.error(error);
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
  deleteModelVersion: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      try {
        const { id } = input;
        const modelVersion = await ctx.prisma.modelVersion.delete({ where: { id } });

        if (!modelVersion) {
          return handleDbError({
            code: 'NOT_FOUND',
            message: `No model version with id ${id}`,
          });
        }

        return modelVersion;
      } catch (error) {
        return handleDbError({ code: 'INTERNAL_SERVER_ERROR', error });
      }
    }),
});
