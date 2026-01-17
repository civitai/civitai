import { Prisma } from '@prisma/client';
import dayjs from '~/shared/utils/dayjs';
import plimit from 'p-limit';
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
import { calculateCrucibleSetupCost } from '../schema/crucible.schema';
import type { RedisKeyTemplateSys } from '~/server/redis/client';
import { sysRedis, REDIS_SYS_KEYS } from '~/server/redis/client';
import {
  getEntryElo,
  CRUCIBLE_DEFAULT_ELO,
  processVote as processEloVote,
  getAllEntryElos,
} from './crucible-elo.service';
import { crucibleEloRedis } from '~/server/redis/crucible-elo.redis';
import { Tracker } from '~/server/clickhouse/client';
import { createLogger } from '~/utils/logging';
import { createNotification } from '~/server/services/notification.service';
import { NotificationCategory } from '~/server/common/enums';
import { imageResourcesCache } from '~/server/redis/caches';

const log = createLogger('crucible-service', 'cyan');

/**
 * Generate a unique transaction prefix for crucible setup fees
 * This prefix is used to identify and refund transactions if needed
 */
export const getCrucibleSetupTransactionPrefix = (userId: number): string => {
  return `crucible-setup-${userId}-${Date.now()}`;
};

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
  prizeCustomized,
  allowedResources,
  judgeRequirements,
  duration,
}: CreateCrucibleInputSchema & { userId: number }) => {
  const now = new Date();
  const startAt = now;
  const endAt = dayjs(now).add(duration, 'hours').toDate();

  // Calculate setup cost based on duration and prize customization
  const setupCost = calculateCrucibleSetupCost(duration, prizeCustomized ?? false);

  // If there's a setup cost, validate user has sufficient Buzz and charge them
  let buzzTransactionId: string | null = null;

  if (setupCost > 0) {
    // Check if user has sufficient Buzz
    const userAccount = await getUserBuzzAccount({
      accountId: userId,
      accountTypes: ['yellow', 'green'],
    });
    const totalBalance = userAccount.reduce((sum, acc) => sum + acc.balance, 0);

    if (totalBalance < setupCost) {
      const shortage = setupCost - totalBalance;
      throwInsufficientFundsError(
        `You need ${setupCost.toLocaleString()} Buzz to create this crucible. You currently have ${totalBalance.toLocaleString()} Buzz (${shortage.toLocaleString()} Buzz short).`
      );
    }

    // Generate transaction prefix for potential refunds
    const transactionPrefix = getCrucibleSetupTransactionPrefix(userId);

    // Charge setup fee by transferring from user's yellow/green Buzz to central bank (account 0)
    await createMultiAccountBuzzTransaction({
      fromAccountId: userId,
      fromAccountTypes: ['yellow', 'green'], // Allow both yellow and green Buzz
      toAccountId: 0, // Central bank
      amount: setupCost,
      type: TransactionType.Fee,
      externalTransactionIdPrefix: transactionPrefix,
      description: 'Crucible creation fee',
      details: {
        entityType: 'Crucible',
        duration,
        prizeCustomized: prizeCustomized ?? false,
      },
    });

    buzzTransactionId = transactionPrefix;
    log(
      `Charged ${setupCost} Buzz setup fee for user ${userId} (transaction: ${transactionPrefix})`
    );
  }

  // Create the crucible with cover image in a transaction
  // Wrap in try/catch to refund setup fee if database write fails
  try {
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
          buzzTransactionId, // Store the setup fee transaction ID for potential refunds
        },
      });

      return newCrucible;
    });

    return crucible;
  } catch (error) {
    // Database write failed - refund setup fee if it was charged
    if (buzzTransactionId) {
      try {
        await refundMultiAccountTransaction({
          externalTransactionIdPrefix: buzzTransactionId,
          description: 'Crucible creation fee refund - database write failed',
          details: {
            entityType: 'Crucible',
            duration,
            prizeCustomized: prizeCustomized ?? false,
          },
        });
        log(
          `Refunded setup fee for user ${userId} after database failure (transaction: ${buzzTransactionId})`
        );
      } catch (refundError) {
        const refundErrorMsg = refundError instanceof Error ? refundError.message : 'Unknown error';
        log(
          `CRITICAL: Failed to refund setup fee for user ${userId} after database failure: ${refundErrorMsg}`
        );
        // Re-throw original error even if refund fails so user is aware of the failure
      }
    }
    // Re-throw the original error
    throw error;
  }
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
  } else if (sort === CrucibleSort.MostEntries) {
    // Sort by entry count descending
    orderBy.push({ entries: { _count: 'desc' } });
    orderBy.push({ createdAt: 'desc' }); // Secondary sort
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
export const getCrucibleEntryTransactionPrefix = (crucibleId: number, userId: number): string => {
  return `crucible-entry-${crucibleId}-${userId}-${Date.now()}`;
};

/**
 * Check if a string is a valid crucible entry transaction prefix
 */
export const isCrucibleEntryTransactionPrefix = (prefix: string): boolean => {
  return prefix.startsWith('crucible-entry-') && prefix.split('-').length >= 5;
};

/**
 * Get Redis lock key for entry submission
 * Pattern: lock:crucible-entry:{crucibleId}:{userId}
 */
function getEntryLockKey(crucibleId: number, userId: number): RedisKeyTemplateSys {
  return `lock:crucible-entry:${crucibleId}:${userId}` as RedisKeyTemplateSys;
}

/**
 * Acquire a distributed lock for entry submission
 * Uses SET NX with short TTL to prevent race conditions
 * @returns true if lock acquired, false if already locked
 */
async function acquireEntryLock(crucibleId: number, userId: number): Promise<boolean> {
  const lockKey = getEntryLockKey(crucibleId, userId);
  const lockValue = `${Date.now()}-${Math.random()}`;

  try {
    // SET NX with 5 second TTL to prevent deadlocks
    const result = await sysRedis.set(lockKey, lockValue, {
      PX: 5000, // 5 second TTL in milliseconds
      NX: true, // Only set if not exists
    });

    return result === 'OK';
  } catch (error) {
    log(
      `Failed to acquire entry lock for crucible ${crucibleId}, user ${userId}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`
    );
    // On Redis failure, allow the operation to proceed (fail-open)
    // The database transaction will still provide some protection
    return true;
  }
}

/**
 * Release a distributed lock for entry submission
 */
async function releaseEntryLock(crucibleId: number, userId: number): Promise<void> {
  const lockKey = getEntryLockKey(crucibleId, userId);

  try {
    await sysRedis.del(lockKey);
  } catch (error) {
    log(
      `Failed to release entry lock for crucible ${crucibleId}, user ${userId}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`
    );
    // Lock will auto-expire due to TTL, so failure is not critical
  }
}

/**
 * Submit an entry to a crucible
 */
export const submitEntry = async ({
  crucibleId,
  imageId,
  userId,
}: SubmitEntrySchema & { userId: number }) => {
  // Acquire distributed lock to prevent race conditions on entry limit
  const lockAcquired = await acquireEntryLock(crucibleId, userId);
  if (!lockAcquired) {
    return throwBadRequestError(
      'Entry submission in progress. Please wait a moment and try again.'
    );
  }

  try {
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
        `You have reached the maximum of ${crucible.entryLimit} ${
          crucible.entryLimit === 1 ? 'entry' : 'entries'
        } for this crucible`
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

    // Validate allowed resources if specified
    // allowedResources is an array of model version IDs that the crucible restricts entries to
    const allowedResources = crucible.allowedResources as number[] | null;
    if (allowedResources && allowedResources.length > 0) {
      // Fetch the image's resources from cache
      const resourcesData = await imageResourcesCache.fetch([imageId]);
      const imageResources = resourcesData[imageId]?.resources ?? [];

      if (imageResources.length === 0) {
        return throwBadRequestError(
          'This image has no detected resources. Images submitted to this crucible must use specific resources.'
        );
      }

      // Check if any of the image's resources are in the allowed list
      const imageVersionIds = imageResources.map((r) => r.modelVersionId);
      const hasAllowedResource = imageVersionIds.some((versionId) =>
        allowedResources.includes(versionId)
      );

      if (!hasAllowedResource) {
        return throwBadRequestError(
          'This image does not use any of the required resources for this crucible. Please check the crucible requirements and submit an image that uses an allowed resource.'
        );
      }
    }

    // Handle entry fee collection (if entryFee > 0)
    let buzzTransactionId: string | null = null;

    if (crucible.entryFee > 0) {
      // Check if user has sufficient Buzz
      const userAccount = await getUserBuzzAccount({
        accountId: userId,
        accountTypes: ['yellow', 'green'],
      });
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
    // Wrap in try/catch to refund entry fee if database write fails
    try {
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
          log(
            `Failed to send entry notification: ${
              err instanceof Error ? err.message : 'Unknown error'
            }`
          );
        });
      }

      return entry;
    } catch (error) {
      // Database write failed - refund entry fee if it was charged
      if (buzzTransactionId) {
        try {
          await refundMultiAccountTransaction({
            externalTransactionIdPrefix: buzzTransactionId,
            description: 'Crucible entry fee refund - database write failed',
            details: {
              entityId: crucibleId,
              entityType: 'Crucible',
            },
          });
          log(
            `Refunded entry fee for user ${userId} after database failure (transaction: ${buzzTransactionId})`
          );
        } catch (refundError) {
          const refundErrorMsg =
            refundError instanceof Error ? refundError.message : 'Unknown error';
          log(
            `CRITICAL: Failed to refund entry fee for user ${userId} after database failure: ${refundErrorMsg}`
          );
          // Re-throw original error even if refund fails so user is aware of the failure
        }
      }
      // Re-throw the original error
      throw error;
    }
  } finally {
    // Always release the lock, even if an error occurs
    await releaseEntryLock(crucibleId, userId);
  }
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
  // sysRedis.sAdd accepts either a single value or array (see CustomRedisClient interface)
  await sysRedis.sAdd(key, pairKey);
  // Set TTL to 30 days (for crucible cleanup)
  await sysRedis.expire(key, 30 * 24 * 60 * 60);
}

