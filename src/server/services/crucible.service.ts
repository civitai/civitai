import { Prisma } from '@prisma/client';
import { isDefined } from '~/utils/type-guards';
import dayjs from '~/shared/utils/dayjs';
import plimit from 'p-limit';
import { Availability, CrucibleStatus, MediaType, ModelStatus } from '~/shared/utils/prisma/enums';
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
  CheckCrucibleEntryEligibilitySchema,
  CreateEntryPostSchema,
  GetCrucibleEntriesSchema,
  UpdateCrucibleSchema,
  GetCruciblesInfiniteSchema,
  GetCrucibleByIdSchema,
  CreateCrucibleInputSchema,
  SubmitEntrySchema,
  GetJudgingPairSchema,
  GetJudgingSuggestionsSchema,
  SubmitVoteSchema,
  CancelCrucibleSchema,
} from '../schema/crucible.schema';
import { calculateCrucibleSetupCost } from '../schema/crucible.schema';
import {
  clipLengthAllowed,
  crucibleRankingsAreFinal,
  crucibleSupportsVideoSettings,
  hasCrucibleStarted,
  isCustomPrizeDistribution,
} from '~/shared/constants/crucible.constants';
import type { VideoMetadata } from '~/server/schema/media.schema';
import { formatDuration } from '~/utils/number-helpers';
import {
  crucibleDetailSelect,
  type CrucibleDetailRow,
  crucibleEntrySelect,
  type CrucibleEntryRow,
  crucibleListSelect,
} from '~/server/selectors/crucible.selector';
import { publishedImageWhere } from '~/server/selectors/image.selector';
import type { RedisKeyTemplateSys, RedisKeyTemplateCache } from '~/server/redis/client';
import { redis, sysRedis, REDIS_SYS_KEYS, REDIS_KEYS } from '~/server/redis/client';
import { CacheTTL } from '~/server/common/constants';
import { fetchThroughCache } from '~/server/utils/cache-helpers';
import {
  getEntryElo,
  processVote as processEloVote,
  getAllEntryElos,
} from './crucible-elo.service';
import { crucibleEloRedis } from '~/server/redis/crucible-elo.redis';
import { Tracker } from '~/server/clickhouse/client';
import { createLogger } from '~/utils/logging';
import { createNotification } from '~/server/services/notification.service';
import { resolveCoverImageId } from '~/server/services/cover-image.service';
import {
  deriveDomainCurrency,
  isNonSfwForGreen,
} from '~/server/games/daily-challenge/challenge-currency';
import { getEffectiveBrowsingLevel } from '~/server/games/daily-challenge/challenge-visibility';
import { checkCrucibleSettings } from '~/server/schema/crucible.schema';
import { createPost } from '~/server/services/post.service';
import { NotificationCategory } from '~/server/common/enums';
import { imageResourcesCache } from '~/server/redis/caches';
import {
  getCruciblePrizeAmount,
  getCrucibleTotalPrizePool,
  parsePrizePositions,
  toCrucibleBuzzType,
} from '~/utils/crucible-helpers';
import { getBuzzApiStatus } from '~/server/utils/buzz-error';
import { throwOnBlockedUserContent } from '~/server/services/blocklist.service';
import { assertCanCreateCrucible } from '~/server/services/crucible-eligibility.service';
import { getProfanityFilter } from '~/libs/profanity-simple';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

const log = createLogger('crucible-service', 'cyan');

/**
 * Generate a unique transaction prefix for crucible setup fees
 * This prefix is used to identify and refund transactions if needed
 */
export const getCrucibleSetupTransactionPrefix = (userId: number): string => {
  return `crucible-setup-${userId}-${Date.now()}`;
};

/**
 * Prefix for the creator's seeded prize pool. Kept apart from the setup-fee prefix so the seed can
 * be returned on its own: the setup fee is revenue, the seed is prize money the crucible owes.
 */
export const getCrucibleSeedTransactionPrefix = (userId: number): string => {
  return `crucible-seed-${userId}-${Date.now()}`;
};

type CrucibleBuzzType = 'green' | 'yellow';

type CreatorCharge = { setupCost: number; seedAmount: number; details: MixedObject };

const refundCrucibleCharges = async (prefixes: string[], reason: string, details: MixedObject) => {
  for (const prefix of prefixes) {
    try {
      await refundMultiAccountTransaction({
        externalTransactionIdPrefix: prefix,
        description: `Crucible refund - ${reason}`,
        details: { entityType: 'Crucible', ...details },
      });
      log(`Refunded ${prefix} (${reason})`);
    } catch (refundError) {
      const refundErrorMsg = refundError instanceof Error ? refundError.message : 'Unknown error';
      log(`CRITICAL: Failed to refund ${prefix}: ${refundErrorMsg}`);
    }
  }
};

const assertCanAfford = async (userId: number, buzzType: CrucibleBuzzType, amount: number) => {
  if (amount <= 0) return;
  const [account] = await getUserBuzzAccount({ accountId: userId, accountTypes: [buzzType] });
  const balance = account?.balance ?? 0;
  if (balance < amount) {
    throwInsufficientFundsError(
      `You need ${amount.toLocaleString()} ${buzzType} Buzz for this crucible. You currently have ${balance.toLocaleString()} (${(
        amount - balance
      ).toLocaleString()} short).`
    );
  }
};

const chargeCrucibleCreator = async (
  userId: number,
  buzzType: CrucibleBuzzType,
  { setupCost, seedAmount, details }: CreatorCharge
) => {
  const charged: string[] = [];
  const charge = async (
    prefix: string,
    amount: number,
    type: TransactionType,
    description: string
  ) => {
    await createMultiAccountBuzzTransaction({
      fromAccountId: userId,
      fromAccountTypes: [buzzType],
      toAccountId: 0,
      amount,
      type,
      externalTransactionIdPrefix: prefix,
      description,
      details: { entityType: 'Crucible', ...details },
    });
    charged.push(prefix);
    return prefix;
  };

  try {
    const buzzTransactionId =
      setupCost > 0
        ? await charge(
            getCrucibleSetupTransactionPrefix(userId),
            setupCost,
            TransactionType.Fee,
            'Crucible creation fee'
          )
        : null;
    const seedTransactionId =
      seedAmount > 0
        ? await charge(
            getCrucibleSeedTransactionPrefix(userId),
            seedAmount,
            TransactionType.Purchase,
            'Crucible seeded prize pool'
          )
        : null;
    return { buzzTransactionId, seedTransactionId };
  } catch (error) {
    await refundCrucibleCharges(charged, 'charge failed', details);
    throw error;
  }
};

/**
 * Create a new crucible
 */
