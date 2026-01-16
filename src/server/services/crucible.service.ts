import { Prisma } from '@prisma/client';
import dayjs from '~/shared/utils/dayjs';
import { CrucibleStatus, MediaType } from '~/shared/utils/prisma/enums';
import { CrucibleSort } from '../schema/crucible.schema';
import { dbRead, dbWrite } from '../db/client';
import { Flags } from '~/shared/utils/flags';
import {
  throwBadRequestError,
  throwNotFoundError,
  throwInsufficientFundsError,
  throwAuthorizationError,
} from '~/server/utils/errorHandling';
import {
  createBuzzTransactionMany,
  createMultiAccountBuzzTransaction,
  getUserBuzzAccount,
  refundMultiAccountTransaction,
} from '~/server/services/buzz.service';
import { TransactionType } from '~/shared/constants/buzz.constants';
import type {
  GetCruciblesInfiniteSchema,
  GetCrucibleByIdSchema,
  CreateCrucibleInputSchema,
  SubmitEntrySchema,
  GetJudgingPairSchema,
  SubmitVoteSchema,
  CancelCrucibleSchema,
} from '../schema/crucible.schema';
import type { RedisKeyTemplateSys } from '~/server/redis/client';
import { sysRedis, REDIS_SYS_KEYS } from '~/server/redis/client';
import { getEntryElo, CRUCIBLE_DEFAULT_ELO, processVote as processEloVote, getAllEntryElos } from './crucible-elo.service';
import { crucibleEloRedis } from '~/server/redis/crucible-elo.redis';
import { shuffle } from '~/utils/array-helpers';
import { Tracker } from '~/server/clickhouse/client';
import { createLogger } from '~/utils/logging';
import { createNotification } from '~/server/services/notification.service';
import { NotificationCategory } from '~/server/common/enums';

const log = createLogger('crucible-service', 'cyan');

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
 * Generate a unique transaction prefix for crucible entry fees
 * This prefix is used to identify and refund transactions if needed
 */
export const getCrucibleEntryTransactionPrefix = (
  crucibleId: number,
  userId: number
): string => {
  return `crucible-entry-${crucibleId}-${userId}-${Date.now()}`;
};

/**
 * Check if a string is a valid crucible entry transaction prefix
 */
export const isCrucibleEntryTransactionPrefix = (prefix: string): boolean => {
  return prefix.startsWith('crucible-entry-') && prefix.split('-').length >= 5;
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
      name: true,
      userId: true, // Crucible creator for notification
      status: true,
      nsfwLevel: true,
      entryFee: true,
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

  // Handle entry fee collection (if entryFee > 0)
  let buzzTransactionId: string | null = null;

  if (crucible.entryFee > 0) {
    // Check if user has sufficient Buzz
    const userAccount = await getUserBuzzAccount({ accountId: userId, accountTypes: ['yellow', 'green'] });
    const totalBalance = userAccount.reduce((sum, acc) => sum + acc.balance, 0);

    if (totalBalance < crucible.entryFee) {
      const shortage = crucible.entryFee - totalBalance;
      return throwInsufficientFundsError(
        `You need ${crucible.entryFee.toLocaleString()} Buzz to enter this crucible. You currently have ${totalBalance.toLocaleString()} Buzz (${shortage.toLocaleString()} Buzz short).`
      );
    }

    // Generate transaction prefix for potential refunds
    const transactionPrefix = getCrucibleEntryTransactionPrefix(crucibleId, userId);

    // Create multi-account transaction to collect entry fee
    // Transfers from user's yellow/green Buzz to central bank (account 0)
    await createMultiAccountBuzzTransaction({
      fromAccountId: userId,
      fromAccountTypes: ['yellow', 'green'], // Allow both yellow and green Buzz
      toAccountId: 0, // Central bank
      amount: crucible.entryFee,
      type: TransactionType.Fee,
      externalTransactionIdPrefix: transactionPrefix,
      description: 'Crucible entry fee',
      details: {
        entityId: crucibleId,
        entityType: 'Crucible',
      },
    });

    buzzTransactionId = transactionPrefix;
  }

  // Create the entry with default ELO score (1500)
  const entry = await dbWrite.crucibleEntry.create({
    data: {
      crucibleId,
      userId,
      imageId,
      score: 1500, // Default ELO score
      buzzTransactionId,
    },
    select: {
      id: true,
      crucibleId: true,
      userId: true,
      imageId: true,
      score: true,
      position: true,
      buzzTransactionId: true,
      createdAt: true,
      user: {
        select: {
          username: true,
        },
      },
    },
  });

  // Send notification to crucible creator (don't notify if creator is submitting to their own crucible)
  if (crucible.userId !== userId) {
    // Fire-and-forget notification
    createNotification({
      userId: crucible.userId,
      type: 'crucible-entry-submitted',
      category: NotificationCategory.Crucible,
      key: `crucible-entry-submitted:${crucibleId}:${entry.id}`,
      details: {
        crucibleId,
        crucibleName: crucible.name,
        entrantUsername: entry.user.username ?? 'Anonymous',
      },
    }).catch((err) => {
      log(`Failed to send entry notification: ${err instanceof Error ? err.message : 'Unknown error'}`);
    });
  }

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
    throw throwBadRequestError(
      'You have already voted on this pair. Please wait for the next pair to load.'
    );
  }

  // Race condition protection: Try to atomically mark the pair as voted before processing
  // Use SADD to add to the set - if it returns 0, the pair was already added by another request
  const key = getVotedPairsKey(crucibleId, userId);
  const addResult = await sysRedis.sAdd(key, [pairKey]);
  await sysRedis.expire(key, 30 * 24 * 60 * 60); // 30 days TTL

  if (addResult === 0) {
    // Another concurrent request already processed this vote
    throw throwBadRequestError(
      'This vote is already being processed. Please wait for the next pair to load.'
    );
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

  // Note: Pair was already marked as voted atomically at the start of this function
  // for race condition protection - no need to call markPairVoted again

  // Track vote in ClickHouse (fire-and-forget)
  const tracker = new Tracker();
  tracker.crucibleVote({
    crucibleId,
    winnerEntryId,
    loserEntryId,
  });

  return {
    winnerElo,
    loserElo,
    winnerEntryId,
    loserEntryId,
  };
};

