import { z } from 'zod';
import { getAllReviewsSelect } from '~/server/validators/reviews/getAllReviews';
import { protectedProcedure, publicProcedure, router } from '../trpc';
import { handleAuthorizationError, handleDbError } from '~/server/services/errorHandling';
import { ReviewFilter, ReviewSort } from '~/server/common/enums';
import { reviewUpsertSchema } from '~/server/validators/reviews/schemas';
import { Prisma, ReportReason } from '@prisma/client';

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
          filterBy: z.array(z.nativeEnum(ReviewFilter)),
          sort: z.nativeEnum(ReviewSort),
        })
        .partial()
    )
    .query(async ({ ctx, input = {} }) => {
      const { cursor, limit = 20, modelId, modelVersionId, userId } = input;
      const commonWhere = { modelId, modelVersionId, userId };
      const [reviews, totalCount] = await Promise.all([
        ctx.prisma.review.findMany({
          take: limit + 1, // get an extra item at the end which we'll use as next cursor
          cursor: cursor ? { id: cursor } : undefined,
          where: {
            ...commonWhere,
            nsfw: ctx.session?.user?.showNsfw ? undefined : false,
          },
          select: getAllReviewsSelect,
        }),
        ctx.prisma.review.count({ where: commonWhere }),
      ]);

      let nextCursor: typeof cursor | undefined = undefined;
      if (reviews.length > limit) {
        const nextItem = reviews.pop();
        nextCursor = nextItem?.id;
      }

      return { reviews, nextCursor, totalCount };
    }),
  upsert: protectedProcedure.input(reviewUpsertSchema).mutation(async ({ ctx, input }) => {
    const { user } = ctx.session;
    const { images = [], id, ...reviewInput } = input;

    // TODO DRY: this process is repeated in several locations that need this check
    const isModerator = user.isModerator;
    if (!isModerator && id !== undefined) {
      const ownerId = (await ctx.prisma.review.findUnique({ where: { id } }))?.userId ?? 0;
      if (ownerId !== user.id) return handleAuthorizationError();
    }

    const imagesWithIndex = images.map((image, index) => ({
      userId: user.id,
      ...image,
      index,
    }));

    const imagesToUpdate = imagesWithIndex.filter((x) => !!x.id);
    const imagesToCreate = imagesWithIndex.filter((x) => !x.id);

    return await ctx.prisma.review.upsert({
      where: { id: id ?? -1 },
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

      // TODO DRY: this process is repeated in several locations that need this check
      const { user } = ctx.session;
      const isModerator = user.isModerator;
      if (!isModerator) {
        const ownerId = (await ctx.prisma.review.findUnique({ where: { id } }))?.userId ?? 0;
        if (ownerId !== user.id) return handleAuthorizationError();
      }

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
  report: protectedProcedure
    .input(z.object({ id: z.number(), reason: z.nativeEnum(ReportReason) }))
    .mutation(async ({ ctx, input: { id, reason } }) => {
      const data: Prisma.ReviewUpdateInput =
        reason === ReportReason.NSFW ? { nsfw: true } : { tosViolation: true };

      try {
        await ctx.prisma.$transaction([
          ctx.prisma.review.update({
            where: { id },
            data,
          }),
          ctx.prisma.reviewReport.create({
            data: {
              reviewId: id,
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
