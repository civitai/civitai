import { Prisma } from '@prisma/client';
import { simpleUserSelect, userWithCosmeticsSelect } from '~/server/selectors/user.selector';

export const crucibleListSelect = Prisma.validator<Prisma.CrucibleSelect>()({
  id: true,
  buzzType: true,
  contentType: true,
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
  user: { select: simpleUserSelect },
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
  buzzType: true,
  userId: true,
  name: true,
  description: true,
  imageId: true,
  nsfwLevel: true,
  contentType: true,
  seededPrizePool: true,
  entryFee: true,
  entryLimit: true,
  freeEntriesPerUser: true,
  maxTotalEntries: true,
  minViewSeconds: true,
  maxClipSeconds: true,
  prizePositions: true,
  allowedResources: true,
  duration: true,
  status: true,
  startAt: true,
  endAt: true,
  createdAt: true,
  updatedAt: true,
  ingestion: true,
  textNsfw: true,
  user: { select: userWithCosmeticsSelect },
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
      ingestion: true,
    },
  },
  heroImage: {
    select: {
      id: true,
      name: true,
      url: true,
      type: true,
      metadata: true,
      nsfwLevel: true,
      width: true,
      height: true,
      ingestion: true,
    },
  },
  _count: {
    select: {
      entries: true,
    },
  },
});

export type CrucibleDetailRow = Prisma.CrucibleGetPayload<{ select: typeof crucibleDetailSelect }>;

export const crucibleEntrySelect = Prisma.validator<Prisma.CrucibleEntrySelect>()({
  id: true,
  userId: true,
  imageId: true,
  score: true,
  position: true,
  createdAt: true,
  user: { select: simpleUserSelect },
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
});

export type CrucibleEntryRow = Prisma.CrucibleEntryGetPayload<{
  select: typeof crucibleEntrySelect;
}>;