/**
 * Redis key for tracking unique judges (voters) per crucible
 */
function getJudgesKey(crucibleId: number): RedisKeyTemplateSys {
  return `${REDIS_SYS_KEYS.CRUCIBLE.JUDGES}:${crucibleId}` as RedisKeyTemplateSys;
}

/**
 * Add a user to the judges set for a crucible (called when user first votes)
 */
export async function addJudge(crucibleId: number, userId: number): Promise<void> {
  const key = getJudgesKey(crucibleId);
  await sysRedis.sAdd(key, userId.toString());
  // Set TTL to 30 days (for crucible cleanup)
  await sysRedis.expire(key, 30 * 24 * 60 * 60);
}

/**
 * Get the count of unique judges for a crucible
 */
export async function getJudgesCount(crucibleId: number): Promise<number> {
  const key = getJudgesKey(crucibleId);
  return await sysRedis.sCard(key);
}

/**
 * Redis key for tracking user vote counts
 */
function getUserVotesKey(): RedisKeyTemplateSys {
  return REDIS_SYS_KEYS.CRUCIBLE.USER_VOTES as RedisKeyTemplateSys;
}

/**
 * Increment a user's total vote count across all crucibles
 */
export async function incrementUserVoteCount(userId: number): Promise<number> {
  const key = getUserVotesKey();
  return await sysRedis.hIncrBy(key, userId.toString(), 1);
}