export const createCrucible = async ({
  userId,
  name,
  description,
  coverImage,
  heroImage,
  nsfwLevel,
  contentType,
  entryFee,
  entryLimit,
  maxTotalEntries,
  prizePositions,
  allowedResources,
  duration,
  seededPrizePool,
  minViewSeconds,
  maxClipSeconds,
  startAt: requestedStartAt,
  buzzType = 'yellow',
  isModerator = false,
}: CreateCrucibleInputSchema & {
  userId: number;
  buzzType?: CrucibleBuzzType;
  isModerator?: boolean;
}) => {
  if (!isModerator) await assertCanCreateCrucible(userId);
  if (isNonSfwForGreen(buzzType, nsfwLevel))
    throw throwBadRequestError('A green Buzz crucible can only allow PG and PG-13 content.');

  await throwOnBlockedUserContent([name, description], { isModerator, surface: 'crucible' });
  if (!isModerator) assertSfwCrucibleText([name, description], nsfwLevel);
  await assertPublishedModelVersions(allowedResources ?? []);

  const now = new Date();
  const isScheduled = !!requestedStartAt && requestedStartAt > now;
  const startAt = isScheduled ? requestedStartAt : now;
  const endAt = dayjs(startAt).add(duration, 'hours').toDate();
  const isVideoCrucible = crucibleSupportsVideoSettings(contentType);
  const requiresResources = (allowedResources?.length ?? 0) > 0;
  const prizeCustomized = isCustomPrizeDistribution(prizePositions);

  // The shared cover path queues the scan, so the cover gets its own rating instead of inheriting
  // the crucible's allowed levels.
  const imageId = await resolveCoverImageId({
    coverImage: { ...coverImage, type: MediaType.image },
    userId,
  });
  const heroImageId = heroImage
    ? await resolveCoverImageId({ coverImage: { ...heroImage, type: MediaType.image }, userId })
    : null;

  const setupCost = calculateCrucibleSetupCost(duration, prizeCustomized, requiresResources);
  const seedAmount = seededPrizePool ?? 0;
  await assertCanAfford(userId, buzzType, setupCost + seedAmount);

  // Inserted unpaid with no start before any Buzz moves: a failed insert costs nothing, and
  // activateScheduledCrucibles only opens a crucible whose start has passed.
  const created = await dbWrite.crucible.create({
    data: {
      userId,
      name,
      description: description ?? null,
      imageId,
      heroImageId,
      buzzType,
      nsfwLevel,
      contentType,
      entryFee,
      seededPrizePool: seedAmount,
      entryLimit,
      maxTotalEntries: maxTotalEntries ?? null,
      minViewSeconds: isVideoCrucible ? minViewSeconds ?? null : null,
      maxClipSeconds: isVideoCrucible ? maxClipSeconds ?? null : null,
      prizePositions: prizePositions as Prisma.JsonObject,
      allowedResources: requiresResources
        ? (allowedResources as Prisma.JsonArray)
        : Prisma.JsonNull,
      duration: duration * 60, // Convert hours to minutes for storage
      startAt: null,
      endAt: null,
      status: CrucibleStatus.Pending,
    },
  });

  const chargeDetails = { entityId: created.id, duration, prizeCustomized };
  let charges: Awaited<ReturnType<typeof chargeCrucibleCreator>>;
  try {
    charges = await chargeCrucibleCreator(userId, buzzType, {
      setupCost,
      seedAmount,
      details: chargeDetails,
    });
  } catch (error) {
    await dbWrite.crucible.delete({ where: { id: created.id } }).catch((deleteError) => {
      log(`CRITICAL: Failed to delete unpaid crucible ${created.id}: ${String(deleteError)}`);
    });
    throw error;
  }

  try {
    return await dbWrite.crucible.update({
      where: { id: created.id },
      data: {
        ...charges,
        startAt,
        endAt,
        status: isScheduled ? CrucibleStatus.Pending : CrucibleStatus.Active,
      },
    });
  } catch (error) {
    await refundCrucibleCharges(
      [charges.buzzTransactionId, charges.seedTransactionId].filter(isDefined),
      'database write failed',
      chargeDetails
    );
    await dbWrite.crucible.delete({ where: { id: created.id } }).catch(() => undefined);
    throw error;
  }
};

const levelsIntersecting = (level: number) =>
  Array.from({ length: 63 }, (_, i) => i + 1).filter((mask) => (mask & level) !== 0);

// throwOnBlockedUserContent doesn't catch profanity, so SFW-only crucibles check it here.
function assertSfwCrucibleText(texts: string[], nsfwLevel: number) {
  const isSfwOnly = (nsfwLevel & ~sfwBrowsingLevelsFlag) === 0;
  if (isSfwOnly && getProfanityFilter().isProfane(texts.join(' '))) {
    throw throwBadRequestError(
      "The name or description contains language that isn't allowed on a PG or PG-13 crucible."
    );
  }
}

async function assertPublishedModelVersions(versionIds: number[]) {
  const ids = [...new Set(versionIds)];
  if (!ids.length) return;
  const notPrivate = { not: Availability.Private };
  const published = await dbRead.modelVersion.count({
    where: {
      id: { in: ids },
      status: ModelStatus.Published,
      availability: notPrivate,
      model: { status: ModelStatus.Published, deletedAt: null, availability: notPrivate },
    },
  });
  if (published < ids.length)
    throw throwBadRequestError('Every required model must be a published, public model.');
}

const PRESENTATION_FIELDS = ['name', 'description', 'coverImage', 'heroImage'] as const;

/**
 * An upcoming crucible has no entries, so everything can change and any cost difference is
 * settled; once running only the presentation can, so the outcome stays fair.
 */
