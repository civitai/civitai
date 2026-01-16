import { Prisma } from '@prisma/client';
import dayjs from '~/shared/utils/dayjs';
import { CrucibleStatus, MediaType } from '~/shared/utils/prisma/enums';
import { CrucibleSort } from '../schema/crucible.schema';
import { dbRead, dbWrite } from '../db/client';
import type {
  GetCruciblesInfiniteSchema,
  GetCrucibleByIdSchema,
  CreateCrucibleInputSchema,
} from '../schema/crucible.schema';

/**
 * Create a new crucible
 */
export const createCrucible = async ({
  userId,
  name,
  description,
  coverImage,
  nsfwLevel,
  entryFee,
  entryLimit,
  maxTotalEntries,
  prizePositions,
  allowedResources,
  judgeRequirements,
  duration,
}: CreateCrucibleInputSchema & { userId: number }) => {
  const now = new Date();
  const startAt = now;
  const endAt = dayjs(now).add(duration, 'hours').toDate();

  // Create the crucible with cover image in a transaction
  const crucible = await dbWrite.$transaction(async (tx) => {
    // First, create the Image record from the CF upload data
    const image = await tx.image.create({
      data: {
        userId,
        url: coverImage.url,
        width: coverImage.width,
        height: coverImage.height,
        hash: coverImage.hash ?? null,
        nsfwLevel,
        type: MediaType.image,
      },
    });

    // Then create the crucible with the image reference
    const newCrucible = await tx.crucible.create({
      data: {
        userId,
        name,
        description: description ?? null,
        imageId: image.id,
        nsfwLevel,
        entryFee,
        entryLimit,
        maxTotalEntries: maxTotalEntries ?? null,
        prizePositions: prizePositions as Prisma.JsonObject,
        allowedResources: allowedResources
          ? (allowedResources as Prisma.JsonArray)
          : Prisma.JsonNull,
        judgeRequirements: judgeRequirements
          ? (judgeRequirements as Prisma.JsonObject)
          : Prisma.JsonNull,
        duration: duration * 60, // Convert hours to minutes for storage
        startAt,
        endAt,
        status: CrucibleStatus.Active,
      },
    });

    return newCrucible;
  });

  return crucible;
};

/**
 * Get a single crucible by ID with relations
 */
export const getCrucible = async <TSelect extends Prisma.CrucibleSelect>({
  id,
  select,
}: GetCrucibleByIdSchema & { select: TSelect }) => {
  return dbRead.crucible.findUnique({
    where: { id },
    select,
  });
};

/**
 * Get crucibles with filters, sorting, and cursor pagination
 */
export const getCrucibles = async <TSelect extends Prisma.CrucibleSelect>({
  input: { cursor, limit: take, status, sort },
  select,
}: {
  input: GetCruciblesInfiniteSchema;
  select: TSelect;
}) => {
  const where: Prisma.CrucibleWhereInput = {};

  // Apply status filter
  if (status) {
    where.status = status;
  }

  // Apply sorting
  const orderBy: Prisma.CrucibleFindManyArgs['orderBy'] = [];

  if (sort === CrucibleSort.PrizePool) {
    // Sort by entry fee (proxy for prize pool size)
    orderBy.push({ entryFee: 'desc' });
    orderBy.push({ createdAt: 'desc' }); // Secondary sort
  } else if (sort === CrucibleSort.EndingSoon) {
    // Sort by end date ascending (soonest first)
    orderBy.push({ endAt: 'asc' });
  } else {
    // Default: Newest
    orderBy.push({ createdAt: 'desc' });
  }

  return dbRead.crucible.findMany({
    take,
    cursor: cursor ? { id: cursor } : undefined,
    where,
    orderBy,
    select,
  });
};

/**
 * Get entries for a crucible sorted by score (ELO)
 */
export const getCrucibleEntries = async <TSelect extends Prisma.CrucibleEntrySelect>({
  crucibleId,
  select,
}: {
  crucibleId: number;
  select: TSelect;
}) => {
  return dbRead.crucibleEntry.findMany({
    where: { crucibleId },
    orderBy: { score: 'desc' },
    select,
  });
};