/**
 * Get a user's total vote count across all crucibles
 */
export async function getUserVoteCount(userId: number): Promise<number> {
  const key = getUserVotesKey();
  const count = await sysRedis.hGet<string>(key, userId.toString());
  return count ? parseInt(count, 10) : 0;
}

/**
 * Get all user vote counts (for calculating rankings)
 * Returns array of [userId, voteCount] pairs sorted by vote count descending
 */
export async function getAllUserVoteCounts(): Promise<Array<[number, number]>> {
  const key = getUserVotesKey();
  const counts = await sysRedis.hGetAll<string>(key);

  const entries: Array<[number, number]> = [];
  for (const [userIdStr, countStr] of Object.entries(counts)) {
    const userId = parseInt(userIdStr, 10);
    const count = parseInt(countStr as string, 10);
    if (!isNaN(userId) && !isNaN(count)) {
      entries.push([userId, count]);
    }
  }

  // Sort by count descending
  entries.sort((a, b) => b[1] - a[1]);
  return entries;
}

/**
 * Get user judge stats for the rating page
 * Returns: total pairs rated, judge ranking percentile, influence score
 */
export async function getUserJudgeStats(userId: number): Promise<{
  totalPairsRated: number;
  judgeRankingPercentile: number;
  influenceScore: number;
}> {
  const [userVoteCount, allCounts] = await Promise.all([
    getUserVoteCount(userId),
    getAllUserVoteCounts(),
  ]);

  // Calculate ranking percentile
  let judgeRankingPercentile = 0;
  if (allCounts.length > 0 && userVoteCount > 0) {
    // Find user's rank
    const userRank = allCounts.findIndex(([id]) => id === userId);
    if (userRank !== -1) {
      // Percentile = ((total - rank) / total) * 100
      // E.g., if rank 10 out of 100, percentile = 90 (top 10%)
      judgeRankingPercentile = Math.round(((allCounts.length - userRank) / allCounts.length) * 100);
    }
  }

  // Calculate influence score
  // Base formula: Each 10 votes = 1 influence point, with diminishing returns
  // sqrt(votes) * 10 gives nice scaling: 100 votes = 100 influence, 400 votes = 200 influence
  const influenceScore = Math.round(Math.sqrt(userVoteCount) * 10);

  return {
    totalPairsRated: userVoteCount,
    judgeRankingPercentile,
    influenceScore,
  };
}

/**
 * Check multiple pairs for voted status in parallel
 * Uses SISMEMBER for each pair in parallel for better performance
 */
