import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { getAllReviewsSelect } from '~/server/validators/reviews/getAllReviews';
import { protectedProcedure, publicProcedure, router } from '../trpc';
import { handleDbError } from '~/server/services/errorHandling';
import { ReviewFilter, ReviewSort } from '~/server/common/enums';
import { reviewUpsertSchema } from '~/server/validators/reviews/schemas';

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
          filterBy: z.array(z.nativeEnum(ReviewFilter)).optional(),
          sort: z.nativeEnum(ReviewSort).optional(),
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
  upsert: protectedProcedure.input(reviewUpsertSchema).mutation(async ({ ctx, input }) => {
    // TODO - allow admin to make changes to a review?
    const { user } = ctx.session;
    if (!user) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
      });
    }

    const { images = [], ...reviewInput } = input;
    const imagesWithIndex = images.map((image, index) => ({
      userId: user.id,
      ...image,
      index,
    }));

    const imagesToUpdate = imagesWithIndex.filter((x) => !!x.id);
    const imagesToCreate = imagesWithIndex.filter((x) => !x.id);

    return await ctx.prisma.review.upsert({
      where: { id: input.id ?? -1 },
      create: {
        ...reviewInput,
        userId: user.id,
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
          deleteMany: {
            NOT: imagesToUpdate.map((image) => ({ imageId: image.id })),
          },
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
        modelId: true,
      },
    });
  }),
  delete: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const { id } = input;
      const deleted = await ctx.prisma.review.deleteMany({
        where: { AND: { id, userId: ctx.session.user.id } },
      });

      if (!deleted) {
        return handleDbError({
          code: 'NOT_FOUND',
          message: `No review with id ${id}`,
        });
      }

      return deleted;
    }),
});
