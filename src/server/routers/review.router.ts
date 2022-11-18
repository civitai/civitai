import { z } from 'zod';

import { middleware, protectedProcedure, publicProcedure, router } from '~/server/trpc';
import { handleAuthorizationError, handleDbError } from '~/server/utils/errorHandling';
import { ReviewFilter, ReviewSort } from '~/server/common/enums';
import { reviewUpsertSchema } from '~/server/schema/review.schema';
import { Prisma, ReportReason, ReviewReactions } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { prisma } from '~/server/db/client';
import { getAllReviewsSelect, getReactionsSelect } from '~/server/selectors/review.selector';

const isOwnerOrModerator = middleware(async ({ ctx, next, input }) => {
  if (!ctx?.user) throw new TRPCError({ code: 'UNAUTHORIZED' });

  const { id } = input as { id: number };
  const userId = ctx.user.id;
  let ownerId: number = userId;
  if (id) {
    const isModerator = ctx?.user?.isModerator;
    ownerId = (await prisma.review.findUnique({ where: { id } }))?.userId ?? 0;
    if (!isModerator && ownerId) {
      if (ownerId !== userId) throw handleAuthorizationError();
    }
  }

  return next({
    ctx: {
      // infers the `session` as non-nullable
      ...ctx,
      user: ctx.user,
      ownerId,
    },
  });
});

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
          sort: z.nativeEnum(ReviewSort).default(ReviewSort.Newest),
        })
        .partial()
    )
    .query(async ({ ctx, input = {} }) => {
      const { cursor, limit = 20, modelId, modelVersionId, userId, sort, filterBy = [] } = input;
      const commonWhere = { modelId, modelVersionId, userId };
      const showNsfw = ctx?.user?.showNsfw ?? true;
      let orderBy: Prisma.ReviewFindManyArgs['orderBy'] = { createdAt: 'desc' };

      switch (sort) {
        // TODO: implement more order cases once reactions are live
        case ReviewSort.Oldest:
          orderBy = { createdAt: 'asc' };
          break;
        default:
          orderBy = { createdAt: 'desc' };
          break;
      }

      const reviews = await prisma.review.findMany({
        take: limit + 1, // get an extra item at the end which we'll use as next cursor
        cursor: cursor ? { id: cursor } : undefined,
        where: {
          ...commonWhere,
          nsfw: showNsfw ? (filterBy.includes(ReviewFilter.NSFW) ? true : undefined) : false,
          imagesOnReviews: filterBy.includes(ReviewFilter.IncludesImages)
            ? { some: {} }
            : undefined,
        },
        select: getAllReviewsSelect,
        orderBy,
      });

      let nextCursor: typeof cursor | undefined = undefined;
      if (reviews.length > limit) {
        const nextItem = reviews.pop();
        nextCursor = nextItem?.id;
      }

      return {
        reviews: reviews.map(({ imagesOnReviews, ...review }) => ({
          ...review,
          images: imagesOnReviews.map(({ image }) => image),
        })),
        nextCursor,
      };
    }),
  getReactions: publicProcedure
    .input(z.object({ reviewId: z.number() }))
    .query(async ({ ctx, input }) => {
      const { reviewId } = input;
      const reactions = await prisma.reviewReaction.findMany({
        where: { reviewId },
        select: getReactionsSelect,
      });

      return reactions;
    }),
  upsert: protectedProcedure
    .input(reviewUpsertSchema)
    .use(isOwnerOrModerator)
    .mutation(async ({ ctx, input }) => {
      const { images = [], id, ...reviewInput } = input;
      const { ownerId } = ctx;

      const imagesWithIndex = images.map((image, index) => ({
        userId: ownerId,
        ...image,
        meta: (image.meta as Prisma.JsonObject) ?? Prisma.JsonNull,
        index,
      }));

      const imagesToUpdate = imagesWithIndex.filter((x) => !!x.id);
      const imagesToCreate = imagesWithIndex.filter((x) => !x.id);

      return await prisma.$transaction(async (tx) => {
        await Promise.all(
          // extract index because index is not a part of the prisma schema for this model
          imagesToUpdate.map(async ({ index, ...image }) =>
            tx.image.updateMany({
              where: { id: image.id },
              data: {
                ...image,
                meta: (image.meta as Prisma.JsonObject) ?? Prisma.JsonNull,
              },
            })
          )
        );

        return await prisma.review.upsert({
          where: { id: id ?? -1 },
          create: {
            ...reviewInput,
            userId: ownerId,
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
      });
    }),
  delete: protectedProcedure
    .input(z.object({ id: z.number() }))
    .use(isOwnerOrModerator)
    .mutation(async ({ ctx, input }) => {
      const { id } = input;

      const deleted = await prisma.review.deleteMany({
        where: { AND: { id, userId: ctx.user.id } },
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
        await prisma.$transaction([
          prisma.review.update({
            where: { id },
            data,
          }),
          prisma.reviewReport.create({
            data: {
              reviewId: id,
              reason,
              userId: ctx.user.id,
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
  toggleReaction: protectedProcedure
    .input(z.object({ id: z.number(), reaction: z.nativeEnum(ReviewReactions) }))
    .mutation(async ({ ctx, input }) => {
      const { user } = ctx;
      const { id, reaction } = input;

      const reviewReaction = await prisma.reviewReaction.findFirst({
        where: { reaction, userId: user.id, reviewId: id },
      });

      try {
        const review = await prisma.review.update({
          where: { id },
          data: {
            reactions: {
              create: reviewReaction ? undefined : { reaction, userId: user.id },
              deleteMany: reviewReaction ? { reaction, userId: user.id } : undefined,
            },
          },
          select: getAllReviewsSelect,
        });

        if (!review) {
          handleDbError({ code: 'NOT_FOUND', message: `No review with id ${id}` });
          return;
        }

        return review;
      } catch (error) {
        handleDbError({ code: 'INTERNAL_SERVER_ERROR', error });
      }
    }),
});