// ============================================================================
// Crucible Finalization
// ============================================================================

/**
 * Prize position type from database JSON
 */
type PrizePosition = {
  position: number;
  percentage: number;
};

/**
 * Entry with final score and position after finalization
 */
export type FinalizedEntry = {
  entryId: number;
  userId: number;
  finalScore: number;
  position: number;
  prizeAmount: number;
};

/**
 * Result of crucible finalization
 */
export type FinalizeCrucibleResult = {
  crucibleId: number;
  totalPrizePool: number;
  finalEntries: FinalizedEntry[];
  totalPrizesDistributed: number;
};

/**
 * Get ordinal suffix for a position (1st, 2nd, 3rd, etc.)
 */
function getOrdinalPosition(position: number): string {
  const suffixes = ['th', 'st', 'nd', 'rd'];
  const remainder = position % 100;
  const suffix =
    remainder >= 11 && remainder <= 13
      ? 'th'
      : suffixes[Math.min(position % 10, 4)] || 'th';
  return `${position}${suffix}`;
}

/**
 * Parse prize positions JSON from database
 */
function parsePrizePositions(prizePositionsJson: unknown): PrizePosition[] {
  if (!prizePositionsJson || !Array.isArray(prizePositionsJson)) {
    return [];
  }

  return prizePositionsJson
    .filter(
      (item): item is { position: number; percentage: number } =>
        typeof item === 'object' &&
        item !== null &&
        typeof item.position === 'number' &&
        typeof item.percentage === 'number'
    )
    .map((item) => ({
      position: item.position,
      percentage: item.percentage,
    }));
}

/**
 * Finalize a crucible after it has ended
 *
 * This function:
 * 1. Copies ELO scores from Redis to PostgreSQL CrucibleEntry.score
 * 2. Calculates final positions from ELO scores (entry time as tiebreaker)
 * 3. Updates CrucibleEntry records with final positions
 * 4. Calculates prize amounts based on configured percentages
 * 5. Updates crucible status to 'completed'
 * 6. Cleans up Redis ELO data (sets TTL for eventual cleanup)
 *
 * @param crucibleId - The crucible ID to finalize
 * @returns Finalization results including final standings and prize amounts
 */