async function arePairsVoted(
  crucibleId: number,
  userId: number,
  pairs: Array<{ entryId1: number; entryId2: number }>
): Promise<boolean[]> {
  const key = getVotedPairsKey(crucibleId, userId);
  const results = await Promise.all(
    pairs.map(async ({ entryId1, entryId2 }) => {
      const pairKey = createPairKey(entryId1, entryId2);
      return await sysRedis.sIsMember(key, pairKey);
    })
  );
  // sIsMember returns 1 if member exists, 0 if not - convert to boolean
  return results.map((result) => Boolean(result));
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

// Constants for sampling in getJudgingPair
const SAMPLE_SIZE = 100; // Number of candidates to fetch per attempt
const MAX_SAMPLE_ATTEMPTS = 3; // Maximum sampling attempts before giving up

/**
 * Raw SQL query result for entry sampling
 */
type RawEntrySample = {
  id: number;
  imageId: number;
  userId: number;
  score: number;
  image_id: number;
  image_url: string;
  image_width: number | null;
  image_height: number | null;
  image_nsfwLevel: number;
  user_id: number;
  user_username: string | null;
  user_deletedAt: Date | null;
  user_image: string | null;
};

/**
 * Fetch a random sample of entries for judging from the database
 * Uses ORDER BY RANDOM() LIMIT for efficient sampling
 * Excludes the current user's entries and optionally specified entry IDs in the SQL query
 */
async function fetchEntrySample(
  crucibleId: number,
  userId: number,
  sampleSize: number,
  excludeEntryIds?: number[]
): Promise<EntryForJudging[]> {
  // Use raw SQL for efficient random sampling
  // This avoids loading all entries into memory
  // If excludeEntryIds is provided and non-empty, exclude those entries
  const hasExclusions = excludeEntryIds && excludeEntryIds.length > 0;

  const rawEntries = hasExclusions
    ? await dbRead.$queryRaw<RawEntrySample[]>`
        SELECT
          ce.id,
          ce."imageId",
          ce."userId",
          ce.score,
          i.id as image_id,
          i.url as image_url,
          i.width as image_width,
          i.height as image_height,
          i."nsfwLevel" as "image_nsfwLevel",
          u.id as user_id,
          u.username as user_username,
          u."deletedAt" as "user_deletedAt",
          u.image as user_image
        FROM "CrucibleEntry" ce
        JOIN "Image" i ON i.id = ce."imageId"
        JOIN "User" u ON u.id = ce."userId"
        WHERE ce."crucibleId" = ${crucibleId}
          AND ce."userId" != ${userId}
          AND ce.id NOT IN (${Prisma.join(excludeEntryIds!)})
        ORDER BY RANDOM()
        LIMIT ${sampleSize}
      `
    : await dbRead.$queryRaw<RawEntrySample[]>`
        SELECT
          ce.id,
          ce."imageId",
          ce."userId",
          ce.score,
          i.id as image_id,
          i.url as image_url,
          i.width as image_width,
          i.height as image_height,
          i."nsfwLevel" as "image_nsfwLevel",
          u.id as user_id,
          u.username as user_username,
          u."deletedAt" as "user_deletedAt",
          u.image as user_image
        FROM "CrucibleEntry" ce
        JOIN "Image" i ON i.id = ce."imageId"
        JOIN "User" u ON u.id = ce."userId"
        WHERE ce."crucibleId" = ${crucibleId}
          AND ce."userId" != ${userId}
        ORDER BY RANDOM()
        LIMIT ${sampleSize}
      `;

  // Transform raw SQL results to EntryForJudging type
  return rawEntries.map((raw) => ({
    id: raw.id,
    imageId: raw.imageId,
    userId: raw.userId,
    score: raw.score,
    image: {
      id: raw.image_id,
      url: raw.image_url,
      width: raw.image_width,
      height: raw.image_height,
      nsfwLevel: raw.image_nsfwLevel,
    },
    user: {
      id: raw.user_id,
      username: raw.user_username,
      deletedAt: raw.user_deletedAt,
      image: raw.user_image,
    },
  }));
}

/**
 * Get a pair of entries for judging
 *
 * PERFORMANCE OPTIMIZATION:
 * - Uses database-level random sampling instead of loading all entries
 * - Fetches only ~100 candidate entries per request (not all entries)
 * - Retries up to 3 times if no valid pair found in sample
 *
 * Selection algorithm:
 * 1. Fetch a random sample of eligible entries (excludes user's own entries)
 * 2. Image A: Weighted by lowest ELO deviation (prioritize under-voted entries near 1500)
 * 3. Image B: Based on voting phase of Image A (estimated from ELO deviation):
 *    - Calibration (deviation 0-50): Pick anchor (high deviation, established ELO)
 *    - Discovery (deviation 50-150): Pick uncertain (similar uncertain ELO)
 *    - Optimization (deviation >150): Pick similar ELO
 * 4. Exclude pairs the user has already voted on
 * 5. Randomize left/right position
 */
export const getJudgingPair = async ({
  crucibleId,
  userId,
  excludeEntryIds,
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

  // Get all ELO scores from Redis for this crucible
  // This is efficient as it's a single Redis HGETALL operation
  const redisElos = await getAllEntryElos(crucibleId);

  let imageA: EntryForJudging | null = null;
  let imageB: EntryForJudging | null = null;

  // Try multiple sampling attempts if no valid pair found
  for (let attempt = 0; attempt < MAX_SAMPLE_ATTEMPTS; attempt++) {
    // Fetch a random sample of entries (excludes user's own entries and any specified excluded entries in SQL)
    const sampleEntries = await fetchEntrySample(crucibleId, userId, SAMPLE_SIZE, excludeEntryIds);

    // Need at least 2 entries to form a pair
    if (sampleEntries.length < 2) {
      return null;
    }

    // Merge Redis ELO scores into entries (fallback to database score if Redis entry is missing)
    const entries: EntryForJudging[] = sampleEntries.map((entry) => ({
      ...entry,
      score: redisElos[entry.id] ?? entry.score, // Use Redis ELO if available, else DB fallback (1500)
    }));

    // Step 1: Select Image A - weighted by lowest ELO deviation (closest to 1500)
    // Sort by ELO deviation ascending, then add some randomness among entries with similar deviation
    // Sort in place to avoid creating a new array
    entries.sort((a, b) => getEloDeviation(a.score) - getEloDeviation(b.score));

    // Get the minimum deviation
    const minDeviation = getEloDeviation(entries[0].score);

    // Find entries with deviation close to minimum (within 30 ELO points)
    // Use indices to avoid creating intermediate arrays
    let lowDeviationEndIndex = 0;
    for (let i = 0; i < entries.length; i++) {
      if (getEloDeviation(entries[i].score) <= minDeviation + 30) {
        lowDeviationEndIndex = i + 1;
      } else {
        break;
      }
    }

    // Shuffle the low deviation pool in place using Fisher-Yates
    for (let i = lowDeviationEndIndex - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [entries[i], entries[j]] = [entries[j], entries[i]];
    }

    // Try each candidate A from the low deviation pool
    for (let aIdx = 0; aIdx < lowDeviationEndIndex; aIdx++) {
      const candidateA = entries[aIdx];
      const phase = getVotingPhase(getEloDeviation(candidateA.score));

      // Get candidate B pool based on phase (excludes imageA, but not voted pairs yet)
      const candidateBPool = getCandidateBPool(entries, candidateA, phase);

      if (candidateBPool.length === 0) {
        continue; // No valid B candidates for this A, try next A
      }

      // Shuffle B pool in place using Fisher-Yates
      for (let i = candidateBPool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [candidateBPool[i], candidateBPool[j]] = [candidateBPool[j], candidateBPool[i]];
      }

      // Batch check which pairs have been voted on using SISMEMBER (O(1) per check, parallel)
      const pairsToCheck = candidateBPool.map((candidateB) => ({
        entryId1: candidateA.id,
        entryId2: candidateB.id,
      }));
      const votedStatuses = await arePairsVoted(crucibleId, userId, pairsToCheck);

      // Find first candidate B that hasn't been voted on
      for (let i = 0; i < candidateBPool.length; i++) {
        if (!votedStatuses[i]) {
          imageA = candidateA;
          imageB = candidateBPool[i];
          break;
        }
      }

      if (imageA && imageB) break;
    }

    // Found a valid pair
    if (imageA && imageB) break;

    // No valid pair in this sample, try another sample
    log(
      `Attempt ${attempt + 1}: No valid pair found in sample of ${
        sampleEntries.length
      } entries for crucible ${crucibleId}`
    );
  }

  // If no valid pair found after all attempts
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
 * Note: Does NOT filter by voted pairs - that check happens asynchronously via SISMEMBER
 */
function getCandidateBPool(
  entries: EntryForJudging[],
  imageA: EntryForJudging,
  phase: 'calibration' | 'discovery' | 'optimization'
): EntryForJudging[] {
  // Filter out Image A only - voted pair check happens asynchronously
  const validCandidates = entries.filter((entry) => entry.id !== imageA.id);

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
  // Note: voteCount is now read from Redis, not DB
  const [winnerEntry, loserEntry] = await Promise.all([
    dbRead.crucibleEntry.findUnique({
      where: { id: winnerEntryId },
      select: { id: true, crucibleId: true, userId: true },
    }),
    dbRead.crucibleEntry.findUnique({
      where: { id: loserEntryId },
      select: { id: true, crucibleId: true, userId: true },
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

  // Race condition protection: Atomically mark the pair as voted before processing
  // Use SADD to add to the set - if it returns 0, the pair was already added (duplicate vote)
  // Note: sysRedis.sAdd accepts either a single value or array (see CustomRedisClient interface)
  const key = getVotedPairsKey(crucibleId, userId);
  const pairKey = createPairKey(winnerEntryId, loserEntryId);
  const addResult = await sysRedis.sAdd(key, pairKey);
  await sysRedis.expire(key, 30 * 24 * 60 * 60); // 30 days TTL

  if (addResult === 0) {
    // User has already voted on this pair
    throw throwBadRequestError(
      'You have already voted on this pair. Please wait for the next pair to load.'
    );
  }

  // Get current vote counts from Redis (for K-factor calculation)
  const [winnerVoteCount, loserVoteCount] = await Promise.all([
    crucibleEloRedis.getVoteCount(crucibleId, winnerEntryId),
    crucibleEloRedis.getVoteCount(crucibleId, loserEntryId),
  ]);

  // Update ELO scores in Redis using processVote from crucible-elo.service
  const { winnerElo, loserElo } = await processEloVote(
    crucibleId,
    winnerEntryId,
    loserEntryId,
    winnerVoteCount,
    loserVoteCount
  );

  // Increment voteCount on both entries in Redis (not DB)
  // Vote counts are synced to PostgreSQL on finalization
  // Also track unique judge and user's total vote count (fire-and-forget)
  await Promise.all([
    crucibleEloRedis.incrementVoteCount(crucibleId, winnerEntryId),
    crucibleEloRedis.incrementVoteCount(crucibleId, loserEntryId),
    addJudge(crucibleId, userId),
    incrementUserVoteCount(userId),
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
  voteCount: number;
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
    remainder >= 11 && remainder <= 13 ? 'th' : suffixes[Math.min(position % 10, 4)] || 'th';
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
export const finalizeCrucible = async (crucibleId: number): Promise<FinalizeCrucibleResult> => {
  // Fetch the crucible metadata (without loading all entries into memory)
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
      _count: {
        select: { entries: true },
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

  // Get entry count from aggregation (no memory impact)
  const entryCount = crucible._count.entries;

  // Calculate total prize pool
  const totalPrizePool = crucible.entryFee * entryCount;

  // Parse prize positions from JSON
  const prizePositions = parsePrizePositions(crucible.prizePositions);

  // Sort prize positions by position number
  const sortedPrizePositions = [...prizePositions].sort((a, b) => a.position - b.position);

  // ============================================================================
  // Edge Case: 0 entries
  // ============================================================================
  if (entryCount === 0) {
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
      log(
        `Failed to send crucible-ended notification: ${
          err instanceof Error ? err.message : 'Unknown error'
        }`
      );
    });

    return {
      crucibleId,
      totalPrizePool: 0,
      finalEntries: [],
      totalPrizesDistributed: 0,
    };
  }

  // Get all ELO scores and vote counts from Redis
  const [redisElos, redisVoteCounts] = await Promise.all([
    getAllEntryElos(crucibleId),
    crucibleEloRedis.getAllVoteCounts(crucibleId),
  ]);

  // Load entries using cursor-based pagination to avoid loading all entries into memory
  // Batch size of 500 entries per query for efficient memory usage
  const FETCH_BATCH_SIZE = 500;
  const allEntries: Array<{
    id: number;
    userId: number;
    score: number;
    createdAt: Date;
  }> = [];

  let cursor: number | undefined;
  while (true) {
    const batch = await dbRead.crucibleEntry.findMany({
      where: { crucibleId },
      select: {
        id: true,
        userId: true,
        score: true,
        createdAt: true,
      },
      take: FETCH_BATCH_SIZE,
      cursor: cursor ? { id: cursor } : undefined,
      skip: cursor ? 1 : 0, // Skip the cursor entry itself
      orderBy: { id: 'asc' }, // Order by ID for cursor consistency
    });

    if (batch.length === 0) break;

    allEntries.push(...batch);
    cursor = batch[batch.length - 1].id;

    log(
      `Loaded batch of ${batch.length} entries (total so far: ${allEntries.length}/${entryCount})`
    );
  }

  // ============================================================================
  // Edge Case: 1 entry (auto-win)
  // ============================================================================
  if (allEntries.length === 1) {
    log(`Edge case: Crucible ${crucibleId} has 1 entry - auto-win for entry ${allEntries[0].id}`);
  }

  // Combine database entries with Redis ELO scores
  // If an entry doesn't have a Redis score, use the database score (1500 default)
  const entriesWithElo = allEntries.map((entry) => ({
    entryId: entry.id,
    userId: entry.userId,
    finalScore: redisElos[entry.id] ?? entry.score,
    voteCount: redisVoteCounts[entry.id] ?? 0,
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
      log(
        `Edge case: Crucible ${crucibleId} - ${entries.length} entries tied at ELO ${score} (entry IDs: ${entryIds}). Resolved by entry time (earlier entry wins).`
      );
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
      voteCount: entry.voteCount,
      position,
      prizeAmount,
    };
  });

  // Calculate total prizes distributed (for verification)
  const totalPrizesDistributed = finalizedEntries.reduce(
    (sum, entry) => sum + entry.prizeAmount,
    0
  );

  // Update all entries using raw SQL bulk update for performance
  // This syncs vote counts from Redis to PostgreSQL for persistence
  // Uses Postgres UPDATE ... FROM (VALUES ...) pattern for bulk updates
  // Batch size of 500 balances query complexity with DB round trips
  const UPDATE_BATCH_SIZE = 500;

  for (let i = 0; i < finalizedEntries.length; i += UPDATE_BATCH_SIZE) {
    const batch = finalizedEntries.slice(i, i + UPDATE_BATCH_SIZE);

    // Build VALUES list for bulk update: (entryId, finalScore, position, voteCount)
    // Use Prisma.sql for safe parameter binding
    const valuesList = batch.map(
      (entry) =>
        Prisma.sql`(${entry.entryId}::int, ${entry.finalScore}::int, ${entry.position}::int, ${entry.voteCount}::int)`
    );

    // Execute bulk update using UPDATE ... FROM (VALUES ...) pattern
    // This reduces N queries to 1 query per batch
    await dbWrite.$executeRaw`
      UPDATE "CrucibleEntry" AS ce
      SET
        score = v.score,
        position = v.position,
        "voteCount" = v."voteCount"
      FROM (VALUES ${Prisma.join(valuesList)}) AS v(id, score, position, "voteCount")
      WHERE ce.id = v.id
    `;

    log(
      `Updated batch of ${batch.length} entries (${i + batch.length}/${finalizedEntries.length})`
    );
  }

  // Update crucible status to completed (separate transaction after all entries)
  await dbWrite.crucible.update({
    where: { id: crucibleId },
    data: {
      status: CrucibleStatus.Completed,
    },
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
        `Failed to distribute prizes for crucible ${crucibleId}: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
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

  log(
    `Finalized crucible ${crucibleId}: ${finalizedEntries.length} entries, ${totalPrizesDistributed} Buzz in prizes`
  );

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
    log(
      `Failed to send crucible-ended notification: ${
        err instanceof Error ? err.message : 'Unknown error'
      }`
    );
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
      log(
        `Failed to send crucible-won notification to user ${participantUserId}: ${
          err instanceof Error ? err.message : 'Unknown error'
        }`
      );
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
}: CancelCrucibleSchema & {
  userId: number;
  isModerator: boolean;
}): Promise<CancelCrucibleResult> => {
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
      buzzTransactionId: true, // Creator setup fee transaction
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

  // Refund entry fees in parallel with concurrency limit of 10
  // This prevents timeout issues with large crucibles while avoiding overwhelming the system
  const limit = plimit(10);
  const refundResults = await Promise.allSettled(
    crucible.entries
      .filter((entry) => entry.buzzTransactionId !== null) // Only process entries with transaction IDs
      .map((entry) =>
        limit(async () => {
          try {
            // Refund using the stored transaction prefix
            await refundMultiAccountTransaction({
              externalTransactionIdPrefix: entry.buzzTransactionId!,
              description: 'Crucible entry fee refund - crucible cancelled',
              details: {
                entityId: crucible.id,
                entityType: 'Crucible',
                reason: 'cancellation',
              },
            });

            log(`Refunded entry ${entry.id} for user ${entry.userId}: ${crucible.entryFee} Buzz`);

            return { success: true, entry };
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            log(`Failed to refund entry ${entry.id} for user ${entry.userId}: ${errorMessage}`);

            return {
              success: false,
              entry,
              error: errorMessage,
            };
          }
        })
      )
  );

  // Process refund results
  for (const result of refundResults) {
    if (result.status === 'fulfilled') {
      const refundResult = result.value;
      if (refundResult.success) {
        refundedEntries++;
        totalRefunded += crucible.entryFee;
      } else {
        failedRefunds.push({
          entryId: refundResult.entry.id,
          userId: refundResult.entry.userId,
          error: refundResult.error!,
        });
      }
    }
  }

  // Refund creator setup fee if transaction ID exists
  let creatorSetupFeeRefunded = false;
  if (crucible.buzzTransactionId) {
    try {
      await refundMultiAccountTransaction({
        externalTransactionIdPrefix: crucible.buzzTransactionId,
        description: 'Crucible creator setup fee refund - crucible cancelled',
        details: {
          entityId: crucible.id,
          entityType: 'Crucible',
          reason: 'cancellation',
        },
      });

      creatorSetupFeeRefunded = true;
      log(
        `Refunded creator setup fee for crucible ${id} (transaction: ${crucible.buzzTransactionId})`
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Failed to refund creator setup fee for crucible ${id}: ${errorMessage}`);
      // Note: We don't add this to failedRefunds array as it's separate from entry refunds
      // The cancellation should still proceed even if the setup fee refund fails
    }
  } else {
    log(`No creator setup fee to refund for crucible ${id} (free crucible or legacy)`);
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
    `Cancelled crucible ${id}: ${refundedEntries} entries refunded, ${totalRefunded} Buzz total, ${failedRefunds.length} failed, setup fee refunded: ${creatorSetupFeeRefunded}`
  );

  return {
    crucibleId: id,
    refundedEntries,
    totalRefunded,
    failedRefunds,
  };
};

// ============================================================================
// User Crucible Stats
// ============================================================================

/**
 * Get user's crucible stats for the discovery page welcome section
 *
 * Stats include:
 * - Total crucibles entered (not created)
 * - Total Buzz won from crucible prizes
 * - Best placement (lowest position number)
 * - Win rate (percentage of crucibles where user placed in prize positions)
 */
export const getUserCrucibleStats = async ({
  userId,
}: {
  userId: number;
}): Promise<{
  totalCrucibles: number;
  buzzWon: number;
  bestPlacement: number | null;
  winRate: number;
}> => {
  // Get all entries for this user in completed crucibles
  const entries = await dbRead.crucibleEntry.findMany({
    where: {
      userId,
      crucible: {
        status: CrucibleStatus.Completed,
      },
    },
    select: {
      id: true,
      position: true,
      crucibleId: true,
      crucible: {
        select: {
          prizePositions: true,
        },
      },
    },
  });

  if (entries.length === 0) {
    return {
      totalCrucibles: 0,
      buzzWon: 0,
      bestPlacement: null,
      winRate: 0,
    };
  }

  // Calculate unique crucibles entered
  const uniqueCrucibleIds = new Set(entries.map((e) => e.crucibleId));
  const totalCrucibles = uniqueCrucibleIds.size;

  // Calculate best placement (lowest non-null position)
  const positions = entries.map((e) => e.position).filter((p): p is number => p !== null);
  const bestPlacement = positions.length > 0 ? Math.min(...positions) : null;

  // Calculate win rate (per crucible, not per entry)
  // Get the best entry per crucible
  const bestEntryPerCrucible = new Map<number, number | null>();
  for (const entry of entries) {
    const current = bestEntryPerCrucible.get(entry.crucibleId);
    if (
      current === undefined ||
      (entry.position !== null && (current === null || entry.position < current))
    ) {
      bestEntryPerCrucible.set(entry.crucibleId, entry.position);
    }
  }

  let cruciblesWon = 0;
  for (const [crucibleId, bestPosition] of bestEntryPerCrucible) {
    if (bestPosition !== null) {
      const entry = entries.find((e) => e.crucibleId === crucibleId);
      if (entry) {
        const prizePositions = parsePrizePositions(entry.crucible.prizePositions);
        const isWinner = prizePositions.some((p) => p.position === bestPosition);
        if (isWinner) {
          cruciblesWon++;
        }
      }
    }
  }

  const winRate = totalCrucibles > 0 ? Math.round((cruciblesWon / totalCrucibles) * 100) : 0;

  // Calculate total Buzz won
  // Query buzz transactions for crucible prizes
  // Note: Prize transactions have type 'Reward' and description matching 'Crucible prize'
  const buzzWonResult = await dbRead.$queryRaw<[{ total: bigint }]>`
    SELECT COALESCE(SUM(amount), 0) as total
    FROM "BuzzTransaction"
    WHERE "toUserId" = ${userId}
      AND type = 'Reward'
      AND description LIKE 'Crucible prize%'
  `;

  const buzzWon = Number(buzzWonResult[0]?.total ?? 0);

  return {
    totalCrucibles,
    buzzWon,
    bestPlacement,
    winRate,
  };
};

// ============================================================================
// User Active Crucibles
// ============================================================================

/**
 * Format time remaining until end date
 */
function formatTimeRemaining(endAt: Date): string {
  const now = new Date();
  const diffMs = endAt.getTime() - now.getTime();

  if (diffMs <= 0) return 'Ended';

  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 0) {
    return `${diffDays} day${diffDays === 1 ? '' : 's'}`;
  }

  if (diffHours > 0) {
    return `${diffHours} hour${diffHours === 1 ? '' : 's'}`;
  }

  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  return `${diffMinutes} min${diffMinutes === 1 ? '' : 's'}`;
}

/**
 * Get user's active crucibles they have entries in
 *
 * Returns crucibles with:
 * - Basic crucible info (id, name, cover image)
 * - User's current position (best position among their entries)
 * - Prize pool (total entry fees)
 * - Time remaining
 */
export const getUserActiveCrucibles = async ({
  userId,
}: {
  userId: number;
}): Promise<
  Array<{
    id: number;
    name: string;
    prizePool: number;
    timeRemaining: string;
    endAt: Date | null;
    position: number | null;
    imageUrl: string | null;
  }>
> => {
  // Get all entries for this user in active crucibles
  const entries = await dbRead.crucibleEntry.findMany({
    where: {
      userId,
      crucible: {
        status: CrucibleStatus.Active,
      },
    },
    select: {
      id: true,
      position: true,
      crucibleId: true,
      crucible: {
        select: {
          id: true,
          name: true,
          entryFee: true,
          endAt: true,
          image: {
            select: {
              url: true,
            },
          },
          _count: {
            select: {
              entries: true,
            },
          },
        },
      },
    },
    orderBy: {
      crucible: {
        endAt: 'asc', // Closest to ending first
      },
    },
  });

  if (entries.length === 0) {
    return [];
  }

  // Group entries by crucible and find best position
  const crucibleMap = new Map<
    number,
    {
      id: number;
      name: string;
      prizePool: number;
      timeRemaining: string;
      endAt: Date | null;
      position: number | null;
      imageUrl: string | null;
    }
  >();

  for (const entry of entries) {
    const crucibleId = entry.crucibleId;
    const existing = crucibleMap.get(crucibleId);

    // Calculate best position for this crucible
    const currentBestPosition = existing?.position ?? null;
    let newBestPosition = currentBestPosition;

    if (entry.position !== null) {
      if (currentBestPosition === null || entry.position < currentBestPosition) {
        newBestPosition = entry.position;
      }
    }

    // Only add/update if not already in map or we have a better position
    if (!existing || newBestPosition !== currentBestPosition) {
      const prizePool = entry.crucible.entryFee * entry.crucible._count.entries;
      const timeRemaining = entry.crucible.endAt
        ? formatTimeRemaining(entry.crucible.endAt)
        : 'No end date';

      crucibleMap.set(crucibleId, {
        id: entry.crucible.id,
        name: entry.crucible.name,
        prizePool,
        timeRemaining,
        endAt: entry.crucible.endAt,
        position: newBestPosition,
        imageUrl: entry.crucible.image?.url ?? null,
      });
    }
  }

  // Convert to array and sort by endAt (closest first)
  return Array.from(crucibleMap.values()).sort((a, b) => {
    if (!a.endAt) return 1;
    if (!b.endAt) return -1;
    return a.endAt.getTime() - b.endAt.getTime();
  });
};

// ============================================================================
// Featured Crucible
// ============================================================================

/**
 * Get the featured crucible for the discovery page
 *
 * Returns the active crucible with the highest prize pool (entry fee * entries count).
 * This will be displayed as a prominent hero card on the discovery page.
 *
 * Returns null if no active crucibles exist.
 */
export const getFeaturedCrucible = async (): Promise<{
  id: number;
  name: string;
  description: string;
  prizePool: number;
  timeRemaining: string;
  entriesCount: number;
  imageUrl: string | null;
} | null> => {
  // Get all active crucibles with their entry counts
  const activeCrucibles = await dbRead.crucible.findMany({
    where: {
      status: CrucibleStatus.Active,
    },
    select: {
      id: true,
      name: true,
      description: true,
      entryFee: true,
      endAt: true,
      image: {
        select: {
          url: true,
        },
      },
      _count: {
        select: {
          entries: true,
        },
      },
    },
  });

  if (activeCrucibles.length === 0) {
    return null;
  }

  // Calculate prize pool for each and find the one with the highest
  const cruciblesWithPrizePool = activeCrucibles.map((crucible) => ({
    ...crucible,
    prizePool: crucible.entryFee * crucible._count.entries,
  }));

  // Sort by prize pool descending, then by entry count descending (as tiebreaker)
  cruciblesWithPrizePool.sort((a, b) => {
    if (b.prizePool !== a.prizePool) {
      return b.prizePool - a.prizePool;
    }
    return b._count.entries - a._count.entries;
  });

  const featured = cruciblesWithPrizePool[0];

  return {
    id: featured.id,
    name: featured.name,
    description: featured.description ?? '',
    prizePool: featured.prizePool,
    timeRemaining: featured.endAt ? formatTimeRemaining(featured.endAt) : 'No end date',
    entriesCount: featured._count.entries,
    imageUrl: featured.image?.url ?? null,
  };
};

// ============================================================================
// Judge Stats
// ============================================================================

/**
 * Get judge stats for the rating page
 * Tracks global stats across all crucibles for the user
 */
export const getJudgeStats = async ({
  userId,
  crucibleId,
}: {
  userId: number;
  crucibleId: number;
}): Promise<{
  totalPairsRated: number;
  percentileRank: number | null;
  influenceScore: number;
}> => {
  // Get GLOBAL vote count for this user (across all crucibles)
  const [globalVoteCount, allUserCounts] = await Promise.all([
    getUserVoteCount(userId),
    getAllUserVoteCounts(),
  ]);

  // Calculate percentile rank among ALL judges globally
  let percentileRank: number | null = null;

  if (allUserCounts.length > 1 && globalVoteCount > 0) {
    // Find user's position in the sorted list
    const userRankIndex = allUserCounts.findIndex(([id]) => id === userId);

    if (userRankIndex !== -1) {
      // Calculate what percentile this user is in
      // e.g., if rank 10 out of 100, they're in top 10%
      const percentile = ((userRankIndex + 1) / allUserCounts.length) * 100;
      percentileRank = Math.ceil(percentile);
    }
  }

  // Influence score using sqrt scaling for diminishing returns
  // sqrt(votes) * 10 gives nice scaling: 100 votes = 100 influence, 400 votes = 200 influence
  const influenceScore = Math.round(Math.sqrt(globalVoteCount) * 10);

  return {
    totalPairsRated: globalVoteCount,
    percentileRank,
    influenceScore,
  };
};
