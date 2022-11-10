import { Prisma, ReportReason } from '@prisma/client';
import { z } from 'zod';
import { ModelSort } from '~/server/common/enums';
import { modelSchema } from '~/server/common/validation/model';
import { handleAuthorizationError, handleDbError } from '~/server/services/errorHandling';
import {
  getAllModelsSchema,
  getAllModelsSelect,
  getAllModelsTransform,
  getAllModelsWhere,
} from '~/server/validators/models/getAllModels';
import { modelWithDetailsSelect } from '~/server/validators/models/getById';
import { protectedProcedure, publicProcedure, router } from '../trpc';

export const modelRouter = router({
  getAll: publicProcedure.input(getAllModelsSchema).query(async ({ ctx, input = {} }) => {
    try {
      const session = ctx.session;
      const { cursor, limit = 50 } = input;
      input.showNsfw = session?.user?.showNsfw;

      const orderBy: Prisma.Enumerable<Prisma.ModelOrderByWithRelationInput> = [
        { createdAt: 'desc' },
      ];
      switch (input.sort) {
        case ModelSort.HighestRated: {
          orderBy.unshift({
            rank: {
              [`rating${input.period}Rank`]: 'asc',
            },
          });
          break;
        }
        case ModelSort.MostDownloaded: {
          orderBy.unshift({
            rank: {
              [`downloadCount${input.period}Rank`]: 'asc',
            },
          });
          break;
        }
      }

      const items = await ctx.prisma.model.findMany({
        take: limit + 1, // get an extra item at the end which we'll use as next cursor
        cursor: cursor ? { id: cursor } : undefined,
        where: getAllModelsWhere(input),
        orderBy: orderBy,
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
  getVersions: publicProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
    try {
      const { id } = input;
      const modelVersions = await ctx.prisma.modelVersion.findMany({
        where: { modelId: id },
        select: { id: true, name: true },
      });

      return modelVersions;
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
                  image: { create: { ...image, userId } },
                })),
              },
            })),
          },
          tagsOnModels: {
            create: tagsOnModels?.map(({ name }) => ({
              tag: {
                connectOrCreate: {
                  where: { name },
                  create: { name },
                },
              },
            })),
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

        // TODO DRY: this process is repeated in several locations that need this check
        const isModerator = ctx.session.user.isModerator;
        const ownerId = (await ctx.prisma.model.findUnique({ where: { id } }))?.userId ?? 0;
        if (!isModerator) {
          if (ownerId !== userId) return handleAuthorizationError();
        }

        const currentVersions = await ctx.prisma.modelVersion.findMany({
          where: { modelId: id },
        });
        const versionIds = modelVersions.map((version) => version.id).filter(Boolean);
        const versionsToDelete = currentVersions
          .filter((version) => !versionIds.includes(version.id))
          .map(({ id }) => id);

        // TEMPORARY
        // query existing model versions to compare the url to see if it has changed
        const queriedModelVersions = await ctx.prisma.modelVersion.findMany({
          where: { modelId: id },
          select: {
            id: true,
            url: true,
          },
        });

        const model = await ctx.prisma.model.update({
          where: { id },
          data: {
            ...data,
            modelVersions: {
              deleteMany:
                versionsToDelete.length > 0 ? { id: { in: versionsToDelete } } : undefined,
              upsert: modelVersions.map(({ id = -1, images, ...version }) => {
                const imagesWithIndex = images.map((image, index) => ({
                  index,
                  userId: ownerId,
                  ...image,
                }));
                const imagesToUpdate = imagesWithIndex.filter((x) => !!x.id);
                const imagesToCreate = imagesWithIndex.filter((x) => !x.id);

                return {
                  where: { id },
                  create: {
                    ...version,
                    images: {
                      create: imagesWithIndex.map(({ index, ...image }) => ({
                        index,
                        image: { create: image },
                      })),
                    },
                  },
                  update: {
                    ...version,
                    // temporary
                    verified:
                      queriedModelVersions.findIndex((x) => x.id === id && x.url === version.url) >
                      -1,
                    epochs: version.epochs ?? null,
                    steps: version.steps ?? null,
                    images: {
                      deleteMany: {
                        NOT: images.map((image) => ({ imageId: image.id })),
                      },
                      create: imagesToCreate.map(({ index, ...image }) => ({
                        index,
                        image: { create: image },
                      })),
                      update: imagesToUpdate.map(({ index, ...image }) => ({
                        where: {
                          imageId_modelVersionId: {
                            imageId: image.id as number,
                            modelVersionId: id,
                          },
                        },
                        data: {
                          index,
                        },
                      })),
                    },
                  },
                };
              }),
            },
            tagsOnModels: {
              deleteMany: {},
              connectOrCreate: tagsToUpdate.map((tag) => ({
                where: { modelId_tagId: { modelId: id, tagId: tag.id as number } },
                create: { tagId: tag.id as number },
              })),
              create: tagsToCreate.map((tag) => ({
                tag: { create: { name: tag.name.toLowerCase() } },
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
        return handleDbError({ code: 'INTERNAL_SERVER_ERROR', error });
      }
    }),
  delete: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      try {
        const { id } = input;

        // TODO DRY: this process is repeated in several locations that need this check
        const isModerator = ctx.session.user.isModerator;
        if (!isModerator) {
          const userId = ctx.session.user.id;
          const ownerId = (await ctx.prisma.model.findUnique({ where: { id } }))?.userId ?? 0;
          if (ownerId !== userId) return handleAuthorizationError();
        }

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

        // TODO DRY: this process is repeated in several locations that need this check
        const isModerator = ctx.session.user.isModerator;
        if (!isModerator) {
          const userId = ctx.session.user.id;
          const ownerId =
            (
              await ctx.prisma.modelVersion.findUnique({
                where: { id },
                select: { model: { select: { userId: true } } },
              })
            )?.model?.userId ?? 0;
          if (ownerId !== userId) return handleAuthorizationError();
        }

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
  report: protectedProcedure
    .input(z.object({ id: z.number(), reason: z.nativeEnum(ReportReason) }))
    .mutation(async ({ ctx, input: { id, reason } }) => {
      const data: Prisma.ModelUpdateInput =
        reason === ReportReason.NSFW ? { nsfw: true } : { tosViolation: true };

      try {
        await ctx.prisma.$transaction([
          ctx.prisma.model.update({
            where: { id },
            data,
          }),
          ctx.prisma.modelReport.create({
            data: {
              modelId: id,
              reason,
              userId: ctx.session.user.id,
            },
          }),
        ]);
      } catch (error) {
        return handleDbError({
          code: 'INTERNAL_SERVER_ERROR',
          error,
        });
      }
    }),
});
