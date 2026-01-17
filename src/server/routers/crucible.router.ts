import { router, publicProcedure, guardedProcedure, isFlagProtected } from '~/server/trpc';
import {
  getCruciblesInfiniteSchema,
  getCrucibleByIdSchema,
  createCrucibleInputSchema,
  submitEntrySchema,
  getJudgingPairSchema,
  submitVoteSchema,
  cancelCrucibleSchema,
  getUserCrucibleStatsSchema,
  getUserActiveCruciblesSchema,
  getFeaturedCrucibleSchema,
  getJudgesCountSchema,
  getJudgeStatsSchema,
} from '~/server/schema/crucible.schema';
import {
  createCrucible,
  getCrucible,
  getCrucibles,
  submitEntry,
  getJudgingPair,
  submitVote,
  cancelCrucible,
  getUserCrucibleStats,
  getUserActiveCrucibles,
  getFeaturedCrucible,
  getJudgesCount,
  getJudgeStats,
} from '~/server/services/crucible.service';
import { isModerator } from '~/server/routers/base.router';
import { Prisma } from '@prisma/client';

// Select for infinite list - includes essential fields for cards
const crucibleListSelect = Prisma.validator<Prisma.CrucibleSelect>()({
  id: true,
  userId: true,
  name: true,
  description: true,
  imageId: true,
  nsfwLevel: true,
  entryFee: true,
  entryLimit: true,
  maxTotalEntries: true,
  status: true,
  startAt: true,
  endAt: true,
  createdAt: true,
  user: {
    select: {
      id: true,
      username: true,
      image: true,
      deletedAt: true,
    },
  },
  image: {
    select: {
      id: true,
      name: true,
      url: true,
      type: true,
      metadata: true,
      nsfwLevel: true,
      width: true,
      height: true,
    },
  },
  _count: {
    select: {
      entries: true,
    },
  },
});

// Select for detail view - includes all fields and relations
const crucibleDetailSelect = Prisma.validator<Prisma.CrucibleSelect>()({
  id: true,
  userId: true,
  name: true,
  description: true,
  imageId: true,
  nsfwLevel: true,
  entryFee: true,
  entryLimit: true,
  maxTotalEntries: true,
  prizePositions: true,
  allowedResources: true,
  judgeRequirements: true,
  duration: true,
  status: true,
  startAt: true,
  endAt: true,
  createdAt: true,
  updatedAt: true,
  user: {
    select: {
      id: true,
      username: true,
      image: true,
      deletedAt: true,
    },
  },
  image: {
    select: {
      id: true,
      name: true,
      url: true,
      type: true,
      metadata: true,
      nsfwLevel: true,
      width: true,
      height: true,
    },
  },
  entries: {
    select: {
      id: true,
      userId: true,
      imageId: true,
      score: true,
      position: true,
      createdAt: true,
      user: {
        select: {
          id: true,
          username: true,
          image: true,
        },
      },
      image: {
        select: {
          id: true,
          name: true,
          url: true,
          nsfwLevel: true,
          width: true,
          height: true,
        },
      },
    },
    orderBy: {
      score: 'desc',
    },
  },
  _count: {
    select: {
      entries: true,
    },
  },
});

export const crucibleRouter = router({
  getInfinite: publicProcedure
    .use(isFlagProtected('crucible'))
    .input(getCruciblesInfiniteSchema)
    .query(async ({ input }) => {
      const items = await getCrucibles({
        input,
        select: crucibleListSelect,
      });

      return {
        items,
        nextCursor: items.length > 0 ? items[items.length - 1].id : undefined,
      };
    }),

  getById: publicProcedure
    .use(isFlagProtected('crucible'))
    .input(getCrucibleByIdSchema)
    .query(async ({ input }) => {
      const crucible = await getCrucible({
        id: input.id,
        select: crucibleDetailSelect,
      });

      return crucible;
    }),

  create: guardedProcedure
    .use(isFlagProtected('crucible'))
    .input(createCrucibleInputSchema)
    .mutation(async ({ ctx, input }) => {
      const crucible = await createCrucible({
        ...input,
        userId: ctx.user.id,
      });

      return crucible;
    }),

  submitEntry: guardedProcedure
    .use(isFlagProtected('crucible'))
    .input(submitEntrySchema)
    .mutation(async ({ ctx, input }) => {
      const entry = await submitEntry({
        ...input,
        userId: ctx.user.id,
      });

      return entry;
    }),

  getJudgingPair: guardedProcedure
    .use(isFlagProtected('crucible'))
    .input(getJudgingPairSchema)
    .query(async ({ ctx, input }) => {
      const pair = await getJudgingPair({
        ...input,
        userId: ctx.user.id,
      });

      return pair;
    }),

  submitVote: guardedProcedure
    .use(isFlagProtected('crucible'))
    .input(submitVoteSchema)
    .mutation(async ({ ctx, input }) => {
      const result = await submitVote({
        ...input,
        userId: ctx.user.id,
      });

      return result;
    }),

  cancel: guardedProcedure
    .use(isFlagProtected('crucible'))
    .use(isModerator)
    .input(cancelCrucibleSchema)
    .mutation(async ({ ctx, input }) => {
      // After isModerator middleware, ctx.user.isModerator is guaranteed to be true
      const result = await cancelCrucible({
        ...input,
        userId: ctx.user.id,
        isModerator: true, // Guaranteed by isModerator middleware
      });

      return result;
    }),

  getUserStats: guardedProcedure
    .use(isFlagProtected('crucible'))
    .input(getUserCrucibleStatsSchema)
    .query(async ({ ctx }) => {
      const stats = await getUserCrucibleStats({
        userId: ctx.user.id,
      });

      return stats;
    }),

  getUserActiveCrucibles: guardedProcedure
    .use(isFlagProtected('crucible'))
    .input(getUserActiveCruciblesSchema)
    .query(async ({ ctx }) => {
      const crucibles = await getUserActiveCrucibles({
        userId: ctx.user.id,
      });

      return crucibles;
    }),

  getFeatured: publicProcedure
    .use(isFlagProtected('crucible'))
    .input(getFeaturedCrucibleSchema)
    .query(async () => {
      const featured = await getFeaturedCrucible();
      return featured;
    }),

  getJudgesCount: publicProcedure
    .use(isFlagProtected('crucible'))
    .input(getJudgesCountSchema)
    .query(async ({ input }) => {
      const count = await getJudgesCount(input.crucibleId);
      return { count };
    }),

  getJudgeStats: guardedProcedure
    .use(isFlagProtected('crucible'))
    .input(getJudgeStatsSchema)
    .query(async ({ ctx, input }) => {
      const stats = await getJudgeStats({
        userId: ctx.user.id,
        crucibleId: input.crucibleId,
      });
      return stats;
    }),
});
