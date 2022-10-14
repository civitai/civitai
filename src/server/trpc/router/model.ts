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
          limit: z.number().min(1).max(100),
          cursor: z.number(),
          query: z.string().optional(),
          tags: z.number().array().optional(),
          users: z.number().array().optional(),
          type: z.nativeEnum(ModelType).optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input = {} }) => {
      try {
        const limit = input.limit ?? 50;
        const { cursor } = input;
        const items = await ctx.prisma.model.findMany({
          take: limit + 1, // get an extra item at the end which we'll use as next cursor
          cursor: cursor ? { id: cursor } : undefined,
          where: {
            OR: {
              name: {
                contains: input.query,
                mode: 'insensitive',
              },
              tagsOnModels: {
                some: {
                  tagId: {
                    in: input.tags,
                  },
                },
              },
              userId: {
                in: input.users,
              },
              type: {
                equals: input?.type,
              },
            },
            AND: {},
          },
          select: {
            id: true,
            name: true,
            type: true,
            imagesOnModels: {
              take: 1,
              select: {
                image: {
                  select: {
                    width: true,
                    url: true,
                    height: true,
                    prompt: true,
                    hash: true,
                  },
                },
              },
            },
            metrics: {
              select: {
                rating: true,
                ratingCount: true,
                downloadCount: true,
              },
            },
          },
        });

        const models = items.map(({ metrics, imagesOnModels, ...item }) => ({
          ...item,
          image: imagesOnModels[0]?.image,
          metrics: {
            rating: metrics.reduce((a, b) => a + b.rating, 0) / metrics.length,
            ...metrics.reduce(
              (a, b) => ({
                ratingCount: a.ratingCount + b.ratingCount,
                downloadCount: a.downloadCount + b.downloadCount,
              }),
              { ratingCount: 0, downloadCount: 0 }
            ),
          },
        }));

        let nextCursor: typeof cursor | undefined = undefined;
        if (items.length > limit) {
          const nextItem = items.pop();
          nextCursor = nextItem?.id;
        }
        return { items: models, nextCursor };
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
        const userId = ctx.session.user.id;
        const { modelVersions, ...data } = input;
        const createdModels = await ctx.prisma.model.create({
          data: {
            ...data,
            userId,
            modelVersions: {
              create: modelVersions,
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
