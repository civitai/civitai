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
  GetJudgingPairSchema,
  SubmitVoteSchema,
} from '../schema/crucible.schema';
import type { RedisKeyTemplateSys } from '~/server/redis/client';
import { sysRedis, REDIS_SYS_KEYS } from '~/server/redis/client';
import { getEntryElo, CRUCIBLE_DEFAULT_ELO, processVote as processEloVote } from './crucible-elo.service';
import { shuffle } from '~/utils/array-helpers';

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

// ELO deviation thresholds for estimating vote activity
// An entry with ELO closer to 1500 has likely received fewer votes
const ELO_DEVIATION_LOW = 50; // 0-50 ELO deviation: likely 0-5 votes (calibration)
const ELO_DEVIATION_MED = 150; // 50-150 ELO deviation: likely 6-20 votes (discovery)
// >150 ELO deviation: likely 20+ votes (optimization)

/**
 * Redis key for tracking voted pairs per user per crucible
 */
function getVotedPairsKey(crucibleId: number, userId: number): RedisKeyTemplateSys {
  return `${REDIS_SYS_KEYS.CRUCIBLE.VOTED_PAIRS}:${crucibleId}:${userId}` as RedisKeyTemplateSys;
}

/**
 * Create a canonical pair key (always sorted so a:b == b:a)
 */
function createPairKey(entryId1: number, entryId2: number): string {
  const [smaller, larger] = entryId1 < entryId2 ? [entryId1, entryId2] : [entryId2, entryId1];
  return `${smaller}:${larger}`;
}

/**
 * Mark pair as voted by user
 */
export async function markPairVoted(
  crucibleId: number,
  userId: number,
  entryId1: number,
  entryId2: number
): Promise<void> {
  const key = getVotedPairsKey(crucibleId, userId);
  const pairKey = createPairKey(entryId1, entryId2);
  await sysRedis.sAdd(key, [pairKey]);
  // Set TTL to 30 days (for crucible cleanup)
  await sysRedis.expire(key, 30 * 24 * 60 * 60);
}

/**
 * Get all voted pairs for a user in a crucible
 */
async function getVotedPairs(crucibleId: number, userId: number): Promise<Set<string>> {
  const key = getVotedPairsKey(crucibleId, userId);
  const pairs = await sysRedis.sMembers(key);
  return new Set(pairs);
}

/**
 * Estimate vote activity based on ELO deviation from default
 * Entries closer to 1500 have likely received fewer votes
 */
function getEloDeviation(score: number): number {
  return Math.abs(score - CRUCIBLE_DEFAULT_ELO);
}

type EntryForJudging = {
  id: number;
  imageId: number;
  userId: number;
  score: number;
  image: {
    id: number;
    url: string;
    width: number | null;
    height: number | null;
    nsfwLevel: number;
  };
  user: {
    id: number;
    username: string | null;
    deletedAt: Date | null;
    image: string | null;
  };
};

export type JudgingPair = {
  left: EntryForJudging;
  right: EntryForJudging;
} | null;

/**
 * Get a pair of entries for judging
 *
 * Selection algorithm:
 * 1. Image A: Weighted by lowest ELO deviation (prioritize under-voted entries near 1500)
 * 2. Image B: Based on voting phase of Image A (estimated from ELO deviation):
 *    - Calibration (deviation 0-50): Pick anchor (high deviation, established ELO)
 *    - Discovery (deviation 50-150): Pick uncertain (similar uncertain ELO)
 *    - Optimization (deviation >150): Pick similar ELO
 * 3. Exclude pairs the user has already voted on
 * 4. Randomize left/right position
 */
