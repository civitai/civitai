import { Prisma } from '@prisma/client';

export const crucibleListSelect = Prisma.validator<Prisma.CrucibleSelect>()({
  id: true,
  userId: true,
  name: true,
  description: true,
  imageId: true,
  nsfwLevel: true,
  seededPrizePool: true,
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

export const crucibleDetailSelect = Prisma.validator<Prisma.CrucibleSelect>()({
  id: true,
  userId: true,
  name: true,
  description: true,
  imageId: true,
  nsfwLevel: true,
  contentType: true,
  seededPrizePool: true,
  entryFee: true,
  entryLimit: true,
  maxTotalEntries: true,
  prizePositions: true,
  allowedResources: true,
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
          type: true,
          metadata: true,
          nsfwLevel: true,
          width: true,
          height: true,
        },
      },
    },
    // Entry time, never score: a rank-ordered list leaks the live ranking even when the
    // scores themselves are redacted. getCrucibleDetail re-sorts by score once rankings are final.
    orderBy: { createdAt: 'asc' },
  },
  _count: {
    select: {
      entries: true,
    },
  },
});

export type CrucibleDetailRow = Prisma.CrucibleGetPayload<{ select: typeof crucibleDetailSelect }>;
export type CrucibleDetailRowEntry = CrucibleDetailRow['entries'][number];