export const updateCrucible = async ({
  id,
  userId,
  isModerator = false,
  ...changes
}: UpdateCrucibleSchema & { userId: number; isModerator?: boolean }) => {
  const crucible = await dbRead.crucible.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      status: true,
      startAt: true,
      endAt: true,
      imageId: true,
      heroImageId: true,
      buzzType: true,
      nsfwLevel: true,
      name: true,
      description: true,
      contentType: true,
      entryFee: true,
      entryLimit: true,
      maxTotalEntries: true,
      minViewSeconds: true,
      maxClipSeconds: true,
      prizePositions: true,
      allowedResources: true,
      duration: true,
      seededPrizePool: true,
      buzzTransactionId: true,
      seedTransactionId: true,
    },
  });
  if (!crucible) throw throwNotFoundError('Crucible not found');

  const isOwner = crucible.userId === userId;
  if (!isOwner && !isModerator)
    throw throwAuthorizationError('You can only edit your own crucible');

  const hasEnded =
    crucible.status === CrucibleStatus.Completed ||
    crucible.status === CrucibleStatus.Cancelled ||
    (!!crucible.endAt && crucible.endAt <= new Date());
  if (hasEnded && !isModerator)
    throw throwBadRequestError('This crucible has ended and can no longer be edited');

  const hasStarted = hasCrucibleStarted(crucible);
  const canEditSettings = isOwner && !hasStarted;
  const provided = (Object.keys(changes) as (keyof typeof changes)[]).filter(
    (key) => changes[key] !== undefined
  );
  if (!canEditSettings) {
    const allowed: readonly string[] =
      isModerator && !hasStarted ? [...PRESENTATION_FIELDS, 'nsfwLevel'] : PRESENTATION_FIELDS;
    const locked = provided.filter((key) => !allowed.includes(key));
    if (locked.length)
      throw throwBadRequestError(
        `Once a crucible has started only its name, description and images can change (not ${locked.join(
          ', '
        )}).`
      );
  }

  const currentPositions = crucible.prizePositions as Record<string, number>;
  const current = {
    nsfwLevel: crucible.nsfwLevel,
    contentType: crucible.contentType as CreateCrucibleInputSchema['contentType'],
    entryFee: crucible.entryFee,
    entryLimit: crucible.entryLimit,
    maxTotalEntries: crucible.maxTotalEntries ?? undefined,
    minViewSeconds: crucible.minViewSeconds,
    maxClipSeconds: crucible.maxClipSeconds,
    prizePositions: currentPositions,
    allowedResources: Array.isArray(crucible.allowedResources)
      ? (crucible.allowedResources as number[])
      : [],
    duration: crucible.duration / 60,
    seededPrizePool: crucible.seededPrizePool,
  };
  const next = {
    ...current,
    ...Object.fromEntries(provided.map((key) => [key, changes[key]])),
  } as typeof current & { name?: string; description?: string };

  const buzzType = crucible.buzzType as CrucibleBuzzType;
  if (isNonSfwForGreen(buzzType, next.nsfwLevel))
    throw throwBadRequestError('A green Buzz crucible can only allow PG and PG-13 content.');
  assertCrucibleSettings(next);

  const nextName = changes.name ?? crucible.name;
  const nextDescription = changes.description ?? crucible.description ?? '';
  await throwOnBlockedUserContent([nextName, nextDescription], {
    isModerator,
    surface: 'crucible',
  });
  if (!isModerator) assertSfwCrucibleText([nextName, nextDescription], next.nsfwLevel);
  // Only newly added ones: a required model unpublished later shouldn't block editing the rest.
  await assertPublishedModelVersions(
    next.allowedResources.filter((versionId) => !current.allowedResources.includes(versionId))
  );

  const imageId = changes.coverImage
    ? await resolveCoverImageId({
        coverImage: { ...changes.coverImage, type: MediaType.image },
        userId: crucible.userId,
        currentCoverId: crucible.imageId,
      })
    : undefined;
  const heroImageId = changes.heroImage
    ? await resolveCoverImageId({
        coverImage: { ...changes.heroImage, type: MediaType.image },
        userId: crucible.userId,
        currentCoverId: crucible.heroImageId,
      })
    : undefined;

  const data: Prisma.CrucibleUpdateInput = {
    name: changes.name,
    description: changes.description,
    image: imageId ? { connect: { id: imageId } } : undefined,
    heroImage: heroImageId
      ? { connect: { id: heroImageId } }
      : changes.heroImage === null
      ? { disconnect: true }
      : undefined,
    nsfwLevel: changes.nsfwLevel,
  };

  let settlement: Awaited<ReturnType<typeof settleCrucibleCostChange>> = null;
  if (canEditSettings) {
    const isVideo = crucibleSupportsVideoSettings(next.contentType);
    Object.assign(data, {
      contentType: next.contentType,
      entryFee: next.entryFee,
      entryLimit: next.entryLimit,
      maxTotalEntries: next.maxTotalEntries ?? null,
      minViewSeconds: isVideo ? next.minViewSeconds ?? null : null,
      maxClipSeconds: isVideo ? next.maxClipSeconds ?? null : null,
      prizePositions: next.prizePositions as Prisma.JsonObject,
      allowedResources: next.allowedResources.length
        ? (next.allowedResources as Prisma.JsonArray)
        : Prisma.JsonNull,
      duration: next.duration * 60,
      seededPrizePool: next.seededPrizePool,
    });

    if (changes.startAt !== undefined || changes.duration !== undefined) {
      const now = new Date();
      const startAt =
        changes.startAt === undefined ? crucible.startAt ?? now : changes.startAt ?? now;
      const startsNow = startAt <= now;
      Object.assign(data, {
        startAt: startsNow ? now : startAt,
        endAt: dayjs(startsNow ? now : startAt)
          .add(next.duration, 'hours')
          .toDate(),
        status: startsNow ? CrucibleStatus.Active : CrucibleStatus.Pending,
      });
    }

    settlement = await settleCrucibleCostChange({
      userId: crucible.userId,
      crucibleId: crucible.id,
      buzzType,
      before: {
        setupCost: calculateCrucibleSetupCost(
          current.duration,
          isCustomPrizeDistribution(current.prizePositions),
          current.allowedResources.length > 0
        ),
        seedAmount: current.seededPrizePool,
        buzzTransactionId: crucible.buzzTransactionId,
        seedTransactionId: crucible.seedTransactionId,
      },
      after: {
        setupCost: calculateCrucibleSetupCost(
          next.duration,
          isCustomPrizeDistribution(next.prizePositions),
          next.allowedResources.length > 0
        ),
        seedAmount: next.seededPrizePool,
      },
    });
    if (settlement) Object.assign(data, settlement.data);
  }

  try {
    return await dbWrite.crucible.update({ where: { id }, data });
  } catch (error) {
    await settlement?.rollback();
    throw error;
  }
};

type CostLeg = 'setup' | 'seed';

const legTransactionIds = (
  legs: CostLeg[],
  charges: { buzzTransactionId: string | null; seedTransactionId: string | null }
) => ({
  ...(legs.includes('setup') && { buzzTransactionId: charges.buzzTransactionId }),
  ...(legs.includes('seed') && { seedTransactionId: charges.seedTransactionId }),
});

/**
 * A changed leg is refunded before its replacement is charged, so the creator only needs the
 * difference. Anything that fails after a refund charges the original amount back.
 */
async function settleCrucibleCostChange({
  userId,
  crucibleId,
  buzzType,
  before,
  after,
}: {
  userId: number;
  crucibleId: number;
  buzzType: CrucibleBuzzType;
  before: {
    setupCost: number;
    seedAmount: number;
    buzzTransactionId: string | null;
    seedTransactionId: string | null;
  };
  after: { setupCost: number; seedAmount: number };
}) {
  const amountOf = (source: { setupCost: number; seedAmount: number }, leg: CostLeg) =>
    leg === 'setup' ? source.setupCost : source.seedAmount;
  const legs = (['setup', 'seed'] as const).filter(
    (leg) => amountOf(before, leg) !== amountOf(after, leg)
  );
  if (!legs.length) return null;

  const total = (source: { setupCost: number; seedAmount: number }, only: readonly CostLeg[]) =>
    only.reduce((sum, leg) => sum + amountOf(source, leg), 0);
  await assertCanAfford(userId, buzzType, total(after, legs) - total(before, legs));

  const details = { entityId: crucibleId };
  const refunded: CostLeg[] = [];
  const restore = async () => {
    if (!refunded.length) return;
    try {
      const restored = await chargeCrucibleCreator(userId, buzzType, {
        setupCost: refunded.includes('setup') ? before.setupCost : 0,
        seedAmount: refunded.includes('seed') ? before.seedAmount : 0,
        details,
      });
      await dbWrite.crucible.update({
        where: { id: crucibleId },
        data: legTransactionIds(refunded, restored),
      });
    } catch (error) {
      log(
        `CRITICAL: Failed to restore the original charges on crucible ${crucibleId}: ${String(
          error
        )}`
      );
    }
  };

  try {
    for (const leg of legs) {
      const prefix = leg === 'setup' ? before.buzzTransactionId : before.seedTransactionId;
      if (prefix)
        await refundMultiAccountTransaction({
          externalTransactionIdPrefix: prefix,
          description: 'Crucible refund - crucible edited',
          details: { entityType: 'Crucible', ...details },
        });
      refunded.push(leg);
    }
    const charges = await chargeCrucibleCreator(userId, buzzType, {
      setupCost: legs.includes('setup') ? after.setupCost : 0,
      seedAmount: legs.includes('seed') ? after.seedAmount : 0,
      details,
    });
    return {
      data: legTransactionIds(legs, charges),
      rollback: async () => {
        await refundCrucibleCharges(
          [charges.buzzTransactionId, charges.seedTransactionId].filter(isDefined),
          'edit failed',
          details
        );
        await restore();
      },
    };
  } catch (error) {
    await restore();
    throw error;
  }
}

function assertCrucibleSettings(settings: Parameters<typeof checkCrucibleSettings>[0]) {
  const issue = checkCrucibleSettings(settings);
  if (issue) throw throwBadRequestError(issue.message);
}

export type CrucibleDetailEntry = Omit<CrucibleEntryRow, 'score' | 'position'> & {
  score: number | null;
  position: number | null;
};

export type CrucibleDetail = CrucibleDetailRow & {
  /** The caller's own entries; everyone else's are paged through `getCrucibleEntries`. */
  viewerEntries: CrucibleEntryRow[];
};