export const finalizeCrucible = async (
  crucibleId: number
): Promise<FinalizeCrucibleResult> => {
  // Fetch the crucible with all entries
  const crucible = await dbRead.crucible.findUnique({
    where: { id: crucibleId },
    select: {
      id: true,
      name: true,
      userId: true, // Crucible creator for notification
      status: true,
      entryFee: true,
      prizePositions: true,
      endAt: true,
      entries: {
        select: {
          id: true,
          userId: true,
          score: true,
          createdAt: true, // For tiebreaker
        },
        orderBy: { createdAt: 'asc' }, // Ordered by entry time for tiebreaker
      },
    },
  });

  if (!crucible) {
    throw throwNotFoundError('Crucible not found');
  }

  // Validate crucible can be finalized
  if (crucible.status === CrucibleStatus.Completed) {
    throw throwBadRequestError('This crucible has already been finalized');
  }

  if (crucible.status === CrucibleStatus.Cancelled) {
    throw throwBadRequestError('Cannot finalize a cancelled crucible');
  }

  // Calculate total prize pool
  const totalPrizePool = crucible.entryFee * crucible.entries.length;

  // Parse prize positions from JSON
  const prizePositions = parsePrizePositions(crucible.prizePositions);

  // Sort prize positions by position number
  const sortedPrizePositions = [...prizePositions].sort((a, b) => a.position - b.position);

  // ============================================================================
  // Edge Case: 0 entries
  // ============================================================================
  if (crucible.entries.length === 0) {
    log(`Edge case: Crucible ${crucibleId} has 0 entries - finalizing without prizes`);

    // Update crucible status to completed
    await dbWrite.crucible.update({
      where: { id: crucibleId },
      data: {
        status: CrucibleStatus.Completed,
      },
    });

    // Clean up Redis ELO data (set TTL for eventual cleanup)
    await crucibleEloRedis.setTTL(crucibleId, 7 * 24 * 60 * 60);

    // Send 'crucible-ended' notification to the crucible creator
    createNotification({
      userId: crucible.userId,
      type: 'crucible-ended',
      category: NotificationCategory.Crucible,
      key: `crucible-ended:${crucibleId}`,
      details: {
        crucibleId,
        crucibleName: crucible.name,
        totalEntries: 0,
        prizePool: 0,
      },
    }).catch((err) => {
      log(`Failed to send crucible-ended notification: ${err instanceof Error ? err.message : 'Unknown error'}`);
    });

    return {
      crucibleId,
      totalPrizePool: 0,
      finalEntries: [],
      totalPrizesDistributed: 0,
    };
  }

  // ============================================================================
  // Edge Case: 1 entry (auto-win)
  // ============================================================================
  if (crucible.entries.length === 1) {
    log(`Edge case: Crucible ${crucibleId} has 1 entry - auto-win for entry ${crucible.entries[0].id}`);
  }

  // Get all ELO scores from Redis
  const redisElos = await getAllEntryElos(crucibleId);

  // Combine database entries with Redis ELO scores
  // If an entry doesn't have a Redis score, use the database score (1500 default)
  const entriesWithElo = crucible.entries.map((entry) => ({
    entryId: entry.id,
    userId: entry.userId,
    finalScore: redisElos[entry.id] ?? entry.score,
    createdAt: entry.createdAt,
  }));

  // Sort entries by ELO score (descending), with entry time as tiebreaker (earlier = higher rank)
  const sortedEntries = [...entriesWithElo].sort((a, b) => {
    if (b.finalScore !== a.finalScore) {
      return b.finalScore - a.finalScore; // Higher score = better position
    }
    // Tiebreaker: earlier entry wins
    return a.createdAt.getTime() - b.createdAt.getTime();
  });

  // ============================================================================
  // Edge Case: Tied ELO scores (log for debugging)
  // ============================================================================
  // Detect and log any tied scores that were resolved by tiebreaker
  const scoreGroups = new Map<number, typeof entriesWithElo>();
  for (const entry of entriesWithElo) {
    const group = scoreGroups.get(entry.finalScore) ?? [];
    group.push(entry);
    scoreGroups.set(entry.finalScore, group);
  }

  // Log tied scores resolved by entry time tiebreaker
  for (const [score, entries] of scoreGroups) {
    if (entries.length > 1) {
      const entryIds = entries.map((e) => e.entryId).join(', ');
      log(`Edge case: Crucible ${crucibleId} - ${entries.length} entries tied at ELO ${score} (entry IDs: ${entryIds}). Resolved by entry time (earlier entry wins).`);
    }
  }

  // Assign positions and calculate prize amounts
  const finalizedEntries: FinalizedEntry[] = sortedEntries.map((entry, index) => {
    const position = index + 1;

    // Find prize percentage for this position
    const prizeConfig = sortedPrizePositions.find((p) => p.position === position);
    const prizeAmount = prizeConfig
      ? Math.floor((prizeConfig.percentage / 100) * totalPrizePool)
      : 0;

    return {
      entryId: entry.entryId,
      userId: entry.userId,
      finalScore: entry.finalScore,
      position,
      prizeAmount,
    };
  });

  // Calculate total prizes distributed (for verification)
  const totalPrizesDistributed = finalizedEntries.reduce(
    (sum, entry) => sum + entry.prizeAmount,
    0
  );

  // Update all entries and crucible status in a transaction
  await dbWrite.$transaction(async (tx) => {
    // Update each entry with final score and position
    for (const entry of finalizedEntries) {
      await tx.crucibleEntry.update({
        where: { id: entry.entryId },
        data: {
          score: entry.finalScore,
          position: entry.position,
        },
      });
    }

    // Update crucible status to completed
    await tx.crucible.update({
      where: { id: crucibleId },
      data: {
        status: CrucibleStatus.Completed,
      },
    });
  });

  // Distribute prizes to winners
  // Filter entries that have a prize amount > 0
  const prizeWinners = finalizedEntries.filter((entry) => entry.prizeAmount > 0);

  if (prizeWinners.length > 0) {
    // Build transactions for prize distribution
    // Transfer from central bank (account 0) to each winner's yellow account
    const prizeTransactions = prizeWinners.map((winner) => ({
      fromAccountId: 0, // Central bank
      fromAccountType: 'yellow' as const,
      toAccountId: winner.userId,
      toAccountType: 'yellow' as const,
      amount: winner.prizeAmount,
      type: TransactionType.Reward,
      description: `Crucible prize - ${getOrdinalPosition(winner.position)} place`,
      details: {
        entityId: crucibleId,
        entityType: 'Crucible',
        position: winner.position,
      },
      externalTransactionId: `crucible-prize-${crucibleId}-${winner.entryId}-${winner.position}`,
    }));

    try {
      // Execute all prize transactions in a single batch
      const result = await createBuzzTransactionMany(prizeTransactions);
      log(
        `Distributed prizes for crucible ${crucibleId}: ${prizeWinners.length} winners, ${result.transactions.length} transactions`
      );
    } catch (error) {
      // Log the error but don't fail finalization - prizes can be manually distributed
      log(
        `Failed to distribute prizes for crucible ${crucibleId}: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      // Re-throw to ensure the finalization job knows about the failure
      throw error;
    }
  } else {
    log(`No prizes to distribute for crucible ${crucibleId} (no winners or 0 prize pool)`);
  }

  // Set TTL on Redis ELO hash for cleanup (7 days)
  // This keeps data available for a while in case of issues
  await crucibleEloRedis.setTTL(crucibleId, 7 * 24 * 60 * 60);

  log(`Finalized crucible ${crucibleId}: ${finalizedEntries.length} entries, ${totalPrizesDistributed} Buzz in prizes`);

  // Send notifications (fire-and-forget, don't block finalization)

  // 1. Send 'crucible-ended' notification to the crucible creator
  createNotification({
    userId: crucible.userId,
    type: 'crucible-ended',
    category: NotificationCategory.Crucible,
    key: `crucible-ended:${crucibleId}`,
    details: {
      crucibleId,
      crucibleName: crucible.name,
      totalEntries: finalizedEntries.length,
      prizePool: totalPrizePool,
    },
  }).catch((err) => {
    log(`Failed to send crucible-ended notification: ${err instanceof Error ? err.message : 'Unknown error'}`);
  });

  // 2. Send 'crucible-won' notifications to all participants with their final position
  // Group entries by userId to avoid duplicate notifications (one per user, not per entry)
  const userResults = new Map<number, FinalizedEntry>();
  for (const entry of finalizedEntries) {
    const existing = userResults.get(entry.userId);
    // Keep the best entry (lowest position = better rank)
    if (!existing || entry.position < existing.position) {
      userResults.set(entry.userId, entry);
    }
  }

  // Send notifications for each unique participant
  for (const [participantUserId, bestEntry] of userResults) {
    // Skip notifying the crucible creator about their own entries (they already got crucible-ended)
    if (participantUserId === crucible.userId) continue;

    createNotification({
      userId: participantUserId,
      type: 'crucible-won',
      category: NotificationCategory.Crucible,
      key: `crucible-won:${crucibleId}:${participantUserId}`,
      details: {
        crucibleId,
        crucibleName: crucible.name,
        position: bestEntry.position,
        prizeAmount: bestEntry.prizeAmount,
      },
    }).catch((err) => {
      log(`Failed to send crucible-won notification to user ${participantUserId}: ${err instanceof Error ? err.message : 'Unknown error'}`);
    });
  }

  return {
    crucibleId,
    totalPrizePool,
    finalEntries: finalizedEntries,
    totalPrizesDistributed,
  };
};

/**
 * Get crucibles that are ready for finalization
 * (Active status with endAt in the past)
 */
export const getCruciblesForFinalization = async (): Promise<number[]> => {
  const now = new Date();

  const crucibles = await dbRead.crucible.findMany({
    where: {
      status: CrucibleStatus.Active,
      endAt: {
        lt: now,
      },
    },
    select: {
      id: true,
    },
  });

  return crucibles.map((c) => c.id);
};

// ============================================================================
// Crucible Cancellation
// ============================================================================

/**
 * Result of crucible cancellation
 */
export type CancelCrucibleResult = {
  crucibleId: number;
  refundedEntries: number;
  totalRefunded: number;
  failedRefunds: Array<{ entryId: number; userId: number; error: string }>;
};

/**
 * Cancel a crucible and refund all entry fees
 *
 * This function:
 * 1. Validates the crucible can be cancelled (not already completed/cancelled)
 * 2. Refunds all entry fees using stored transaction prefixes
 * 3. Updates crucible status to 'cancelled'
 * 4. Cleans up Redis ELO data
 *
 * @param id - The crucible ID to cancel
 * @param userId - The user requesting cancellation
 * @param isModerator - Whether the user is a moderator
 * @returns Cancellation results including refund counts
 */
export const cancelCrucible = async ({
  id,
  userId,
  isModerator,
}: CancelCrucibleSchema & { userId: number; isModerator: boolean }): Promise<CancelCrucibleResult> => {
  // Only moderators can cancel crucibles
  if (!isModerator) {
    throw throwAuthorizationError('Only moderators can cancel crucibles');
  }

  // Fetch the crucible with all entries that have transaction IDs
  const crucible = await dbRead.crucible.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      entryFee: true,
      entries: {
        select: {
          id: true,
          userId: true,
          buzzTransactionId: true,
        },
      },
    },
  });

  if (!crucible) {
    throw throwNotFoundError('Crucible not found');
  }

  // Validate crucible can be cancelled
  if (crucible.status === CrucibleStatus.Completed) {
    throw throwBadRequestError('Cannot cancel a completed crucible');
  }

  if (crucible.status === CrucibleStatus.Cancelled) {
    throw throwBadRequestError('This crucible has already been cancelled');
  }

  // Track refund results
  let refundedEntries = 0;
  let totalRefunded = 0;
  const failedRefunds: Array<{ entryId: number; userId: number; error: string }> = [];

  // Refund entry fees for all entries with transaction IDs
  for (const entry of crucible.entries) {
    if (!entry.buzzTransactionId) {
      // Entry has no transaction ID (free crucible or legacy entry)
      continue;
    }

    try {
      // Refund using the stored transaction prefix
      await refundMultiAccountTransaction({
        externalTransactionIdPrefix: entry.buzzTransactionId,
        description: 'Crucible entry fee refund - crucible cancelled',
        details: {
          entityId: crucible.id,
          entityType: 'Crucible',
          reason: 'cancellation',
        },
      });

      refundedEntries++;
      totalRefunded += crucible.entryFee;

      log(`Refunded entry ${entry.id} for user ${entry.userId}: ${crucible.entryFee} Buzz`);
    } catch (error) {
      // Log failed refund but continue with other entries
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      failedRefunds.push({
        entryId: entry.id,
        userId: entry.userId,
        error: errorMessage,
      });

      log(`Failed to refund entry ${entry.id} for user ${entry.userId}: ${errorMessage}`);
    }
  }

  // Update crucible status to cancelled
  await dbWrite.crucible.update({
    where: { id },
    data: {
      status: CrucibleStatus.Cancelled,
    },
  });

  // Clean up Redis ELO data (set short TTL for eventual cleanup)
  await crucibleEloRedis.setTTL(id, 24 * 60 * 60); // 24 hours

  log(
    `Cancelled crucible ${id}: ${refundedEntries} entries refunded, ${totalRefunded} Buzz total, ${failedRefunds.length} failed`
  );

  return {
    crucibleId: id,
    refundedEntries,
    totalRefunded,
    failedRefunds,
  };
};
