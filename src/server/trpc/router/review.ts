import { z } from 'zod';
import { handleDbError } from '~/server/services/errorHandling';
import { TRPCError } from '@trpc/server';
import { getAllReviewsSelect } from '~/server/validators/reviews/getAllReviews';
import { protectedProcedure, publicProcedure, router } from '../trpc';
import { imageSchema } from './../../common/validation/model';

export const reviewRouter = router({
  getAll: publicProcedure
    .input(
      z
        .object({
          limit: z.number().min(1).max(100),
          cursor: z.number(),
          modelId: z.number(),
          modelVersionId: z.number(),
          userId: z.number(),
        })
        .partial()
    )
    .query(async ({ ctx, input = {} }) => {
      const { cursor, limit = 20, modelId, modelVersionId, userId } = input;
      const reviews = await ctx.prisma.review.findMany({
        take: limit + 1, // get an extra item at the end which we'll use as next cursor
        cursor: cursor ? { id: cursor } : undefined,
        where: {
          modelId,
          modelVersionId,
          userId,
        },
        select: getAllReviewsSelect,
      });
      return reviews;
    }),
  upsert: protectedProcedure
    .input(
      z.object({
        id: z.number().optional(),
        modelId: z.number(),
        modelVersionId: z.number(),
        userId: z.number(),
        rating: z.number(),
        text: z.string(),
        nsfw: z.boolean(),
        images: z.array(imageSchema),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // TODO - allow admin to make changes to a review?
      const { user } = ctx.session;
      if (!user || input.userId !== user.id) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
        });
      }

      const { images, ...reviewInput } = input;
      const imagesWithIndex = images.map((image, index) => ({
        userId: input.userId,
        ...image,
        index,
      }));

      const imagesToUpdate = imagesWithIndex.filter((x) => !!x.id);
      const imagesToCreate = imagesWithIndex.filter((x) => !x.id);

      const review = await ctx.prisma.review.upsert({
        where: { id: input.id },
        create: {
          ...reviewInput,
          imagesOnReviews: {
            create: imagesWithIndex.map(({ index, ...image }) => ({
              index,
              image: { create: image },
            })),
          },
        },
        update: {
          ...reviewInput,
          imagesOnReviews: {
            deleteMany: {},
            create: imagesToCreate.map(({ index, ...image }) => ({
              index,
              image: { create: image },
            })),
            update: imagesToUpdate.map(({ index, ...image }) => ({
              where: {
                imageId_reviewId: {
                  imageId: image.id as number,
                  reviewId: input.id as number,
                },
              },
              data: { index },
            })),
          },
        },
        select: {
          id: true,
        },
      });
    }),
});
