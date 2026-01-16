import { router, publicProcedure, guardedProcedure, isFlagProtected } from '~/server/trpc';
import {
  getCruciblesInfiniteSchema,
  getCrucibleByIdSchema,
  createCrucibleInputSchema,
} from '~/server/schema/crucible.schema';
import { createCrucible, getCrucible, getCrucibles } from '~/server/services/crucible.service';
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
});