export const getJudgingPair = async ({
  crucibleId,
  userId,
}: GetJudgingPairSchema & { userId: number }): Promise<JudgingPair> => {
  // Fetch the crucible to validate it's active
  const crucible = await dbRead.crucible.findUnique({
    where: { id: crucibleId },
    select: {
      id: true,
      status: true,
      endAt: true,
    },
  });

  if (!crucible) {
    throwNotFoundError('Crucible not found');
    return null; // TypeScript flow - never reached
  }

  if (crucible.status !== CrucibleStatus.Active) {
    throwBadRequestError('This crucible is not currently active for judging');
    return null;
  }

  if (crucible.endAt && new Date() > crucible.endAt) {
    throwBadRequestError('This crucible has ended');
    return null;
  }

  // Fetch all entries with their scores and images
  const entries = await dbRead.crucibleEntry.findMany({
    where: { crucibleId },
    select: {
      id: true,
      imageId: true,
      userId: true,
      score: true,
      image: {
        select: {
          id: true,
          url: true,
          width: true,
          height: true,
          nsfwLevel: true,
        },
      },
      user: {
        select: {
          id: true,
          username: true,
          deletedAt: true,
          image: true,
        },
      },
    },
  });

  // Need at least 2 entries to form a pair
  if (entries.length < 2) {
    return null;
  }

  // Get all pairs this user has already voted on
  const votedPairs = await getVotedPairs(crucibleId, userId);

  // Filter entries to exclude user's own entries (can't vote on own images)
  const eligibleEntries = entries.filter((entry) => entry.userId !== userId);

  if (eligibleEntries.length < 2) {
    return null; // Not enough entries from other users
  }

  // Step 1: Select Image A - weighted by lowest ELO deviation (closest to 1500)
  // Sort by ELO deviation ascending, then add some randomness among entries with similar deviation
  const sortedByDeviation = [...eligibleEntries].sort(
    (a, b) => getEloDeviation(a.score) - getEloDeviation(b.score)
  );

  // Get the minimum deviation
  const minDeviation = getEloDeviation(sortedByDeviation[0].score);

  // Pool entries with deviation close to minimum (within 30 ELO points)
  const lowDeviationPool = sortedByDeviation.filter(
    (entry) => getEloDeviation(entry.score) <= minDeviation + 30
  );

  // Shuffle the low deviation pool and iterate to find a valid Image A
  const shuffledPool = shuffle([...lowDeviationPool]);

  let imageA: EntryForJudging | null = null;
  let imageB: EntryForJudging | null = null;

  for (const candidateA of shuffledPool) {
    // Step 2: Select Image B based on voting phase (estimated from ELO deviation)
    const phase = getVotingPhase(getEloDeviation(candidateA.score));

    // Get candidate B pool based on phase
    const candidateBPool = getCandidateBPool(
      eligibleEntries,
      candidateA,
      phase,
      votedPairs
    );

    if (candidateBPool.length === 0) {
      continue; // No valid B candidates for this A, try next A
    }

    // Shuffle and pick first valid B
    const shuffledBPool = shuffle([...candidateBPool]);
    for (const candidateB of shuffledBPool) {
      const pairKey = createPairKey(candidateA.id, candidateB.id);
      if (!votedPairs.has(pairKey)) {
        imageA = candidateA;
        imageB = candidateB;
        break;
      }
    }

    if (imageA && imageB) break;
  }

  // If no valid pair found
  if (!imageA || !imageB) {
    return null;
  }

  // Step 4: Randomize left/right position
  const swapPositions = Math.random() < 0.5;

  return {
    left: swapPositions ? imageB : imageA,
    right: swapPositions ? imageA : imageB,
  };
};

/**
 * Determine the voting phase based on ELO deviation
 */
function getVotingPhase(deviation: number): 'calibration' | 'discovery' | 'optimization' {
  if (deviation <= ELO_DEVIATION_LOW) {
    return 'calibration';
  } else if (deviation <= ELO_DEVIATION_MED) {
    return 'discovery';
  } else {
    return 'optimization';
  }
}

/**
 * Get candidate pool for Image B based on voting phase
 */
function getCandidateBPool(
  entries: EntryForJudging[],
  imageA: EntryForJudging,
  phase: 'calibration' | 'discovery' | 'optimization',
  votedPairs: Set<string>
): EntryForJudging[] {
  // Filter out Image A and already voted pairs
  const validCandidates = entries.filter((entry) => {
    if (entry.id === imageA.id) return false;
    const pairKey = createPairKey(imageA.id, entry.id);
    return !votedPairs.has(pairKey);
  });

  if (validCandidates.length === 0) return [];

  switch (phase) {
    case 'calibration': {
      // Anchor: Pick entries with high ELO deviation (established ratings)
      // These serve as reference points for new entries
      const highDeviationEntries = validCandidates.filter(
        (entry) => getEloDeviation(entry.score) > ELO_DEVIATION_LOW
      );
      // If no high-deviation entries available, fall back to any available entries
      return highDeviationEntries.length > 0 ? highDeviationEntries : validCandidates;
    }

    case 'discovery': {
      // Uncertain: Pick entries with similar uncertain ELO
      // Find entries within 200 ELO points and similar deviation range
      const imageAElo = imageA.score;

      const uncertainEntries = validCandidates.filter((entry) => {
        const eloDiff = Math.abs(imageAElo - entry.score);
        const entryDeviation = getEloDeviation(entry.score);
        // Wide ELO range (200) and similar phase entries
        return (
          eloDiff <= 200 &&
          entryDeviation >= ELO_DEVIATION_LOW &&
          entryDeviation <= ELO_DEVIATION_MED * 2
        );
      });
      // Fall back to any available if no similar entries
      return uncertainEntries.length > 0 ? uncertainEntries : validCandidates;
    }

    case 'optimization': {
      // Similar ELO: Pick entries with similar ELO for fine-tuning rankings
      const imageAElo = imageA.score;

      // Narrow ELO range (100) for optimization
      let similarEloEntries = validCandidates.filter((entry) => {
        const eloDiff = Math.abs(imageAElo - entry.score);
        return eloDiff <= 100;
      });

      // If no similar ELO entries, expand to 200 range
      if (similarEloEntries.length === 0) {
        similarEloEntries = validCandidates.filter((entry) => {
          const eloDiff = Math.abs(imageAElo - entry.score);
          return eloDiff <= 200;
        });
      }

      return similarEloEntries.length > 0 ? similarEloEntries : validCandidates;
    }
  }
}

