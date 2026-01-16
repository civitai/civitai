import { Prisma } from '@prisma/client';
import dayjs from '~/shared/utils/dayjs';
import { CrucibleStatus, MediaType } from '~/shared/utils/prisma/enums';
import { CrucibleSort } from '../schema/crucible.schema';
import { dbRead, dbWrite } from '../db/client';
import { Flags } from '~/shared/utils/flags';
import {
  throwBadRequestError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import type {
  GetCruciblesInfiniteSchema,
  GetCrucibleByIdSchema,
  CreateCrucibleInputSchema,
  SubmitEntrySchema,
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

/**
 * Submit an entry to a crucible
 */
export const submitEntry = async ({
  crucibleId,
  imageId,
  userId,
}: SubmitEntrySchema & { userId: number }) => {
  // Fetch the crucible with required validation data
  const crucible = await dbRead.crucible.findUnique({
    where: { id: crucibleId },
    select: {
      id: true,
      status: true,
      nsfwLevel: true,
      entryLimit: true,
      maxTotalEntries: true,
      allowedResources: true,
      endAt: true,
      _count: {
        select: { entries: true },
      },
    },
  });

  if (!crucible) {
    return throwNotFoundError('Crucible not found');
  }

  // Validate crucible is active
  if (crucible.status !== CrucibleStatus.Active) {
    return throwBadRequestError('This crucible is not accepting entries');
  }

  // Validate crucible hasn't ended
  if (crucible.endAt && new Date() > crucible.endAt) {
    return throwBadRequestError('This crucible has ended');
  }

  // Validate max total entries hasn't been reached
  if (crucible.maxTotalEntries && crucible._count.entries >= crucible.maxTotalEntries) {
    return throwBadRequestError('This crucible has reached its maximum number of entries');
  }

  // Check user's entry count for this crucible
  const userEntryCount = await dbRead.crucibleEntry.count({
    where: {
      crucibleId,
      userId,
    },
  });

  if (userEntryCount >= crucible.entryLimit) {
    return throwBadRequestError(
      `You have reached the maximum of ${crucible.entryLimit} ${crucible.entryLimit === 1 ? 'entry' : 'entries'} for this crucible`
    );
  }

  // Fetch the image to validate requirements
  const image = await dbRead.image.findUnique({
    where: { id: imageId },
    select: {
      id: true,
      userId: true,
      nsfwLevel: true,
    },
  });

  if (!image) {
    return throwNotFoundError('Image not found');
  }

  // Validate user owns the image
  if (image.userId !== userId) {
    return throwBadRequestError('You can only submit your own images');
  }

  // Validate image NSFW level is compatible with crucible
  // The image's NSFW level must intersect with the crucible's allowed NSFW levels
  if (!Flags.intersects(image.nsfwLevel, crucible.nsfwLevel)) {
    return throwBadRequestError(
      'This image does not meet the content level requirements for this crucible'
    );
  }

  // Check if image is already submitted to this crucible
  const existingEntry = await dbRead.crucibleEntry.findFirst({
    where: {
      crucibleId,
      imageId,
    },
  });

  if (existingEntry) {
    return throwBadRequestError('This image has already been submitted to this crucible');
  }

  // TODO: Validate allowed resources if specified (future feature)
  // if (crucible.allowedResources) {
  //   const resources = crucible.allowedResources as number[];
  //   // Check image generation resources against allowed list
  // }

  // Create the entry with default ELO score (1500)
  const entry = await dbWrite.crucibleEntry.create({
    data: {
      crucibleId,
      userId,
      imageId,
      score: 1500, // Default ELO score
    },
    select: {
      id: true,
      crucibleId: true,
      userId: true,
      imageId: true,
      score: true,
      position: true,
      createdAt: true,
    },
  });

  return entry;
};