export const getCrucibleDetail = async ({
  id,
  userId,
}: GetCrucibleByIdSchema & { userId?: number }): Promise<CrucibleDetail | null> => {
  const crucible = await dbRead.crucible.findUnique({
    where: { id },
    select: crucibleDetailSelect,
  });

  if (!crucible) return null;

  const viewerEntries = userId
    ? await dbRead.crucibleEntry.findMany({
        where: { crucibleId: id, userId },
        select: crucibleEntrySelect,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })
    : [];

  return { ...crucible, viewerEntries };
};

export const getCrucibleEntries = async ({
  crucibleId,
  limit,
  cursor,
  seed = 0,
  userId,
}: GetCrucibleEntriesSchema & { userId?: number }) => {
  const crucible = await dbRead.crucible.findUnique({
    where: { id: crucibleId },
    select: { status: true },
  });
  if (!crucible) throw throwNotFoundError('Crucible not found');

  const rankingsFinal = crucibleRankingsAreFinal(crucible.status);
  const rows = rankingsFinal
    ? await dbRead.crucibleEntry.findMany({
        where: { crucibleId },
        select: crucibleEntrySelect,
        orderBy: [{ score: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
        take: limit + 1,
        cursor: cursor ? { id: cursor } : undefined,
      })
    : await getShuffledEntries({ crucibleId, limit: limit + 1, cursor, seed });

  const nextCursor = rows.length > limit ? rows.pop()?.id : undefined;
  const items: CrucibleDetailEntry[] = rankingsFinal
    ? rows
    : rows.map((entry) =>
        entry.userId === userId ? entry : { ...entry, score: null, position: null }
      );

  return { items, nextCursor };
};

/**
 * Never score order while running: a rank-ordered page leaks the live ranking even with the
 * scores redacted. The seed keeps one viewer's pages in a single order.
 */
const getShuffledEntries = async ({
  crucibleId,
  limit,
  cursor,
  seed,
}: {
  crucibleId: number;
  limit: number;
  cursor?: number;
  seed: number;
}) => {
  const salt = `:${seed}`;
  const ids = await dbRead.$queryRaw<{ id: number }[]>`
    SELECT id
    FROM "CrucibleEntry"
    WHERE "crucibleId" = ${crucibleId}
      ${
        cursor
          ? Prisma.sql`AND (md5(id::text || ${salt}), id) > (md5(${cursor}::int::text || ${salt}), ${cursor}::int)`
          : Prisma.empty
      }
    ORDER BY md5(id::text || ${salt}), id
    LIMIT ${limit}
  `;
  if (!ids.length) return [];

  const byId = new Map(
    (
      await dbRead.crucibleEntry.findMany({
        where: { id: { in: ids.map(({ id }) => id) } },
        select: crucibleEntrySelect,
      })
    ).map((entry) => [entry.id, entry])
  );
  return ids.map(({ id }) => byId.get(id)).filter(isDefined);
};

/**
 * Get crucibles with filters, sorting, and cursor pagination
 */
export const getCrucibles = async <TSelect extends Prisma.CrucibleSelect>({
  input: { cursor, limit: take, status, sort, contentType, browsingLevel },
  select,
  excludedUserIds = [],
  isModerator = false,
  viewerId,
  isGreen = false,
}: {
  input: GetCruciblesInfiniteSchema;
  select: TSelect;
  excludedUserIds?: number[];
  isModerator?: boolean;
  viewerId?: number;
  isGreen?: boolean;
}) => {
  const where: Prisma.CrucibleWhereInput = {};

  // As the challenges feed: the crucible's allowed levels and its cover's rating must each intersect
  // the viewer's level, so an under-declared crucible can't leak its cover. Creators always see
  // their own.
  const and: Prisma.CrucibleWhereInput[] = [];
  const effectiveLevel = getEffectiveBrowsingLevel({
    isGreen,
    isLoggedIn: viewerId != null,
    requested: browsingLevel,
  });
  if (effectiveLevel > 0) {
    const levels = levelsIntersecting(effectiveLevel);
    const visible: Prisma.CrucibleWhereInput = {
      nsfwLevel: { in: levels },
      image: { nsfwLevel: { in: levels } },
    };
    and.push(viewerId ? { OR: [{ userId: viewerId }, visible] } : visible);
  }

  // As user challenges: a crucible shows only on the site whose currency it runs on.
  const onDomain: Prisma.CrucibleWhereInput = { buzzType: deriveDomainCurrency(isGreen) };
  and.push(viewerId ? { OR: [{ userId: viewerId }, onDomain] } : onDomain);
  where.AND = and;

  // "Ending soon" only means something for crucibles still running; without this, an unfiltered
  // feed would lead with the ones that ended longest ago.
  const effectiveStatus =
    status ?? (sort === CrucibleSort.EndingSoon ? CrucibleStatus.Active : undefined);
  if (effectiveStatus === CrucibleStatus.Cancelled && !isModerator) {
    return { items: [], nextCursor: undefined };
  }
  where.status = effectiveStatus ?? { not: CrucibleStatus.Cancelled };
  if (contentType) where.contentType = contentType;

  if (excludedUserIds.length > 0) {
    where.userId = { notIn: excludedUserIds };
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

  // Every column above is non-unique, and a cursor names one row — so without a unique
  // tiebreaker last, the rows sharing an `endAt` have no defined order between them and paging
  // across that boundary can skip or repeat them.
  orderBy.push({ id: 'desc' });

  // One row beyond the page is how "is there more?" gets answered. Asking for exactly `take`
  // leaves the caller guessing, and the guess it made — a non-empty page always has more — meant
  // the feed never ended.
  const rows = await dbRead.crucible.findMany({
    take: take + 1,
    cursor: cursor ? { id: cursor } : undefined,
    where,
    orderBy,
    select,
  });

  // Prisma's cursor is INCLUSIVE, so the extra row's id is exactly the right cursor: the next
  // page starts AT it, and it has not been served yet. Handing back the last SERVED row's id
  // instead is what re-served it.
  const nextCursor =
    rows.length > take ? (rows.pop() as { id: number } & (typeof rows)[number]).id : undefined;

  return { items: rows, nextCursor };
};

/**
 * Entries must be published images, so media added from inside the submit modal goes into a
 * published post first and becomes enterable once its scan settles.
 */
export const createCrucibleEntryPost = async ({
  crucibleId,
  userId,
}: CreateEntryPostSchema & { userId: number }) => {
  const crucible = await dbRead.crucible.findUnique({
    where: { id: crucibleId },
    select: { name: true, status: true, endAt: true, userId: true },
  });
  if (!crucible) throw throwNotFoundError('Crucible not found');
  if (crucible.status !== CrucibleStatus.Active || (crucible.endAt && new Date() > crucible.endAt))
    throw throwBadRequestError('This crucible is not accepting entries');
  if (crucible.userId === userId) throw throwBadRequestError(CANNOT_ENTER_OWN_CRUCIBLE);

  const post = await createPost({ userId, title: crucible.name, publishedAt: new Date() });
  return { id: post.id };
};

const CANNOT_ENTER_OWN_CRUCIBLE = "You can't enter a crucible you created";

export type CrucibleEntryIneligibleReason =
  | 'created-before-start'
  | 'no-resources'
  | 'missing-required-resource'
  | 'not-found';

const entryIneligibleMessages: Record<CrucibleEntryIneligibleReason, string> = {
  'created-before-start': 'Only media created after this crucible started can be entered.',
  'no-resources':
    'This image has no detected resources. Images submitted to this crucible must use specific resources.',
  'missing-required-resource':
    'This image does not use any of the required resources for this crucible. Please check the crucible requirements and submit an image that uses an allowed resource.',
  'not-found': 'Image not found',
};

type EntryEligibilityCrucible = {
  startAt: Date | null;
  createdAt: Date;
  allowedResources: Prisma.JsonValue;
};

const getAllowedResources = (crucible: EntryEligibilityCrucible) =>
  Array.isArray(crucible.allowedResources) ? (crucible.allowedResources as number[]) : [];

/**
 * Shared by `submitEntry` and `checkCrucibleEntryEligibility` so the submit modal cannot disagree
 * with submission — add server-checked entry rules here, not inline.
 */
const getEntryIneligibleReasons = async (
  crucible: EntryEligibilityCrucible,
  images: { id: number; createdAt: Date }[]
) => {
  const startedAt = crucible.startAt ?? crucible.createdAt;
  const allowedResources = getAllowedResources(crucible);
  const resourcesByImage =
    allowedResources.length > 0 && images.length > 0
      ? await imageResourcesCache.fetch(images.map((image) => image.id))
      : {};

  return new Map(
    images.map((image) => {
      const reasons: CrucibleEntryIneligibleReason[] = [];
      if (image.createdAt < startedAt) reasons.push('created-before-start');

      if (allowedResources.length > 0) {
        const versionIds = (resourcesByImage[image.id]?.resources ?? []).map(
          (resource) => resource.modelVersionId
        );
        if (versionIds.length === 0) reasons.push('no-resources');
        else if (!versionIds.some((versionId) => allowedResources.includes(versionId)))
          reasons.push('missing-required-resource');
      }

      return [image.id, reasons];
    })
  );
};

export const checkCrucibleEntryEligibility = async ({
  crucibleId,
  imageIds,
  userId,
}: CheckCrucibleEntryEligibilitySchema & { userId: number }) => {
  const crucible = await dbRead.crucible.findUnique({
    where: { id: crucibleId },
    select: { startAt: true, createdAt: true, allowedResources: true },
  });
  if (!crucible) throw throwNotFoundError('Crucible not found');

  const images = await dbRead.image.findMany({
    where: { id: { in: imageIds }, userId },
    select: { id: true, createdAt: true },
  });
  const reasonsByImage = await getEntryIneligibleReasons(crucible, images);

  return imageIds.map((imageId) => {
    const reasons = reasonsByImage.get(imageId) ?? ['not-found' as const];
    return { imageId, eligible: reasons.length === 0, reasons };
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
        contentType: true,
        entryFee: true,
        entryLimit: true,
        maxTotalEntries: true,
        maxClipSeconds: true,
        allowedResources: true,
        buzzType: true,
        startAt: true,
        createdAt: true,
        endAt: true,
        _count: {
          select: { entries: true },
        },
      },
    });

    if (!crucible) {
      return throwNotFoundError('Crucible not found');
    }

    if (crucible.userId === userId) {
      return throwBadRequestError(CANNOT_ENTER_OWN_CRUCIBLE);
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
        type: true,
        nsfwLevel: true,
        metadata: true,
        createdAt: true,
      },
    });

    if (!image) {
      return throwNotFoundError('Image not found');
    }

    // Validate user owns the image
    if (image.userId !== userId) {
      return throwBadRequestError('You can only submit your own images');
    }

    const isPublished = await dbRead.image.count({
      where: { id: imageId, ...publishedImageWhere() },
    });
    if (!isPublished) {
      return throwBadRequestError('Only published images can be entered');
    }

    if (image.type !== crucible.contentType) {
      return throwBadRequestError(
        `This crucible only accepts ${crucible.contentType} entries; this one is ${image.type}.`
      );
    }

    const clipSeconds = (image.metadata as VideoMetadata | null)?.duration ?? null;
    if (!clipLengthAllowed(clipSeconds, crucible.maxClipSeconds)) {
      // Ceiling on the actual duration: durations are fractional and `formatDuration` rounds, so a
      // 120.01s clip against a 120s limit rendered both halves as "2:00" — the entrant was told the
      // entry was too long and shown two identical numbers.
      return throwBadRequestError(
        `Entries in this crucible can be at most ${formatDuration(
          crucible.maxClipSeconds as number
        )}; this one is ${formatDuration(Math.ceil(clipSeconds as number))}.`
      );
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

    const [ineligibleReason] =
      (await getEntryIneligibleReasons(crucible, [image])).get(image.id) ?? [];
    if (ineligibleReason) {
      return throwBadRequestError(entryIneligibleMessages[ineligibleReason]);
    }

    // Handle entry fee collection (if entryFee > 0)
    let buzzTransactionId: string | null = null;

    if (crucible.entryFee > 0) {
      // Check if user has sufficient Buzz
      const userAccount = await getUserBuzzAccount({
        accountId: userId,
        accountTypes: [crucible.buzzType as 'green' | 'yellow'],
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

      await createMultiAccountBuzzTransaction({
        fromAccountId: userId,
        fromAccountTypes: [crucible.buzzType as 'green' | 'yellow'],
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
          category: NotificationCategory.Update,
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

/**
 * Redis key for tracking voted pairs per user per crucible
 */
function getVotedPairsKey(crucibleId: number, userId: number): RedisKeyTemplateSys {
  return `${REDIS_SYS_KEYS.CRUCIBLE.VOTED_PAIRS}:${crucibleId}:${userId}` as RedisKeyTemplateSys;
}

function getServedPairsKey(crucibleId: number, userId: number): RedisKeyTemplateSys {
  return `${REDIS_SYS_KEYS.CRUCIBLE.SERVED_PAIRS}:${crucibleId}:${userId}` as RedisKeyTemplateSys;
}

function getJudgeEntryVotesKey(crucibleId: number, userId: number): RedisKeyTemplateSys {
  return `${REDIS_SYS_KEYS.CRUCIBLE.JUDGE_ENTRY_VOTES}:${crucibleId}:${userId}` as RedisKeyTemplateSys;
}

const JUDGE_KEY_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Bounds how far one judge can move a single entry. */
export const CRUCIBLE_MAX_VOTES_PER_JUDGE_PER_ENTRY = 5;

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

type EntryForJudging = {
  id: number;
  imageId: number;
  userId: number;
  score: number;
  image: {
    id: number;
    url: string;
    type: MediaType;
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

export type JudgingPairForClient = {
  left: Omit<EntryForJudging, 'score'>;
  right: Omit<EntryForJudging, 'score'>;
} | null;

/**
 * An entry's live ELO is the matchmaking input, not something a judge may see while voting.
 */
export const withoutEntryScores = (pair: JudgingPair): JudgingPairForClient => {
  if (!pair) return null;

  const project = ({ id, imageId, userId, image, user }: EntryForJudging) => ({
    id,
    imageId,
    userId,
    image,
    user,
  });

  return { left: project(pair.left), right: project(pair.right) };
};

const SAMPLE_SIZE = 100;
const MAX_SAMPLE_ATTEMPTS = 3;
const OPPONENT_POOL_SIZE = 10;

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
  image_type: MediaType;
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
          i.type as image_type,
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
          i.type as image_type,
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
      type: raw.image_type,
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

type RatedEntry = EntryForJudging & { votes: number };

/**
 * The least-voted entry, against the nearest-rated of the least-voted opponents this judge hasn't
 * already paired it with. Ties break randomly.
 */
function pickUnjudgedPair(entries: RatedEntry[], votedPairs: Set<string>) {
  const byVotes = entries
    .map((entry) => ({ entry, tieBreak: Math.random() }))
    .sort((x, y) => x.entry.votes - y.entry.votes || x.tieBreak - y.tieBreak)
    .map(({ entry }) => entry);

  for (const a of byVotes) {
    const opponents = byVotes
      .filter((b) => b.id !== a.id && !votedPairs.has(createPairKey(a.id, b.id)))
      .slice(0, OPPONENT_POOL_SIZE);
    if (!opponents.length) continue;

    const distance = (entry: RatedEntry) => Math.abs(entry.score - a.score);
    const b = opponents.reduce((nearest, candidate) =>
      distance(candidate) < distance(nearest) ? candidate : nearest
    );
    return { a, b };
  }

  return null;
}

export const getJudgingPair = async ({
  crucibleId,
  userId,
  excludeEntryIds,
}: GetJudgingPairSchema & { userId: number }): Promise<JudgingPair> => {
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

  const [redisElos, voteCounts, judgeEntryVotes, votedPairKeys] = await Promise.all([
    getAllEntryElos(crucibleId),
    crucibleEloRedis.getAllVoteCounts(crucibleId),
    sysRedis.hGetAll(getJudgeEntryVotesKey(crucibleId, userId)),
    sysRedis.sMembers(getVotedPairsKey(crucibleId, userId)),
  ]);
  const votedPairs = new Set(votedPairKeys);
  const underJudgeCap = (entry: EntryForJudging) =>
    Number(judgeEntryVotes?.[entry.id] ?? 0) < CRUCIBLE_MAX_VOTES_PER_JUDGE_PER_ENTRY;
  const rate = (entry: EntryForJudging): RatedEntry => ({
    ...entry,
    score: redisElos[entry.id] ?? entry.score,
    votes: voteCounts[entry.id] ?? 0,
  });

  const search = async (exclusions?: number[]) => {
    for (let attempt = 0; attempt < MAX_SAMPLE_ATTEMPTS; attempt++) {
      const sample = await fetchEntrySample(crucibleId, userId, SAMPLE_SIZE, exclusions);
      const pair = pickUnjudgedPair(sample.filter(underJudgeCap).map(rate), votedPairs);
      if (pair) return pair;
      // A short sample already held every entry, so another draw returns the same set.
      if (sample.length < SAMPLE_SIZE) return null;
    }
    return null;
  };

  // A skip means "not now": once only skipped entries are left, they come back instead of the
  // judge being told there is nothing left to judge.
  const pair = (await search(excludeEntryIds)) ?? (excludeEntryIds?.length ? await search() : null);
  if (!pair) return null;
  const { a: imageA, b: imageB } = pair;

  const servedKey = getServedPairsKey(crucibleId, userId);
  await sysRedis.sAdd(servedKey, createPairKey(imageA.id, imageB.id));
  await sysRedis.expire(servedKey, JUDGE_KEY_TTL_SECONDS);

  const swapPositions = Math.random() < 0.5;

  return {
    left: swapPositions ? imageB : imageA,
    right: swapPositions ? imageA : imageB,
  };
};

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
  winnerWatchedMs,
  loserWatchedMs,
  userId,
}: SubmitVoteSchema & { userId: number }): Promise<SubmitVoteResult> => {
  log(
    `Vote submission started: user ${userId}, crucible ${crucibleId}, winner ${winnerEntryId}, loser ${loserEntryId}`
  );

  if (winnerEntryId === loserEntryId) {
    throw throwBadRequestError('A vote needs two different entries');
  }

  // Fetch the crucible to validate it's active
  const crucible = await dbRead.crucible.findUnique({
    where: { id: crucibleId },
    select: {
      id: true,
      status: true,
      endAt: true,
      minViewSeconds: true,
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

  // Runs before the pair is marked voted below: rejecting afterwards would spend the judge's one
  // shot at this pair and leave them unable to vote on it once they had watched properly.
  //
  // The browser reports these, so a determined caller can lie. What it buys is the accidental and
  // the casual case — and failing closed on an absent field, rather than treating it as zero
  // watched or as consent, is what stops "omit the field" being the bypass.
  if (crucible.minViewSeconds) {
    const requiredMs = crucible.minViewSeconds * 1000;
    if ((winnerWatchedMs ?? 0) < requiredMs || (loserWatchedMs ?? 0) < requiredMs) {
      throw throwBadRequestError(
        `Watch at least ${crucible.minViewSeconds}s of both clips before voting.`
      );
    }
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

  const judgeEntryVotesKey = getJudgeEntryVotesKey(crucibleId, userId);
  const [winnerJudgeVotes, loserJudgeVotes] = await Promise.all([
    sysRedis.hGet(judgeEntryVotesKey, winnerEntryId.toString()),
    sysRedis.hGet(judgeEntryVotesKey, loserEntryId.toString()),
  ]);
  if (
    Number(winnerJudgeVotes ?? 0) >= CRUCIBLE_MAX_VOTES_PER_JUDGE_PER_ENTRY ||
    Number(loserJudgeVotes ?? 0) >= CRUCIBLE_MAX_VOTES_PER_JUDGE_PER_ENTRY
  ) {
    throw throwBadRequestError(
      "You've judged one of these entries as many times as allowed. Please wait for the next pair to load."
    );
  }

  const pairKey = createPairKey(winnerEntryId, loserEntryId);
  // SREM is the atomic claim: only a pair this judge was actually served can be voted, once.
  const served = await sysRedis.sRem(getServedPairsKey(crucibleId, userId), pairKey);
  if (!served) {
    throw throwBadRequestError(
      'This pair is no longer available. Please wait for the next pair to load.'
    );
  }

  // Race condition protection: Atomically mark the pair as voted before processing
  // Use SADD to add to the set - if it returns 0, the pair was already added (duplicate vote)
  // Note: sysRedis.sAdd accepts either a single value or array (see CustomRedisClient interface)
  const key = getVotedPairsKey(crucibleId, userId);
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
    sysRedis.hIncrBy(judgeEntryVotesKey, winnerEntryId.toString(), 1),
    sysRedis.hIncrBy(judgeEntryVotesKey, loserEntryId.toString(), 1),
    sysRedis.expire(judgeEntryVotesKey, JUDGE_KEY_TTL_SECONDS),
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

  log(
    `Vote submitted successfully: user ${userId}, crucible ${crucibleId}, winner ${winnerEntryId} (ELO: ${winnerElo}), loser ${loserEntryId} (ELO: ${loserElo})`
  );

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
      buzzType: true,
      entryFee: true,
      seededPrizePool: true,
      seedTransactionId: true,
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

  const totalPrizePool = getCrucibleTotalPrizePool({
    entryFee: crucible.entryFee,
    entryCount,
    seededPrizePool: crucible.seededPrizePool,
  });

  // Parse prize positions from JSON
  const prizePositions = parsePrizePositions(crucible.prizePositions);

  // ============================================================================
  // Edge Case: 0 entries
  // ============================================================================
  if (entryCount === 0) {
    log(`Edge case: Crucible ${crucibleId} has 0 entries - finalizing without prizes`);

    // Nobody entered, so the seed has no winner to go to. Hand it back rather than stranding it in
    // the bank; fail-soft, because a stuck refund must not block the crucible from completing.
    if (crucible.seedTransactionId) {
      try {
        await refundMultiAccountTransaction({
          externalTransactionIdPrefix: crucible.seedTransactionId,
          description: 'Crucible seeded prize pool refund - no entries',
          details: {
            entityId: crucibleId,
            entityType: 'Crucible',
            reason: 'no-entries',
          },
        });
        log(`Refunded seeded prize pool for crucible ${crucibleId} (no entries)`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        log(`Failed to refund seeded prize pool for crucible ${crucibleId}: ${errorMessage}`);
      }
    }

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
      category: NotificationCategory.Update,
      key: `crucible-ended:${crucibleId}`,
      details: {
        crucibleId,
        crucibleName: crucible.name,
        totalEntries: 0,
        prizePool: totalPrizePool,
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
      totalPrizePool,
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
    const prizeAmount = getCruciblePrizeAmount({
      position,
      prizePositions,
      entryCount: sortedEntries.length,
      totalPrizePool,
    });

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
      toAccountType: crucible.buzzType as 'green' | 'yellow',
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

      // Invalidate buzz won cache for all winners so their stats reflect the new prize
      const uniqueWinnerUserIds = [...new Set(prizeWinners.map((w) => w.userId))];
      await Promise.all(
        uniqueWinnerUserIds.map((winnerId) =>
          redis.del(`${REDIS_KEYS.CRUCIBLE.USER_BUZZ_WON}:${winnerId}` as RedisKeyTemplateCache)
        )
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

    // Entries exist but nothing was paid out — an empty prizePositions map, or a seed small enough
    // that every floored share is 0. Same stranding as the 0-entry case above, so same remedy.
    if (crucible.seedTransactionId) {
      try {
        await refundMultiAccountTransaction({
          externalTransactionIdPrefix: crucible.seedTransactionId,
          description: 'Crucible seeded prize pool refund - no prizes awarded',
          details: {
            entityId: crucibleId,
            entityType: 'Crucible',
            reason: 'no-prizes-awarded',
          },
        });
        log(`Refunded seeded prize pool for crucible ${crucibleId} (no prizes awarded)`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        log(`Failed to refund seeded prize pool for crucible ${crucibleId}: ${errorMessage}`);
      }
    }
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
    category: NotificationCategory.Update,
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
      category: NotificationCategory.System,
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
/**
 * Opens every scheduled crucible whose start time has passed.
 */
export const activateScheduledCrucibles = async (): Promise<number> => {
  const { count } = await dbWrite.crucible.updateMany({
    where: { status: CrucibleStatus.Pending, startAt: { lte: new Date() } },
    data: { status: CrucibleStatus.Active },
  });
  return count;
};

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
  /** Entrants' money only — the creator's seed is reported separately as `refundedSeed`. */
  totalRefunded: number;
  refundedSeed: number;
  /**
   * How many of the refunds above were already settled before this call, so no money moved for
   * them now. Non-zero on a re-run; without it a second cancel reports the same totals as the
   * first and reads as a second payment.
   */
  alreadySettled: number;
  /**
   * Money still owed. `entryId: null` is a crucible-level refund (the creator's setup fee or
   * seed). A duplicate the ledger rejected is NOT a failure — that money is already back.
   */
  failedRefunds: Array<{ entryId: number | null; userId: number; error: string }>;
};

/**
 * Buzz keys refunds on `externalTransactionIdPrefix`: a second refund of one returns 409, and a
 * prefix matching nothing returns 404. Neither means money is owed, so tolerating both is what
 * makes cancelling safe to re-run — the same tolerance as `refundChallengeFundsByPrefix`.
 */
async function refundCrucibleTransactionOnce({
  externalTransactionIdPrefix,
  description,
  crucibleId,
  label,
}: {
  externalTransactionIdPrefix: string;
  description: string;
  crucibleId: number;
  label: string;
}): Promise<'refunded' | 'already-settled'> {
  try {
    await refundMultiAccountTransaction({
      externalTransactionIdPrefix,
      description,
      details: {
        entityId: crucibleId,
        entityType: 'Crucible',
        reason: 'cancellation',
      },
    });
    return 'refunded';
  } catch (error) {
    const status = getBuzzApiStatus(error);
    if (status === 404 || status === 409) {
      log(`Refund for ${label} already settled (buzz ${status}); nothing moved`);
      return 'already-settled';
    }
    throw error;
  }
}

/**
 * Cancel a crucible and return every payment it took. Safe to re-run, and re-running is the
 * supported way to finish a cancel whose refunds did not all land: the status write happens first,
 * and each refund is keyed so the ledger rejects a duplicate rather than paying twice.
 */
export const cancelCrucible = async ({
  id,
  userId,
  isModerator,
}: CancelCrucibleSchema & {
  userId: number;
  isModerator: boolean;
}): Promise<CancelCrucibleResult> => {
  // Fetch the crucible with all entries that have transaction IDs
  const crucible = await dbRead.crucible.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true, // Creator: receives the setup-fee and seed refunds
      status: true,
      entryFee: true,
      buzzTransactionId: true, // Creator setup fee transaction
      seededPrizePool: true,
      seedTransactionId: true,
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

  // Before start nobody can have entered, so an owner's cancel only returns their own Buzz.
  const ownerBeforeStart = crucible.userId === userId && crucible.status === CrucibleStatus.Pending;
  if (!isModerator && !ownerBeforeStart) {
    throw throwAuthorizationError('Only moderators can cancel a crucible once it has started');
  }

  // Prizes have already been paid out, so there is nothing to give back.
  if (crucible.status === CrucibleStatus.Completed) {
    throw throwBadRequestError('Cannot cancel a completed crucible');
  }

  // No guard on Cancelled: the refunds below are idempotent, and re-running is how a partly
  // refunded cancel gets finished.

  // Status first, before any money moves. An interrupted cancel then leaves a stopped crucible
  // with refunds owed (listed in `failedRefunds`, fixed by calling again) rather than an Active
  // one still taking entries from people who were just refunded.
  await dbWrite.crucible.update({
    where: { id },
    data: {
      status: CrucibleStatus.Cancelled,
    },
  });

  let refundedEntries = 0;
  let totalRefunded = 0;
  let alreadySettled = 0;
  const failedRefunds: CancelCrucibleResult['failedRefunds'] = [];

  // Refund entry fees in parallel with concurrency limit of 10
  // This prevents timeout issues with large crucibles while avoiding overwhelming the system
  const limit = plimit(10);
  const refundResults = await Promise.allSettled(
    crucible.entries
      .filter((entry) => entry.buzzTransactionId !== null) // Only process entries with transaction IDs
      .map((entry) =>
        limit(async () => {
          try {
            const settled = await refundCrucibleTransactionOnce({
              externalTransactionIdPrefix: entry.buzzTransactionId!,
              description: 'Crucible entry fee refund - crucible cancelled',
              crucibleId: crucible.id,
              label: `entry ${entry.id} for user ${entry.userId}`,
            });

            if (settled === 'refunded') {
              log(`Refunded entry ${entry.id} for user ${entry.userId}: ${crucible.entryFee} Buzz`);
            }

            return { success: true, entry, settled };
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

  for (const result of refundResults) {
    if (result.status === 'fulfilled') {
      const refundResult = result.value;
      if (refundResult.success) {
        refundedEntries++;
        totalRefunded += crucible.entryFee;
        if (refundResult.settled === 'already-settled') alreadySettled++;
      } else {
        failedRefunds.push({
          entryId: refundResult.entry.id,
          userId: refundResult.entry.userId,
          error: refundResult.error!,
        });
      }
    }
  }

  let creatorSetupFeeRefunded = false;
  if (crucible.buzzTransactionId) {
    try {
      const settled = await refundCrucibleTransactionOnce({
        externalTransactionIdPrefix: crucible.buzzTransactionId,
        description: 'Crucible creator setup fee refund - crucible cancelled',
        crucibleId: crucible.id,
        label: `creator setup fee for crucible ${id}`,
      });
      creatorSetupFeeRefunded = true;
      if (settled === 'already-settled') alreadySettled++;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Failed to refund creator setup fee for crucible ${id}: ${errorMessage}`);
      failedRefunds.push({ entryId: null, userId: crucible.userId, error: errorMessage });
    }
  } else {
    log(`No creator setup fee to refund for crucible ${id} (free crucible or legacy)`);
  }

  // Return the creator's seeded prize pool. Guarded on the stored prefix rather than the amount:
  // a prefix matching no transaction makes the refund 404, and an unseeded crucible has no prefix.
  let refundedSeed = 0;
  if (crucible.seedTransactionId) {
    try {
      const settled = await refundCrucibleTransactionOnce({
        externalTransactionIdPrefix: crucible.seedTransactionId,
        description: 'Crucible seeded prize pool refund - crucible cancelled',
        crucibleId: crucible.id,
        label: `seeded prize pool for crucible ${id}`,
      });
      refundedSeed = crucible.seededPrizePool;
      if (settled === 'already-settled') alreadySettled++;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Failed to refund seeded prize pool for crucible ${id}: ${errorMessage}`);
      failedRefunds.push({ entryId: null, userId: crucible.userId, error: errorMessage });
    }
  }

  // Clean up Redis ELO data (set short TTL for eventual cleanup)
  await crucibleEloRedis.setTTL(id, 24 * 60 * 60); // 24 hours

  log(
    `Cancelled crucible ${id}: ${refundedEntries} entries refunded, ${totalRefunded} Buzz total, ${failedRefunds.length} failed, setup fee refunded: ${creatorSetupFeeRefunded}`
  );

  return {
    crucibleId: id,
    refundedEntries,
    totalRefunded,
    refundedSeed,
    alreadySettled,
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

  // Calculate total Buzz won from crucible prizes
  // Uses externalTransactionId prefix which is more specific and potentially better indexed
  // Results are cached since prize totals only change when new crucibles complete
  const cacheKey = `${REDIS_KEYS.CRUCIBLE.USER_BUZZ_WON}:${userId}` as RedisKeyTemplateCache;
  const buzzWon = await fetchThroughCache(
    cacheKey,
    async () => {
      const buzzWonResult = await dbRead.$queryRaw<[{ total: bigint }]>`
        SELECT COALESCE(SUM(amount), 0) as total
        FROM "BuzzTransaction"
        WHERE "toUserId" = ${userId}
          AND "externalTransactionId" LIKE 'crucible-prize-%'
      `;
      return Number(buzzWonResult[0]?.total ?? 0);
    },
    { ttl: CacheTTL.hour }
  );

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
          seededPrizePool: true,
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
      const prizePool = getCrucibleTotalPrizePool({
        entryFee: entry.crucible.entryFee,
        entryCount: entry.crucible._count.entries,
        seededPrizePool: entry.crucible.seededPrizePool,
      });
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
export const getFeaturedCrucible = async ({
  excludedUserIds = [],
  browsingLevel,
  isGreen = false,
  isLoggedIn = false,
}: {
  excludedUserIds?: number[];
  browsingLevel?: number;
  isGreen?: boolean;
  isLoggedIn?: boolean;
} = {}): Promise<{
  id: number;
  name: string;
  description: string;
  prizePool: number;
  timeRemaining: string;
  entriesCount: number;
  imageUrl: string | null;
  buzzType: 'green' | 'yellow';
} | null> => {
  const effectiveLevel = getEffectiveBrowsingLevel({
    isGreen,
    isLoggedIn,
    requested: browsingLevel,
  });
  // Use raw SQL to calculate prize pool and sort at database level for scalability
  const result = await dbRead.$queryRaw<
    {
      id: number;
      name: string;
      description: string | null;
      entryFee: number;
      seededPrizePool: number;
      endAt: Date | null;
      imageUrl: string | null;
      buzzType: string;
      entriesCount: bigint;
      prizePool: bigint;
    }[]
  >`
    SELECT
      c.id,
      c.name,
      c.description,
      c."entryFee",
      c."seededPrizePool",
      c."endAt",
      c."buzzType",
      i.url as "imageUrl",
      COUNT(ce.id) as "entriesCount",
      c."seededPrizePool" + c."entryFee" * COUNT(ce.id) as "prizePool"
    FROM "Crucible" c
    LEFT JOIN "Image" i ON c."imageId" = i.id
    LEFT JOIN "CrucibleEntry" ce ON c.id = ce."crucibleId"
    WHERE c.status = ${CrucibleStatus.Active}::"CrucibleStatus"
      -- Status lags the clock until finalize-crucibles runs; don't feature one that already ended.
      AND (c."endAt" IS NULL OR c."endAt" > now())
      AND c."buzzType" = ${deriveDomainCurrency(isGreen)}
      ${
        effectiveLevel > 0
          ? Prisma.sql`AND (c."nsfwLevel" & ${effectiveLevel}) <> 0 AND (i."nsfwLevel" & ${effectiveLevel}) <> 0`
          : Prisma.empty
      }
      ${
        excludedUserIds.length > 0
          ? Prisma.sql`AND c."userId" NOT IN (${Prisma.join(excludedUserIds)})`
          : Prisma.empty
      }
    GROUP BY c.id, c.name, c.description, c."entryFee", c."seededPrizePool", c."endAt", c."buzzType", i.url
    ORDER BY "prizePool" DESC, "entriesCount" DESC
    LIMIT 1
  `;

  if (result.length === 0) {
    return null;
  }

  const featured = result[0];

  return {
    id: featured.id,
    name: featured.name,
    description: featured.description ?? '',
    prizePool: Number(featured.prizePool),
    timeRemaining: featured.endAt ? formatTimeRemaining(featured.endAt) : 'No end date',
    entriesCount: Number(featured.entriesCount),
    imageUrl: featured.imageUrl,
    buzzType: toCrucibleBuzzType(featured.buzzType),
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

/**
 * Still judgeable by this viewer, and inside their browsing level on both the crucible's rating and
 * its cover — the rule the landing feed applies client-side in useApplyHiddenPreferences.
 */
export const getJudgingSuggestions = async ({
  userId,
  browsingLevel,
  excludeCrucibleId,
  limit,
  excludedUserIds = [],
  isGreen = false,
}: GetJudgingSuggestionsSchema & {
  userId: number;
  excludedUserIds?: number[];
  isGreen?: boolean;
}) => {
  const rows = await dbRead.$queryRaw<{ id: number }[]>`
    SELECT c.id
    FROM "Crucible" c
    LEFT JOIN "Image" i ON i.id = c."imageId"
    WHERE c.status = ${CrucibleStatus.Active}::"CrucibleStatus"
      -- Status lags the clock until finalize-crucibles runs.
      AND (c."endAt" IS NULL OR c."endAt" > now())
      AND c."buzzType" = ${deriveDomainCurrency(isGreen)}
      AND (c."nsfwLevel" & ${browsingLevel}) <> 0
      AND (i.id IS NULL OR (i."nsfwLevel" & ${browsingLevel}) <> 0)
      ${excludeCrucibleId ? Prisma.sql`AND c.id <> ${excludeCrucibleId}` : Prisma.empty}
      ${
        excludedUserIds.length > 0
          ? Prisma.sql`AND c."userId" NOT IN (${Prisma.join(excludedUserIds)})`
          : Prisma.empty
      }
      -- A judge is never shown their own entries, so a pair needs two of someone else's.
      AND (
        SELECT count(*) FROM (
          SELECT 1 FROM "CrucibleEntry" ce
          WHERE ce."crucibleId" = c.id AND ce."userId" <> ${userId}
          LIMIT 2
        ) judgeable
      ) = 2
    ORDER BY c."createdAt" DESC, c.id DESC
    LIMIT ${limit}
  `;
  if (!rows.length) return [];

  return dbRead.crucible.findMany({
    where: { id: { in: rows.map(({ id }) => id) } },
    select: crucibleListSelect,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
};