/**
 * Submit a vote result type
 */
export type SubmitVoteResult = {
  winnerElo: number;
  loserElo: number;
  winnerEntryId: number;
  loserEntryId: number;
};

/**
 * Submit a vote on a pair of crucible entries
 *
 * @param crucibleId - The crucible ID
 * @param winnerEntryId - The entry ID that the user selected as the winner
 * @param loserEntryId - The entry ID that lost the vote
 * @param userId - The user submitting the vote
 * @returns Updated ELO scores for both entries
 */
export const submitVote = async ({
  crucibleId,
  winnerEntryId,
  loserEntryId,
  userId,
}: SubmitVoteSchema & { userId: number }): Promise<SubmitVoteResult> => {
  // Fetch the crucible to validate it's active
  const crucible = await dbRead.crucible.findUnique({
    where: { id: crucibleId },
    select: {
      id: true,
      status: true,
      endAt: true,
    },
  });

  if (!crucible) {
    throw throwNotFoundError('Crucible not found');
  }

  if (crucible.status !== CrucibleStatus.Active) {
    throw throwBadRequestError('This crucible is not currently active for judging');
  }

  if (crucible.endAt && new Date() > crucible.endAt) {
    throw throwBadRequestError('This crucible has ended');
  }

  // Validate entries exist and belong to this crucible
  const [winnerEntry, loserEntry] = await Promise.all([
    dbRead.crucibleEntry.findUnique({
      where: { id: winnerEntryId },
      select: { id: true, crucibleId: true, userId: true, voteCount: true },
    }),
    dbRead.crucibleEntry.findUnique({
      where: { id: loserEntryId },
      select: { id: true, crucibleId: true, userId: true, voteCount: true },
    }),
  ]);

  if (!winnerEntry) {
    throw throwNotFoundError('Winner entry not found');
  }

  if (!loserEntry) {
    throw throwNotFoundError('Loser entry not found');
  }

  if (winnerEntry.crucibleId !== crucibleId) {
    throw throwBadRequestError('Winner entry does not belong to this crucible');
  }

  if (loserEntry.crucibleId !== crucibleId) {
    throw throwBadRequestError('Loser entry does not belong to this crucible');
  }

  // User cannot vote on their own entries
  if (winnerEntry.userId === userId || loserEntry.userId === userId) {
    throw throwBadRequestError('You cannot vote on your own entries');
  }

  // Check if user has already voted on this pair
  const votedPairs = await getVotedPairs(crucibleId, userId);
  const pairKey = createPairKey(winnerEntryId, loserEntryId);

  if (votedPairs.has(pairKey)) {
    throw throwBadRequestError('You have already voted on this pair');
  }

  // Update ELO scores in Redis using processVote from crucible-elo.service
  const { winnerElo, loserElo } = await processEloVote(
    crucibleId,
    winnerEntryId,
    loserEntryId,
    winnerEntry.voteCount,
    loserEntry.voteCount
  );

  // Increment voteCount on both entries in database
  await dbWrite.$transaction([
    dbWrite.crucibleEntry.update({
      where: { id: winnerEntryId },
      data: { voteCount: { increment: 1 } },
    }),
    dbWrite.crucibleEntry.update({
      where: { id: loserEntryId },
      data: { voteCount: { increment: 1 } },
    }),
  ]);

  // Mark pair as voted in Redis
  await markPairVoted(crucibleId, userId, winnerEntryId, loserEntryId);

  return {
    winnerElo,
    loserElo,
    winnerEntryId,
    loserEntryId,
  };
};
