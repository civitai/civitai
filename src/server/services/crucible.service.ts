import { randomUUID } from 'crypto';
import { chunk } from 'lodash-es';
import { Prisma } from '@prisma/client';
import { isDefined } from '~/utils/type-guards';
import dayjs from '~/shared/utils/dayjs';
import plimit from 'p-limit';
import {
  Availability,
  CrucibleEngagementType,
  CrucibleIngestionStatus,
  CrucibleStatus,
  ImageIngestionStatus,
  MediaType,
  ModelStatus,
  ModelType,
} from '~/shared/utils/prisma/enums';
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
  GetJudgingProgressSchema,
  GetJudgingSuggestionsSchema,
  SubmitVoteSchema,
  CancelCrucibleSchema,
  RemoveCrucibleEntrySchema,
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
  hasEntryImage,
} from '~/server/selectors/crucible.selector';
import { publishedImageWhere } from '~/server/selectors/image.selector';
import {
  getCrucibleJudgingConfig,
  recordSessionVote,
  resolveWatchSeconds,
} from '~/server/services/crucible-judging-session';
import type { RedisKeyTemplateSys, RedisKeyTemplateCache } from '~/server/redis/client';
import { redis, sysRedis, REDIS_SYS_KEYS, REDIS_KEYS } from '~/server/redis/client';
import { CacheTTL, constants } from '~/server/common/constants';
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
import { isNonSfwForGreen } from '~/server/games/daily-challenge/challenge-currency';
import { getEffectiveBrowsingLevel } from '~/server/games/daily-challenge/challenge-visibility';
import { checkCrucibleSettings } from '~/server/schema/crucible.schema';
import { createPost } from '~/server/services/post.service';
import { NotificationCategory } from '~/server/common/enums';
import { imageResourcesCache } from '~/server/redis/caches';
import {
  getCrucibleMinVotes,
  baseModelMakesMediaType,
  getCruciblePrizeAmount,
  getCrucibleTotalPrizePool,
  getCruciblePublishableName,
  type CrucibleNameScan,
  getCrucibleTransactionDescription,
  CRUCIBLE_PRIZE_BUZZ_TYPE,
  CRUCIBLE_SFW_LEVELS,
  getCrucibleEntryBuzzType,
  isCrucibleSfw,
  isFreeCrucibleEntry,
  parsePrizePositions,
  type PrizePosition,
} from '~/utils/crucible-helpers';
import { getBuzzApiStatus } from '~/server/utils/buzz-error';
import { throwOnBlockedUserContent } from '~/server/services/blocklist.service';
import { assertCanCreateCrucible } from '~/server/services/crucible-eligibility.service';
import { getEligibleModels } from '~/server/services/eligible-models.service';
import { getProfanityFilter } from '~/libs/profanity-simple';
import {
  nsfwBrowsingLevelsFlag,
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { submitTextModeration } from '~/server/services/text-moderation.service';
import { CHALLENGE_MODERATION_LABELS } from '~/server/games/daily-challenge/challenge-text-scan';
import { logToAxiom } from '~/server/logging/client';
import { removeTags } from '~/utils/string-helpers';

const log = createLogger('crucible-service', 'cyan');

const sendCrucibleNotification = (notification: Parameters<typeof createNotification>[0]) => {
  createNotification(notification).catch((error) =>
    logToAxiom({
      type: 'error',
      name: 'crucible-notification-failed',
      message: error instanceof Error ? error.message : String(error),
      notificationType: notification.type,
      key: notification.key,
    })
  );
};

/** The host and every placed entrant get their own ending notification; this reaches the rest. */
const notifyCrucibleFollowersOfResults = async ({
  crucible,
  crucibleName,
  excludeUserIds,
}: {
  crucible: { id: number; userId: number } & Parameters<typeof isCrucibleHiddenByScan>[0];
  crucibleName: string | null;
  excludeUserIds: Iterable<number>;
}) => {
  const crucibleId = crucible.id;
  try {
    // Only its host can open a crucible still hidden by its scan, and the host is excluded here.
    if (isCrucibleHiddenByScan(crucible, {})) return;
    const exclude = new Set(excludeUserIds);
    const followers = await dbWrite.crucibleEngagement.findMany({
      where: { crucibleId, type: CrucibleEngagementType.Notify },
      select: { userId: true },
    });
    const candidates = followers.map((f) => f.userId).filter((id) => !exclude.has(id));
    if (!candidates.length) return;
    // The same pairs notBlockedBetween drops from crucible-ending-soon.
    const blocked = await dbWrite.userEngagement.findMany({
      where: {
        OR: [
          { userId: crucible.userId, targetUserId: { in: candidates }, type: 'Block' },
          {
            userId: { in: candidates },
            targetUserId: crucible.userId,
            type: { in: ['Block', 'Hide'] },
          },
        ],
      },
      select: { userId: true, targetUserId: true },
    });
    const blockedIds = new Set(
      blocked.map((b) => (b.userId === crucible.userId ? b.targetUserId : b.userId))
    );
    const userIds = candidates.filter((id) => !blockedIds.has(id));
    if (!userIds.length) return;
    sendCrucibleNotification({
      type: 'crucible-results',
      category: NotificationCategory.Update,
      key: `crucible-results:${crucibleId}`,
      userIds,
      details: { crucibleId, crucibleName },
    });
  } catch (error) {
    logToAxiom({
      type: 'error',
      name: 'crucible-notification-failed',
      message: error instanceof Error ? error.message : String(error),
      notificationType: 'crucible-results',
      crucibleId,
    });
  }
};

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
      logToAxiom({
        type: 'error',
        name: 'crucible-charge-refund-failed',
        message: `Failed to refund ${prefix} (${reason}): ${
          refundError instanceof Error ? refundError.message : String(refundError)
        }`,
        prefix,
        reason,
        ...details,
      });
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
  freeEntriesPerUser = 0,
  maxTotalEntries,
  prizePositions,
  allowedResources,
  allowedBaseModels = [],
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
  await assertRequiredModelsMakeContentType(allowedResources ?? [], contentType ?? MediaType.image);
  assertBaseModelsMakeContentType(allowedBaseModels, contentType ?? MediaType.image);

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
      prizePool: seedAmount,
      entryLimit,
      freeEntriesPerUser,
      maxTotalEntries: maxTotalEntries ?? null,
      minViewSeconds: isVideoCrucible ? minViewSeconds ?? null : null,
      maxClipSeconds: isVideoCrucible ? maxClipSeconds ?? null : null,
      prizePositions: prizePositions as Prisma.JsonObject,
      allowedResources: requiresResources
        ? (allowedResources as Prisma.JsonArray)
        : Prisma.JsonNull,
      allowedBaseModels,
      duration: duration * 60, // Convert hours to minutes for storage
      startAt: null,
      endAt: null,
      status: CrucibleStatus.Pending,
      ingestion: CrucibleIngestionStatus.Pending,
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
      logToAxiom({
        type: 'error',
        name: 'crucible-unpaid-delete-failed',
        message: `Failed to delete unpaid crucible ${created.id}: ${String(deleteError)}`,
        crucibleId: created.id,
      });
    });
    throw error;
  }

  let opened: Awaited<ReturnType<typeof dbWrite.crucible.update>>;
  try {
    opened = await dbWrite.crucible.update({
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

  await scanCrucible(opened.id);
  return opened;
};

export const buildCrucibleModerationText = ({
  name,
  description,
}: {
  name: string;
  description: string | null;
}) => [name, description ? removeTags(description) : null].filter(Boolean).join('\n');

/**
 * Queues the name + description for the async text scan; `crucibleModerationAdapter` applies the
 * verdict. The crucible stays hidden from everyone but its creator and moderators until Scanned.
 */
export async function scanCrucible(crucibleId: number, { forceRescan = false } = {}) {
  // The primary: called right after a write, and a lagging replica would scan the old text.
  const crucible = await dbWrite.crucible.findUnique({
    where: { id: crucibleId },
    select: { name: true, description: true },
  });
  if (!crucible) return;

  try {
    await submitTextModeration({
      entityType: 'Crucible',
      entityId: crucibleId,
      content: buildCrucibleModerationText(crucible),
      labels: [...CHALLENGE_MODERATION_LABELS],
      priority: 'low',
      forceRescan,
    });
  } catch (e) {
    // A failed submit leaves a Failed EntityModeration row that the retry cron picks up; creating
    // or editing must not fail on a moderation hiccup.
    logToAxiom({
      type: 'error',
      name: 'crucible-scan-failed',
      message: e instanceof Error ? e.message : String(e),
      crucibleId,
    });
  }
}

const levelsIntersecting = (level: number) =>
  Array.from({ length: 63 }, (_, i) => i + 1).filter((mask) => (mask & level) !== 0);

type CrucibleViewer = {
  viewerId?: number;
  isModerator?: boolean;
  isGreen?: boolean;
  blockedByUserIds?: number[];
};
type CrucibleVisibilityRow = {
  userId: number;
  nsfwLevel: number;
  textNsfw: boolean;
  ingestion: CrucibleIngestionStatus;
  image: { ingestion: ImageIngestionStatus } | null;
};

/** Until its text and cover pass their scans, only its creator and moderators see a crucible. */
export const isCrucibleHiddenByScan = (
  crucible: Omit<CrucibleVisibilityRow, 'nsfwLevel' | 'textNsfw'>,
  { viewerId, isModerator }: CrucibleViewer
) =>
  !isModerator &&
  crucible.userId !== viewerId &&
  (crucible.ingestion !== CrucibleIngestionStatus.Scanned ||
    crucible.image?.ingestion !== ImageIngestionStatus.Scanned);

/** As on its detail page, a creator who blocked the viewer hides the crucible from them. */
const isCrucibleBlockedForViewer = (
  crucible: Pick<CrucibleVisibilityRow, 'userId'>,
  { isModerator, blockedByUserIds = [] }: CrucibleViewer
) => !isModerator && blockedByUserIds.includes(crucible.userId);

const isCrucibleOffSite = (
  crucible: Pick<CrucibleVisibilityRow, 'userId' | 'nsfwLevel' | 'textNsfw'>,
  { viewerId, isModerator, isGreen }: CrucibleViewer
) => !!isGreen && !isModerator && crucible.userId !== viewerId && !isCrucibleSfw(crucible);

const greenSiteSql = (isGreen: boolean) =>
  isGreen
    ? Prisma.sql`AND c."nsfwLevel" = ANY(${CRUCIBLE_SFW_LEVELS}::int[]) AND NOT c."textNsfw"`
    : Prisma.empty;

/** Crucible `c` with cover `i`, as list surfaces may show it to a viewer at `viewerLevel`. */
const crucibleListedSql = (viewerLevel: number) => Prisma.sql`
  c.ingestion = ${CrucibleIngestionStatus.Scanned}::"CrucibleIngestionStatus"
  AND i.ingestion = ${ImageIngestionStatus.Scanned}::"ImageIngestionStatus"
  ${
    viewerLevel > 0 && !Flags.intersects(viewerLevel, nsfwBrowsingLevelsFlag)
      ? Prisma.sql`AND NOT c."textNsfw"`
      : Prisma.empty
  }
`;

/** `publishedImageWhere` for entry image `i`. */
const publishedEntryImageSql = Prisma.sql`
  i."needsReview" IS NULL
  AND NOT i."tosViolation"
  AND EXISTS (SELECT 1 FROM "Post" ep WHERE ep.id = i."postId" AND ep."publishedAt" <= now())
`;

/**
 * Entry image `i` as someone else may see it: still scanned and published as `submitEntry` required
 * (a review hold, a ToS flag or an unpublished post can come later), still inside the crucible's
 * levels (a re-rating can move it out), and inside the viewer's level.
 */
const visibleEntryImageSql = (
  crucibleLevel: number | Prisma.Sql,
  viewerLevel: number
) => Prisma.sql`
  i.ingestion = ${ImageIngestionStatus.Scanned}::"ImageIngestionStatus"
  AND ${publishedEntryImageSql}
  AND (i."nsfwLevel" & ${crucibleLevel}) <> 0
  ${viewerLevel > 0 ? Prisma.sql`AND (i."nsfwLevel" & ${viewerLevel}) <> 0` : Prisma.empty}
`;

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

async function assertRequiredModelsMakeContentType(versionIds: number[], contentType: MediaType) {
  const ids = [...new Set(versionIds)];
  if (!ids.length) return;
  const versions = await dbRead.modelVersion.findMany({
    where: { id: { in: ids } },
    select: { baseModel: true },
  });
  if (versions.some(({ baseModel }) => !baseModelMakesMediaType(baseModel, contentType)))
    throw throwBadRequestError(`Every required model must make ${contentType}s.`);
}

function assertBaseModelsMakeContentType(baseModels: string[], contentType: MediaType) {
  if (baseModels.some((baseModel) => !baseModelMakesMediaType(baseModel, contentType)))
    throw throwBadRequestError(`Every allowed base model must make ${contentType}s.`);
}

const hasEntryRestriction = ({
  allowedResources,
  allowedBaseModels,
}: {
  allowedResources?: number[];
  allowedBaseModels?: string[];
}) => (allowedResources?.length ?? 0) > 0 || (allowedBaseModels?.length ?? 0) > 0;

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
      freeEntriesPerUser: true,
      maxTotalEntries: true,
      minViewSeconds: true,
      maxClipSeconds: true,
      prizePositions: true,
      allowedResources: true,
      allowedBaseModels: true,
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
    freeEntriesPerUser: crucible.freeEntriesPerUser,
    maxTotalEntries: crucible.maxTotalEntries ?? undefined,
    minViewSeconds: crucible.minViewSeconds,
    maxClipSeconds: crucible.maxClipSeconds,
    prizePositions: currentPositions,
    allowedResources: Array.isArray(crucible.allowedResources)
      ? (crucible.allowedResources as number[])
      : [],
    allowedBaseModels: crucible.allowedBaseModels,
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
  // Only a real text change resets the verdict: an unchanged resubmit dedups on its content hash,
  // so no callback would ever move it back to Scanned.
  const textChanged =
    buildCrucibleModerationText({ name: nextName, description: nextDescription }) !==
    buildCrucibleModerationText({ name: crucible.name, description: crucible.description });
  await throwOnBlockedUserContent([nextName, nextDescription], {
    isModerator,
    surface: 'crucible',
  });
  if (!isModerator) assertSfwCrucibleText([nextName, nextDescription], next.nsfwLevel);
  // Only newly added ones: a required model unpublished later shouldn't block editing the rest.
  const addedResources = next.allowedResources.filter(
    (versionId) => !current.allowedResources.includes(versionId)
  );
  await assertPublishedModelVersions(addedResources);
  // A content type switch re-checks every pick, since an earlier one can now make the wrong media.
  if (canEditSettings) {
    const contentTypeChanged = next.contentType !== current.contentType;
    await assertRequiredModelsMakeContentType(
      contentTypeChanged ? next.allowedResources : addedResources,
      next.contentType
    );
    assertBaseModelsMakeContentType(
      contentTypeChanged
        ? next.allowedBaseModels
        : next.allowedBaseModels.filter(
            (baseModel) => !current.allowedBaseModels.includes(baseModel)
          ),
      next.contentType
    );
  }

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
    ...(textChanged && { ingestion: CrucibleIngestionStatus.Pending, scannedAt: null }),
  };

  let settlement: Awaited<ReturnType<typeof settleCrucibleCostChange>> = null;
  if (canEditSettings) {
    const isVideo = crucibleSupportsVideoSettings(next.contentType);
    Object.assign(data, {
      contentType: next.contentType,
      entryFee: next.entryFee,
      entryLimit: next.entryLimit,
      freeEntriesPerUser: next.freeEntriesPerUser,
      maxTotalEntries: next.maxTotalEntries ?? null,
      minViewSeconds: isVideo ? next.minViewSeconds ?? null : null,
      maxClipSeconds: isVideo ? next.maxClipSeconds ?? null : null,
      prizePositions: next.prizePositions as Prisma.JsonObject,
      allowedResources: next.allowedResources.length
        ? (next.allowedResources as Prisma.JsonArray)
        : Prisma.JsonNull,
      allowedBaseModels: next.allowedBaseModels,
      duration: next.duration * 60,
      seededPrizePool: next.seededPrizePool,
      // Settings change only before start, when nobody has paid in yet.
      prizePool: next.seededPrizePool,
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

  let updated: Awaited<ReturnType<typeof dbWrite.crucible.update>>;
  try {
    // On the status read above: a cancel since then has already refunded the creator, and writing
    // the status back would revive a crucible whose seed is gone.
    updated = await dbWrite.crucible.update({ where: { id, status: crucible.status }, data });
  } catch (error) {
    await settlement?.rollback();
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025')
      throw throwBadRequestError(
        'This crucible changed while you were editing it. Reload the page and try again.'
      );
    throw error;
  }

  if (textChanged) await scanCrucible(id);
  return updated;
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
      // A cancel that landed mid-edit found the original charges already refunded, so charging
      // them back onto a cancelled crucible would leave the creator paying for nothing.
      const { count } = await dbWrite.crucible.updateMany({
        where: { id: crucibleId, status: { not: CrucibleStatus.Cancelled } },
        data: legTransactionIds(refunded, restored),
      });
      if (!count)
        await refundCrucibleCharges(
          [restored.buzzTransactionId, restored.seedTransactionId].filter(isDefined),
          'crucible cancelled during edit',
          details
        );
    } catch (error) {
      logToAxiom({
        type: 'error',
        name: 'crucible-edit-restore-failed',
        message: `Failed to restore the original charges on crucible ${crucibleId}: ${String(
          error
        )}`,
        crucibleId,
        userId,
        refunded,
      });
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

/**
 * Entries that paid the fee, by crucible: the ones holding a fee transaction. Read from the rows,
 * not from `freeEntriesPerUser`, so the pool can never count an entry the bank was not paid for.
 */
export async function getPaidEntryCounts(crucibleIds: number[], db: typeof dbRead = dbRead) {
  const counts = new Map(crucibleIds.map((id) => [id, 0]));
  if (!crucibleIds.length) return counts;

  const paid = await db.crucibleEntry.groupBy({
    by: ['crucibleId'],
    where: { crucibleId: { in: crucibleIds }, buzzTransactionId: { not: null } },
    _count: { _all: true },
  });
  for (const { crucibleId, _count } of paid) counts.set(crucibleId, _count._all);
  return counts;
}

export async function withPaidEntryCount<T extends { id: number }>(rows: T[]) {
  const counts = await getPaidEntryCounts(rows.map(({ id }) => id));
  return rows.map((row) => ({ ...row, paidEntryCount: counts.get(row.id) ?? 0 }));
}

export type CrucibleDetailEntry = Omit<CrucibleEntryRow, 'score' | 'position'> & {
  score: number | null;
  position: number | null;
};

export type CrucibleDetail = CrucibleDetailRow & {
  paidEntryCount: number;
  /** The caller's own entries; everyone else's are paged through `getCrucibleEntries`. */
  viewerEntries: CrucibleEntryRow[];
  /** Entries that got enough votes to place, once completed; prizes split among these. */
  placedEntryCount: number | null;
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

  const [paidEntryCounts, viewerEntries, placedEntryCount] = await Promise.all([
    getPaidEntryCounts([id]),
    userId
      ? dbRead.crucibleEntry
          .findMany({
            where: { crucibleId: id, userId },
            select: crucibleEntrySelect,
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          })
          .then((entries) => entries.filter(hasEntryImage))
      : [],
    crucible.status === CrucibleStatus.Completed
      ? dbRead.crucibleEntry.count({ where: { crucibleId: id, position: { not: null } } })
      : null,
  ]);

  return {
    ...crucible,
    paidEntryCount: paidEntryCounts.get(id) ?? 0,
    viewerEntries,
    placedEntryCount,
  };
};

export const getCrucibleEntries = async ({
  crucibleId,
  limit,
  cursor,
  seed = 0,
  userId,
  browsingLevel,
  isGreen = false,
  isModerator = false,
  blockedByUserIds,
}: GetCrucibleEntriesSchema & {
  userId?: number;
  isGreen?: boolean;
  isModerator?: boolean;
  blockedByUserIds?: number[];
}) => {
  const crucible = await dbRead.crucible.findUnique({
    where: { id: crucibleId },
    select: {
      status: true,
      userId: true,
      textNsfw: true,
      nsfwLevel: true,
      ingestion: true,
      image: { select: { ingestion: true } },
    },
  });
  const viewer = { viewerId: userId, isModerator, isGreen, blockedByUserIds };
  if (
    !crucible ||
    isCrucibleHiddenByScan(crucible, viewer) ||
    isCrucibleOffSite(crucible, viewer) ||
    isCrucibleBlockedForViewer(crucible, viewer)
  )
    throw throwNotFoundError('Crucible not found');

  const viewerLevel = getEffectiveBrowsingLevel({
    isGreen,
    isLoggedIn: !!userId,
    requested: browsingLevel,
  });
  const rankingsFinal = crucibleRankingsAreFinal(crucible.status);
  const page = {
    crucibleId,
    limit: limit + 1,
    cursor,
    viewerId: userId,
    visibleImage: visibleEntryImageSql(crucible.nsfwLevel, viewerLevel),
  };
  const rows = rankingsFinal
    ? await getRankedEntries(page)
    : await getShuffledEntries({ ...page, seed });

  // The row fetched past the page opens the next one, so both page queries compare with `>=`.
  const nextCursor = rows.length > limit ? rows.pop()?.id : undefined;
  const items: CrucibleDetailEntry[] = rankingsFinal
    ? rows
    : rows.map((entry) =>
        entry.userId === userId ? entry : { ...entry, score: null, position: null }
      );

  return { items, nextCursor };
};

type EntryPageArgs = {
  crucibleId: number;
  limit: number;
  cursor?: number;
  viewerId?: number;
  visibleImage: Prisma.Sql;
};

const loadEntriesInOrder = async (ids: { id: number }[]) => {
  if (!ids.length) return [];
  const byId = new Map(
    (
      await dbRead.crucibleEntry.findMany({
        where: { id: { in: ids.map(({ id }) => id) } },
        select: crucibleEntrySelect,
      })
    ).map((entry) => [entry.id, entry])
  );
  return ids
    .map(({ id }) => byId.get(id))
    .filter(isDefined)
    .filter(hasEntryImage);
};

const UNPLACED_SORT_POSITION = 2147483647;
const rankKeySql = (alias: string) =>
  Prisma.sql`COALESCE(${Prisma.raw(alias)}.position, ${UNPLACED_SORT_POSITION}::int), -${Prisma.raw(
    alias
  )}.score, ${Prisma.raw(alias)}."createdAt", ${Prisma.raw(alias)}.id`;

/**
 * Placings first, then unplaced entries by score. In SQL because Prisma pages in memory, without a
 * LIMIT, once a nullable column like `position` is in a cursor query's orderBy.
 */
const getRankedEntries = async ({
  crucibleId,
  limit,
  cursor,
  viewerId,
  visibleImage,
}: EntryPageArgs) => {
  const ids = await dbRead.$queryRaw<{ id: number }[]>`
    SELECT ce.id
    FROM "CrucibleEntry" ce
    JOIN "Image" i ON i.id = ce."imageId"
    WHERE ce."crucibleId" = ${crucibleId}
      AND (${viewerId ? Prisma.sql`ce."userId" = ${viewerId} OR` : Prisma.empty} (${visibleImage}))
      ${
        cursor
          ? Prisma.sql`AND (${rankKeySql('ce')}) >= (SELECT ${rankKeySql(
              'c'
            )} FROM "CrucibleEntry" c WHERE c.id = ${cursor})`
          : Prisma.empty
      }
    ORDER BY ${rankKeySql('ce')}
    LIMIT ${limit}
  `;
  return loadEntriesInOrder(ids);
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
  viewerId,
  visibleImage,
}: EntryPageArgs & { seed: number }) => {
  const salt = `:${seed}`;
  const ids = await dbRead.$queryRaw<{ id: number }[]>`
    SELECT ce.id
    FROM "CrucibleEntry" ce
    JOIN "Image" i ON i.id = ce."imageId"
    WHERE ce."crucibleId" = ${crucibleId}
      AND (${viewerId ? Prisma.sql`ce."userId" = ${viewerId} OR` : Prisma.empty} (${visibleImage}))
      ${
        cursor
          ? Prisma.sql`AND (md5(ce.id::text || ${salt}), ce.id) >= (md5(${cursor}::int::text || ${salt}), ${cursor}::int)`
          : Prisma.empty
      }
    ORDER BY md5(ce.id::text || ${salt}), ce.id
    LIMIT ${limit}
  `;
  return loadEntriesInOrder(ids);
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
  const visible: Prisma.CrucibleWhereInput[] = [
    {
      ingestion: CrucibleIngestionStatus.Scanned,
      image: { ingestion: ImageIngestionStatus.Scanned },
    },
  ];
  if (effectiveLevel > 0) {
    const levels = levelsIntersecting(effectiveLevel);
    visible.push({ nsfwLevel: { in: levels }, image: { nsfwLevel: { in: levels } } });
    if (!Flags.intersects(effectiveLevel, nsfwBrowsingLevelsFlag))
      visible.push({ textNsfw: false });
  }
  and.push(viewerId ? { OR: [{ userId: viewerId }, { AND: visible }] } : { AND: visible });

  if (isGreen) {
    const onSite: Prisma.CrucibleWhereInput = {
      nsfwLevel: { in: CRUCIBLE_SFW_LEVELS },
      textNsfw: false,
    };
    and.push(viewerId ? { OR: [{ userId: viewerId }, onSite] } : onSite);
  }
  where.AND = and;

  // "Ending soon" only means something for crucibles still running; without this, an unfiltered
  // feed would lead with the ones that ended longest ago.
  const picked = status?.length
    ? status
    : sort === CrucibleSort.EndingSoon
    ? [CrucibleStatus.Active]
    : [CrucibleStatus.Active, CrucibleStatus.Pending];
  const statuses = isModerator ? picked : picked.filter((s) => s !== CrucibleStatus.Cancelled);
  if (!statuses.length) return { items: [], nextCursor: undefined };
  where.status = { in: statuses };
  if (contentType) where.contentType = contentType;

  if (excludedUserIds.length > 0) {
    where.userId = { notIn: excludedUserIds };
  }

  // Apply sorting
  const orderBy: Prisma.CrucibleFindManyArgs['orderBy'] = [];

  if (sort === CrucibleSort.PrizePool) {
    orderBy.push({ prizePool: 'desc' });
    orderBy.push({ createdAt: 'desc' });
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
  isGreen = false,
  isModerator = false,
  blockedByUserIds,
}: CreateEntryPostSchema & {
  userId: number;
  isGreen?: boolean;
  isModerator?: boolean;
  blockedByUserIds?: number[];
}) => {
  const crucible = await dbRead.crucible.findUnique({
    where: { id: crucibleId },
    select: {
      name: true,
      status: true,
      endAt: true,
      userId: true,
      nsfwLevel: true,
      ingestion: true,
      textNsfw: true,
      image: { select: { ingestion: true } },
    },
  });
  const viewer = { viewerId: userId, isGreen, isModerator, blockedByUserIds };
  if (
    !crucible ||
    isCrucibleHiddenByScan(crucible, viewer) ||
    isCrucibleOffSite(crucible, viewer) ||
    isCrucibleBlockedForViewer(crucible, viewer)
  )
    throw throwNotFoundError('Crucible not found');
  if (crucible.status !== CrucibleStatus.Active || (crucible.endAt && new Date() > crucible.endAt))
    throw throwBadRequestError('This crucible is not accepting entries');
  if (crucible.userId === userId) throw throwBadRequestError(CANNOT_ENTER_OWN_CRUCIBLE);

  const post = await createPost({
    userId,
    title: getCruciblePublishableName(crucible) ?? undefined,
    publishedAt: new Date(),
  });
  return { id: post.id };
};

const CANNOT_ENTER_OWN_CRUCIBLE = "You can't enter a crucible you created";

export type CrucibleEntryIneligibleReason =
  | 'created-before-start'
  | 'no-resources'
  | 'missing-required-resource'
  | 'wrong-base-model'
  | 'not-found';

const entryIneligibleMessages: Record<CrucibleEntryIneligibleReason, string> = {
  'created-before-start': 'Only media created after this crucible started can be entered.',
  'no-resources':
    'This image has no detected resources. Images submitted to this crucible must use specific resources.',
  'missing-required-resource':
    'This image does not use any of the required resources for this crucible. Please check the crucible requirements and submit an image that uses an allowed resource.',
  'wrong-base-model':
    "This image wasn't made with a checkpoint of one of this crucible's allowed base models.",
  'not-found': 'Image not found',
};

type EntryEligibilityCrucible = {
  startAt: Date | null;
  createdAt: Date;
  allowedResources: Prisma.JsonValue;
  allowedBaseModels: string[];
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
  const { allowedBaseModels } = crucible;
  const restricted = hasEntryRestriction({ allowedResources, allowedBaseModels });
  const resourcesByImage =
    restricted && images.length > 0
      ? await imageResourcesCache.fetch(images.map((image) => image.id))
      : {};

  return new Map(
    images.map((image) => {
      const reasons: CrucibleEntryIneligibleReason[] = [];
      if (image.createdAt < startedAt) reasons.push('created-before-start');

      if (restricted) {
        const resources = resourcesByImage[image.id]?.resources ?? [];
        if (resources.length === 0) reasons.push('no-resources');
        else {
          if (
            allowedResources.length > 0 &&
            !resources.some(({ modelVersionId }) => allowedResources.includes(modelVersionId))
          )
            reasons.push('missing-required-resource');
          // The checkpoint is the weight class; a LoRA's base model says nothing about what ran it.
          if (
            allowedBaseModels.length > 0 &&
            !resources.some(
              ({ modelType, baseModel }) =>
                modelType === ModelType.Checkpoint && allowedBaseModels.includes(baseModel)
            )
          )
            reasons.push('wrong-base-model');
        }
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
    select: { startAt: true, createdAt: true, allowedResources: true, allowedBaseModels: true },
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

// Long enough to cover a submit's charge and insert; the token stops an expired holder's release
// from deleting the lock a later submit took.
const ENTRY_LOCK_TTL_MS = 30_000;
const ENTRY_REFUND_ATTEMPTS = 3;

/**
 * One submit per user per crucible at a time, so two can't both read the same entry count. Throws
 * when Redis is unavailable rather than letting overlapping submits through.
 * @returns the lock token, or null if another submit holds it
 */
async function acquireEntryLock(crucibleId: number, userId: number): Promise<string | null> {
  const token: string = randomUUID();
  const result = await sysRedis.set(getEntryLockKey(crucibleId, userId), token, {
    PX: ENTRY_LOCK_TTL_MS,
    NX: true,
  });
  return result === 'OK' ? token : null;
}

const DELETE_IF_EQUALS_SCRIPT =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0";

async function releaseEntryLock(crucibleId: number, userId: number, token: string) {
  try {
    await sysRedis.eval(DELETE_IF_EQUALS_SCRIPT, {
      keys: [getEntryLockKey(crucibleId, userId)],
      arguments: [token],
    });
  } catch (error) {
    log(
      `Failed to release entry lock for crucible ${crucibleId}, user ${userId}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`
    );
  }
}

/**
 * Submit an entry to a crucible
 */
export const submitEntry = async ({
  crucibleId,
  imageId,
  userId,
  isGreen = false,
  isModerator = false,
  blockedByUserIds,
}: SubmitEntrySchema & {
  userId: number;
  isGreen?: boolean;
  isModerator?: boolean;
  blockedByUserIds?: number[];
}) => {
  const lockToken = await acquireEntryLock(crucibleId, userId);
  if (!lockToken) {
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
        freeEntriesPerUser: true,
        maxTotalEntries: true,
        maxClipSeconds: true,
        allowedResources: true,
        allowedBaseModels: true,
        startAt: true,
        createdAt: true,
        endAt: true,
        ingestion: true,
        textNsfw: true,
        image: { select: { ingestion: true } },
        _count: {
          select: { entries: true },
        },
      },
    });

    const viewer = { viewerId: userId, isGreen, isModerator, blockedByUserIds };
    if (
      !crucible ||
      isCrucibleHiddenByScan(crucible, viewer) ||
      isCrucibleOffSite(crucible, viewer) ||
      isCrucibleBlockedForViewer(crucible, viewer)
    ) {
      return throwNotFoundError('Crucible not found');
    }

    if (crucible.userId === userId) {
      return throwBadRequestError(CANNOT_ENTER_OWN_CRUCIBLE);
    }

    // Green Buzz never pays into a crucible the green site doesn't list, moderator or not.
    if (isGreen && !isCrucibleSfw(crucible)) {
      return throwBadRequestError('Enter this crucible on civitai.red.');
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

    // The primary, under the lock: a replica that has not seen this user's last entry would
    // hand out a free slot they already used.
    const userEntryCount = await dbWrite.crucibleEntry.count({
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
        ingestion: true,
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

    // Judging and the grid only show scanned entries, so an unscanned one would be paid for unseen.
    if (image.ingestion !== ImageIngestionStatus.Scanned) {
      return throwBadRequestError('This image is still being checked. Try again once it finishes.');
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

    let buzzTransactionId: string | null = null;
    const isFreeEntry = isFreeCrucibleEntry({
      entriesSoFar: userEntryCount,
      freeEntriesPerUser: crucible.freeEntriesPerUser,
    });

    if (crucible.entryFee > 0 && !isFreeEntry) {
      // Refunds reverse this transaction, so an entry is always returned in the currency it paid.
      const entryBuzzType = getCrucibleEntryBuzzType(isGreen);
      const userAccount = await getUserBuzzAccount({
        accountId: userId,
        accountTypes: [entryBuzzType],
      });
      const totalBalance = userAccount.reduce((sum, acc) => sum + acc.balance, 0);

      if (totalBalance < crucible.entryFee) {
        const shortage = crucible.entryFee - totalBalance;
        return throwInsufficientFundsError(
          `You need ${crucible.entryFee.toLocaleString()} ${entryBuzzType} Buzz to enter this crucible. You currently have ${totalBalance.toLocaleString()} (${shortage.toLocaleString()} short).`
        );
      }

      // Generate transaction prefix for potential refunds
      const transactionPrefix = getCrucibleEntryTransactionPrefix(crucibleId, userId);

      await createMultiAccountBuzzTransaction({
        fromAccountId: userId,
        fromAccountTypes: [entryBuzzType],
        toAccountId: 0, // Central bank
        amount: crucible.entryFee,
        type: TransactionType.Fee,
        externalTransactionIdPrefix: transactionPrefix,
        description: getCrucibleTransactionDescription('Crucible entry fee', crucible),
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
      const entry = await dbWrite.$transaction(async (tx) => {
        // Holding the crucible row makes a cancel's or finalize's claim wait for this insert, so
        // they read the entry; once they've claimed, the status check here refuses it instead.
        const open = await tx.$executeRaw`
          UPDATE "Crucible"
          SET "prizePool" = "prizePool" + ${buzzTransactionId ? crucible.entryFee : 0}
          WHERE id = ${crucibleId}
            AND status = ${CrucibleStatus.Active}::"CrucibleStatus"
            AND ("endAt" IS NULL OR "endAt" > statement_timestamp())
        `;
        if (!open) throw throwBadRequestError('This crucible is not accepting entries');
        return tx.crucibleEntry.create({
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
      });

      if (crucible.userId !== userId) {
        sendCrucibleNotification({
          userId: crucible.userId,
          type: 'crucible-entry-submitted',
          category: NotificationCategory.Update,
          key: `crucible-entry-submitted:${crucibleId}:${entry.id}`,
          details: {
            crucibleId,
            crucibleName: getCruciblePublishableName(crucible),
            entrantUsername: entry.user.username ?? 'Anonymous',
          },
        });
      }

      return entry;
    } catch (error) {
      // The entry wasn't saved — refused at the deadline or a failed write — so return its fee.
      // Retried, since a refusal near the end is routine rather than a rare failure.
      if (buzzTransactionId) {
        let lastError: unknown;
        for (let attempt = 1; attempt <= ENTRY_REFUND_ATTEMPTS; attempt++) {
          try {
            await refundCrucibleTransactionOnce({
              externalTransactionIdPrefix: buzzTransactionId,
              description: getCrucibleTransactionDescription(
                'Crucible entry fee refund - entry not saved',
                crucible
              ),
              crucibleId,
              label: `entry fee ${buzzTransactionId}`,
              reason: 'entry-not-saved',
            });
            lastError = undefined;
            break;
          } catch (refundError) {
            lastError = refundError;
            if (attempt < ENTRY_REFUND_ATTEMPTS)
              await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
          }
        }
        if (lastError)
          logToAxiom({
            type: 'error',
            name: 'crucible-entry-fee-refund-failed',
            message: `Failed to refund entry fee ${buzzTransactionId} for an entry that wasn't saved: ${
              lastError instanceof Error ? lastError.message : String(lastError)
            }`,
            crucibleId,
            userId,
            buzzTransactionId,
          });
      }
      // Re-throw the original error
      throw error;
    }
  } finally {
    await releaseEntryLock(crucibleId, userId, lockToken);
  }
};

/**
 * Redis key for tracking voted pairs per user per crucible
 */
function getVotedPairsKey(crucibleId: number, userId: number): RedisKeyTemplateSys {
  return `${REDIS_SYS_KEYS.CRUCIBLE.VOTED_PAIRS}:${crucibleId}:${userId}` as RedisKeyTemplateSys;
}

function getServedPairKey(crucibleId: number, userId: number): RedisKeyTemplateSys {
  return `${REDIS_SYS_KEYS.CRUCIBLE.SERVED_PAIR}:${crucibleId}:${userId}` as RedisKeyTemplateSys;
}

function getJudgeEntryVotesKey(crucibleId: number, userId: number): RedisKeyTemplateSys {
  return `${REDIS_SYS_KEYS.CRUCIBLE.JUDGE_ENTRY_VOTES}:${crucibleId}:${userId}` as RedisKeyTemplateSys;
}

const JUDGE_KEY_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Bounds how far one judge can move a single entry. */
export const CRUCIBLE_MAX_VOTES_PER_JUDGE_PER_ENTRY = 5;

/**
 * Counts the vote against both entries before it is processed, so concurrent votes cannot each
 * pass a read of the same count.
 * @returns a release that takes the counts back, or null when either entry is already at the cap
 */
async function reserveJudgeEntryVotes(
  crucibleId: number,
  userId: number,
  entryIds: [number, number]
): Promise<(() => Promise<void>) | null> {
  const key = getJudgeEntryVotesKey(crucibleId, userId);
  const fields = entryIds.map(String);
  const release = async () => {
    await Promise.all(fields.map((field) => sysRedis.hIncrBy(key, field, -1)));
  };
  const [counts] = await Promise.all([
    Promise.all(fields.map((field) => sysRedis.hIncrBy(key, field, 1))),
    sysRedis.expire(key, JUDGE_KEY_TTL_SECONDS),
  ]);
  if (counts.some((count) => count > CRUCIBLE_MAX_VOTES_PER_JUDGE_PER_ENTRY)) {
    await release();
    return null;
  }
  return release;
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

/** Seconds of playback each side needs before a vote is accepted; null when there is no rule. */
export type JudgingWatchSeconds = { left: number | null; right: number | null };

export type JudgingPair = {
  left: EntryForJudging;
  right: EntryForJudging;
  watchSeconds: JudgingWatchSeconds;
} | null;

export type JudgingPairForClient = {
  left: Omit<EntryForJudging, 'score'>;
  right: Omit<EntryForJudging, 'score'>;
  watchSeconds: JudgingWatchSeconds;
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

  return { left: project(pair.left), right: project(pair.right), watchSeconds: pair.watchSeconds };
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
  visibleImage: Prisma.Sql,
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
          AND ${visibleImage}
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
          AND ${visibleImage}
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

/**
 * Unjudged pairs among entries this judge can still vote on, bounded by the votes left on them: a
 * vote spends one of each entry's per-judge allowance.
 */
export function countRemainingPairs({
  entryIds,
  judgeEntryVotes,
  votedPairKeys,
  maxVotesPerEntry,
}: {
  entryIds: number[];
  judgeEntryVotes: Record<string, string>;
  votedPairKeys: string[];
  maxVotesPerEntry: number;
}) {
  const votesLeft = new Map<number, number>();
  for (const id of entryIds) {
    const left = maxVotesPerEntry - Number(judgeEntryVotes[id] ?? 0);
    if (left > 0) votesLeft.set(id, left);
  }
  const n = votesLeft.size;
  if (n < 2) return 0;

  const votedAmongThem = votedPairKeys.filter((key) => {
    const [a, b] = key.split(':').map(Number);
    return votesLeft.has(a) && votesLeft.has(b);
  }).length;
  const totalVotesLeft = [...votesLeft.values()].reduce((sum, left) => sum + left, 0);
  return Math.max(0, Math.min((n * (n - 1)) / 2 - votedAmongThem, Math.floor(totalVotesLeft / 2)));
}

export const getJudgingProgress = async ({
  crucibleId,
  userId,
  browsingLevel,
  isGreen = false,
  isModerator = false,
  blockedByUserIds,
}: GetJudgingProgressSchema & {
  userId: number;
  isGreen?: boolean;
  isModerator?: boolean;
  blockedByUserIds?: number[];
}) => {
  const crucible = await dbRead.crucible.findUnique({
    where: { id: crucibleId },
    select: {
      status: true,
      endAt: true,
      userId: true,
      textNsfw: true,
      nsfwLevel: true,
      ingestion: true,
      image: { select: { ingestion: true } },
    },
  });
  const viewer = { viewerId: userId, isModerator, isGreen, blockedByUserIds };
  if (
    !crucible ||
    isCrucibleHiddenByScan(crucible, viewer) ||
    isCrucibleOffSite(crucible, viewer) ||
    isCrucibleBlockedForViewer(crucible, viewer)
  )
    throw throwNotFoundError('Crucible not found');
  if (crucible.status !== CrucibleStatus.Active || (crucible.endAt && crucible.endAt <= new Date()))
    return { remainingPairs: 0 };

  const visibleImage = visibleEntryImageSql(
    crucible.nsfwLevel,
    getEffectiveBrowsingLevel({ isGreen, isLoggedIn: true, requested: browsingLevel })
  );
  const [entries, judgeEntryVotes, votedPairKeys] = await Promise.all([
    dbRead.$queryRaw<{ id: number }[]>`
      SELECT ce.id
      FROM "CrucibleEntry" ce
      JOIN "Image" i ON i.id = ce."imageId"
      WHERE ce."crucibleId" = ${crucibleId}
        AND ce."userId" != ${userId}
        AND ${visibleImage}
    `,
    sysRedis.hGetAll(getJudgeEntryVotesKey(crucibleId, userId)),
    sysRedis.sMembers(getVotedPairsKey(crucibleId, userId)),
  ]);

  return {
    remainingPairs: countRemainingPairs({
      entryIds: entries.map(({ id }) => id),
      judgeEntryVotes: (judgeEntryVotes ?? {}) as Record<string, string>,
      votedPairKeys,
      maxVotesPerEntry: CRUCIBLE_MAX_VOTES_PER_JUDGE_PER_ENTRY,
    }),
  };
};

type RatedEntry = EntryForJudging & { votes: number; judgeVotes: number };

/**
 * The least-voted entry, against the nearest-rated of the least-voted opponents this judge hasn't
 * already paired it with. "Least-voted" ranks this judge's own votes on the entry before everyone's:
 * a late entry stays least-voted overall for a long time, and ranked on that alone it anchors every
 * pair the judge sees until it reaches their per-judge cap.
 */
function pickUnjudgedPair(
  entries: RatedEntry[],
  votedPairs: Set<string>,
  { allowSameAuthor }: { allowSameAuthor: boolean }
) {
  const byVotes = entries
    .map((entry) => ({ entry, tieBreak: Math.random() }))
    .sort(
      (x, y) =>
        x.entry.judgeVotes - y.entry.judgeVotes ||
        x.entry.votes - y.entry.votes ||
        x.tieBreak - y.tieBreak
    )
    .map(({ entry }) => entry);

  for (const a of byVotes) {
    const opponents = byVotes
      .filter(
        (b) =>
          b.id !== a.id &&
          (allowSameAuthor || b.userId !== a.userId) &&
          !votedPairs.has(createPairKey(a.id, b.id))
      )
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
  browsingLevel,
  judgingSessionId,
  isGreen = false,
  isModerator = false,
  blockedByUserIds,
}: GetJudgingPairSchema & {
  userId: number;
  isGreen?: boolean;
  isModerator?: boolean;
  blockedByUserIds?: number[];
}): Promise<JudgingPair> => {
  const crucible = await dbRead.crucible.findUnique({
    where: { id: crucibleId },
    select: {
      id: true,
      status: true,
      endAt: true,
      userId: true,
      textNsfw: true,
      nsfwLevel: true,
      ingestion: true,
      minViewSeconds: true,
      image: { select: { ingestion: true } },
    },
  });
  const viewer = { viewerId: userId, isModerator, isGreen, blockedByUserIds };

  if (
    !crucible ||
    isCrucibleHiddenByScan(crucible, viewer) ||
    isCrucibleOffSite(crucible, viewer) ||
    isCrucibleBlockedForViewer(crucible, viewer)
  ) {
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
  const judgeVotesOn = (entry: EntryForJudging) => Number(judgeEntryVotes?.[entry.id] ?? 0);
  const underJudgeCap = (entry: EntryForJudging) =>
    judgeVotesOn(entry) < CRUCIBLE_MAX_VOTES_PER_JUDGE_PER_ENTRY;
  const rate = (entry: EntryForJudging): RatedEntry => ({
    ...entry,
    score: redisElos[entry.id] ?? entry.score,
    votes: voteCounts[entry.id] ?? 0,
    judgeVotes: judgeVotesOn(entry),
  });

  const visibleImage = visibleEntryImageSql(
    crucible.nsfwLevel,
    getEffectiveBrowsingLevel({ isGreen, isLoggedIn: true, requested: browsingLevel })
  );
  // Authors enter near-identical variants, so two entries by one author read to a judge as the
  // same clip twice. Such a pair is served only once no cross-author pair is left.
  const search = async (exclusions?: number[]) => {
    let sameAuthor: ReturnType<typeof pickUnjudgedPair> = null;
    for (let attempt = 0; attempt < MAX_SAMPLE_ATTEMPTS; attempt++) {
      const sample = await fetchEntrySample(
        crucibleId,
        userId,
        SAMPLE_SIZE,
        visibleImage,
        exclusions
      );
      const candidates = sample.filter(underJudgeCap).map(rate);
      const crossAuthor = pickUnjudgedPair(candidates, votedPairs, { allowSameAuthor: false });
      if (crossAuthor) return crossAuthor;
      sameAuthor ??= pickUnjudgedPair(candidates, votedPairs, { allowSameAuthor: true });
      // A short sample already held every entry, so another draw returns the same set.
      if (sample.length < SAMPLE_SIZE) break;
    }
    return sameAuthor;
  };

  // A skip means "not now": once only skipped entries are left, they come back instead of the
  // judge being told there is nothing left to judge. It outranks the author rule, so a same-author
  // pair is served before a skipped entry returns: re-serving the pair just skipped makes Skip
  // look broken.
  const pair = (await search(excludeEntryIds)) ?? (excludeEntryIds?.length ? await search() : null);
  if (!pair) return null;
  const { a: imageA, b: imageB } = pair;

  // Replaces the judge's previous pair, so only the pair on screen can be voted.
  await sysRedis.set(getServedPairKey(crucibleId, userId), createPairKey(imageA.id, imageB.id), {
    EX: JUDGE_KEY_TTL_SECONDS,
  });

  const swapPositions = Math.random() < 0.5;
  const left = swapPositions ? imageB : imageA;
  const right = swapPositions ? imageA : imageB;

  const [leftSeconds, rightSeconds] = await resolveWatchSeconds({
    crucibleId,
    userId,
    sessionId: judgingSessionId,
    minViewSeconds: crucible.minViewSeconds,
    entryIds: [left.id, right.id],
  });

  return { left, right, watchSeconds: { left: leftSeconds, right: rightSeconds } };
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
  judgingSessionId,
  userId,
  blockedByUserIds,
}: SubmitVoteSchema & {
  userId: number;
  blockedByUserIds?: number[];
}): Promise<SubmitVoteResult> => {
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
      userId: true,
      status: true,
      endAt: true,
      minViewSeconds: true,
    },
  });

  if (!crucible || isCrucibleBlockedForViewer(crucible, { blockedByUserIds })) {
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
  const [winnerSeconds, loserSeconds] = await resolveWatchSeconds({
    crucibleId,
    userId,
    sessionId: judgingSessionId,
    minViewSeconds: crucible.minViewSeconds,
    entryIds: [winnerEntryId, loserEntryId],
  });
  if (
    (winnerWatchedMs ?? 0) < (winnerSeconds ?? 0) * 1000 ||
    (loserWatchedMs ?? 0) < (loserSeconds ?? 0) * 1000
  ) {
    throw throwBadRequestError(
      `Watch at least ${Math.max(
        winnerSeconds ?? 0,
        loserSeconds ?? 0
      )}s of both clips before voting.`
    );
  }

  const entrySelect = { id: true, crucibleId: true, userId: true, score: true, voteCount: true };
  const [winnerEntry, loserEntry] = await Promise.all([
    dbRead.crucibleEntry.findUnique({ where: { id: winnerEntryId }, select: entrySelect }),
    dbRead.crucibleEntry.findUnique({ where: { id: loserEntryId }, select: entrySelect }),
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

  // Reserved before the served pair is claimed, so a refusal here does not burn the pair.
  const releaseJudgeEntryVotes = await reserveJudgeEntryVotes(crucibleId, userId, [
    winnerEntryId,
    loserEntryId,
  ]);
  if (!releaseJudgeEntryVotes) {
    throw throwBadRequestError(
      "You've judged one of these entries as many times as allowed. Please wait for the next pair to load."
    );
  }

  let winnerElo: number;
  let loserElo: number;
  try {
    const pairKey = createPairKey(winnerEntryId, loserEntryId);
    const served = await sysRedis.eval(DELETE_IF_EQUALS_SCRIPT, {
      keys: [getServedPairKey(crucibleId, userId)],
      arguments: [pairKey],
    });
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

    ({ winnerElo, loserElo } = await processEloVote(crucibleId, winnerEntryId, loserEntryId, {
      winner: winnerEntry,
      loser: loserEntry,
    }));
  } catch (error) {
    await releaseJudgeEntryVotes().catch((releaseError: unknown) =>
      log(
        `Failed to release judge entry votes for crucible ${crucibleId}, user ${userId}: ${
          releaseError instanceof Error ? releaseError.message : 'Unknown error'
        }`
      )
    );
    throw error;
  }

  await Promise.all([
    addJudge(crucibleId, userId),
    incrementUserVoteCount(userId),
    crucible.minViewSeconds &&
      getCrucibleJudgingConfig().then(({ sessionIdleSeconds }) =>
        recordSessionVote({
          crucibleId,
          userId,
          sessionId: judgingSessionId,
          entryIds: [winnerEntryId, loserEntryId],
          idleSeconds: sessionIdleSeconds,
        })
      ),
  ]);

  // Note: Pair was already marked as voted atomically at the start of this function
  // for race condition protection - no need to call markPairVoted again

  // Track vote in ClickHouse (fire-and-forget)
  const tracker = new Tracker();
  tracker.crucibleVote({
    userId,
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
  /** Null when the entry didn't get enough votes to place. */
  position: number | null;
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
 * An entry whose image was blocked, held for review, flagged, unpublished, or re-rated outside the
 * crucible's levels can't place; its fee stays in the pool. A scan still in progress doesn't
 * disqualify.
 */
const rankableEntryWhere = (
  crucibleId: number,
  nsfwLevel: number
): Prisma.CrucibleEntryWhereInput => ({
  crucibleId,
  image: {
    ...publishedImageWhere(),
    ingestion: { not: ImageIngestionStatus.Blocked },
    nsfwLevel: { in: levelsIntersecting(nsfwLevel) },
  },
});

export const getCrucibleRequiredModels = async ({
  crucibleId,
  browsingLevel,
  viewer,
}: {
  crucibleId: number;
  browsingLevel?: number;
  viewer: CrucibleViewer;
}) => {
  const crucible = await dbRead.crucible.findUnique({
    where: { id: crucibleId },
    select: {
      userId: true,
      nsfwLevel: true,
      textNsfw: true,
      ingestion: true,
      allowedResources: true,
      image: { select: { ingestion: true } },
    },
  });
  if (!crucible || isCrucibleHiddenByScan(crucible, viewer) || isCrucibleOffSite(crucible, viewer))
    throw throwNotFoundError('Crucible not found');

  const versionIds = Array.isArray(crucible.allowedResources)
    ? (crucible.allowedResources as number[])
    : [];
  const viewerLevel = getEffectiveBrowsingLevel({
    isGreen: !!viewer.isGreen,
    isLoggedIn: !!viewer.viewerId,
    requested: browsingLevel,
  });
  // 0 means "no filter" to entry queries; a cover nobody asked a level for stays PG.
  return getEligibleModels(versionIds, { viewerLevel: viewerLevel || publicBrowsingLevelsFlag });
};

/** From the counts the sync job last wrote, so it trails live voting by up to one sync. */
export const getCrucibleMinVotesToPlace = async ({
  crucibleId,
  viewer,
}: {
  crucibleId: number;
  viewer: CrucibleViewer;
}) => {
  const crucible = await dbRead.crucible.findUnique({
    where: { id: crucibleId },
    select: {
      userId: true,
      textNsfw: true,
      nsfwLevel: true,
      ingestion: true,
      image: { select: { ingestion: true } },
    },
  });
  if (!crucible || isCrucibleHiddenByScan(crucible, viewer) || isCrucibleOffSite(crucible, viewer))
    throw throwNotFoundError('Crucible not found');

  const { _sum, _count } = await dbRead.crucibleEntry.aggregate({
    where: rankableEntryWhere(crucibleId, crucible.nsfwLevel),
    _sum: { voteCount: true },
    _count: { _all: true },
  });
  return {
    minVotes: getCrucibleMinVotes({ totalVotes: _sum.voteCount ?? 0, entryCount: _count._all }),
  };
};

/**
 * Finalize a crucible after it has ended
 *
 * This function:
 * 1. Copies ELO scores from Redis to PostgreSQL CrucibleEntry.score
 * 2. Places entries with enough votes by ELO (entry time breaks ties); the rest stay unplaced
 * 3. Updates CrucibleEntry records with final positions
 * 4. Calculates prize amounts based on configured percentages
 * 5. Updates crucible status to 'completed'
 * 6. Cleans up Redis ELO data (sets TTL for eventual cleanup)
 *
 * @param crucibleId - The crucible ID to finalize
 * @returns Finalization results including final standings and prize amounts
 */
export const finalizeCrucible = async (crucibleId: number): Promise<FinalizeCrucibleResult> => {
  // A row lock granted only once it has ended by the database's clock: it waits for an entry insert
  // or cancel still holding the row, and neither can start after it. Everything below reads the
  // primary, so it sees what they wrote.
  const ended = await dbWrite.$executeRaw`
    UPDATE "Crucible" SET status = status
    WHERE id = ${crucibleId}
      AND status = ${CrucibleStatus.Active}::"CrucibleStatus"
      AND "endAt" <= now()
  `;
  const crucible = await dbWrite.crucible.findUnique({
    where: { id: crucibleId },
    select: {
      id: true,
      name: true,
      ingestion: true,
      textNsfw: true,
      userId: true, // Crucible creator for notification
      image: { select: { ingestion: true } },
      status: true,
      entryFee: true,
      seededPrizePool: true,
      seedTransactionId: true,
      prizePositions: true,
      endAt: true,
      nsfwLevel: true,
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

  if (!ended) throw throwBadRequestError('This crucible has not ended yet');

  // Get entry count from aggregation (no memory impact)
  const entryCount = crucible._count.entries;

  const paidEntryCounts = await getPaidEntryCounts([crucibleId], dbWrite);
  const totalPrizePool = getCrucibleTotalPrizePool({
    entryFee: crucible.entryFee,
    paidEntryCount: paidEntryCounts.get(crucibleId) ?? 0,
    seededPrizePool: crucible.seededPrizePool,
  });

  // Parse prize positions from JSON
  const prizePositions = parsePrizePositions(crucible.prizePositions);

  // ============================================================================
  // Edge Case: 0 entries
  // ============================================================================
  if (entryCount === 0) {
    // Nobody entered, so the seed has no winner to go to. Hand it back rather than stranding it in
    // the bank; fail-soft, because a stuck refund must not block the crucible from completing.
    const seedRefunded =
      !!crucible.seedTransactionId &&
      (await refundUnawardedSeed(crucibleId, crucible.seedTransactionId, 'no-entries'));

    if (await claimCrucibleCompletion(crucibleId, { prizesPaid: false })) {
      await crucibleEloRedis.setTTL(crucibleId, 7 * 24 * 60 * 60);
      sendCrucibleNotification({
        userId: crucible.userId,
        type: 'crucible-ended',
        category: NotificationCategory.Update,
        key: `crucible-ended:${crucibleId}`,
        details: {
          crucibleId,
          crucibleName: getCruciblePublishableName(crucible),
          totalEntries: 0,
          prizePool: totalPrizePool,
          seedRefunded: seedRefunded ? crucible.seededPrizePool : 0,
        },
      });
      await notifyCrucibleFollowersOfResults({
        crucible,
        crucibleName: getCruciblePublishableName(crucible),
        excludeUserIds: [crucible.userId],
      });
    }

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
    voteCount: number;
    position: number | null;
    createdAt: Date;
  }> = [];

  let cursor: number | undefined;
  while (true) {
    const batch = await dbWrite.crucibleEntry.findMany({
      where: rankableEntryWhere(crucibleId, crucible.nsfwLevel),
      select: {
        id: true,
        userId: true,
        score: true,
        voteCount: true,
        position: true,
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

  if (allEntries.length === 0) {
    logToAxiom({
      type: 'error',
      name: 'crucible-finalize-all-disqualified',
      message: `Crucible ${crucibleId} has ${entryCount} entries but none can place; no prizes are paid, the seed is refunded and the entry fees are kept.`,
      crucibleId,
    });
  }

  // ============================================================================
  // Edge Case: 1 entry (auto-win)
  // ============================================================================
  if (allEntries.length === 1) {
    log(`Edge case: Crucible ${crucibleId} has 1 entry - auto-win for entry ${allEntries[0].id}`);
  }

  const ranking = rankEntries(allEntries, {
    redisElos,
    redisVoteCounts,
    prizePositions,
    totalPrizePool,
  });
  // Written only if no run has written one, under the crucible's row lock: an earlier attempt may
  // have paid part of its ranking before failing, and an overlapping run would pay a second one.
  await dbWrite.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Crucible" WHERE id = ${crucibleId} FOR UPDATE`;
    const written = await tx.crucibleEntry.count({
      where: { crucibleId, position: { not: null } },
    });
    if (written) return;
    for (const batch of chunk(ranking, 500))
      await tx.$executeRaw`
        UPDATE "CrucibleEntry" AS ce
        SET
          score = v.score,
          position = v.position,
          "voteCount" = v."voteCount"
        FROM (VALUES ${Prisma.join(
          batch.map(
            (entry) =>
              Prisma.sql`(${entry.entryId}::int, ${entry.finalScore}::int, ${entry.position}::int, ${entry.voteCount}::int)`
          )
        )}) AS v(id, score, position, "voteCount")
        WHERE ce.id = v.id
      `;
  });

  // Paid from the stored places, whichever run wrote them and whether or not they still rank.
  const places = await dbWrite.crucibleEntry.findMany({
    where: { crucibleId, position: { not: null } },
    select: { id: true, userId: true, score: true, voteCount: true, position: true },
    orderBy: { position: 'asc' },
  });
  const finalizedEntries = withStoredPlaces(ranking, places, { prizePositions, totalPrizePool });

  // Calculate total prizes distributed (for verification)
  const totalPrizesDistributed = finalizedEntries.reduce(
    (sum, entry) => sum + entry.prizeAmount,
    0
  );

  // Distribute prizes to winners
  // Filter entries that have a prize amount > 0
  const prizeWinners = finalizedEntries.filter(
    (entry): entry is FinalizedEntry & { position: number } =>
      entry.position !== null && entry.prizeAmount > 0
  );

  if (prizeWinners.length > 0) {
    // Build transactions for prize distribution
    // Transfer from central bank (account 0) to each winner's yellow account
    const prizeTransactions = prizeWinners.map((winner) => ({
      fromAccountId: 0, // Central bank
      fromAccountType: 'yellow' as const,
      toAccountId: winner.userId,
      toAccountType: CRUCIBLE_PRIZE_BUZZ_TYPE,
      amount: winner.prizeAmount,
      type: TransactionType.Reward,
      description: getCrucibleTransactionDescription(
        `Crucible prize - ${getOrdinalPosition(winner.position)} place`,
        crucible
      ),
      details: {
        entityId: crucibleId,
        entityType: 'Crucible',
        position: winner.position,
      },
      externalTransactionId: `crucible-prize-${crucibleId}-${winner.entryId}-${winner.position}`,
    }));

    try {
      const result = await createBuzzTransactionMany(prizeTransactions);
      // A transfer the ledger dropped (neither made nor a duplicate) is still owed: stay Active.
      const unaccounted =
        prizeTransactions.length - result.transactions.length - result.conflicts.length;
      if (unaccounted > 0)
        throw new Error(
          `${unaccounted} of ${prizeTransactions.length} prize transfers were not made`
        );
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
      // Still Active, so the next run retries; prize ids are keyed per entry and place, so a payout
      // that partly landed is not paid twice.
      logToAxiom({
        type: 'error',
        name: 'crucible-prize-payout-failed',
        message: `Failed to pay prizes for crucible ${crucibleId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        crucibleId,
        winners: prizeWinners.length,
      });
      throw error;
    }
  }

  // Entries exist but nothing was paid out — none could place, an empty prizePositions map, or a
  // seed small enough that every floored share is 0. Same stranding as the 0-entry case above.
  const seedRefunded =
    !prizeWinners.length &&
    !!crucible.seedTransactionId &&
    (await refundUnawardedSeed(crucibleId, crucible.seedTransactionId, 'no-prizes-awarded'));

  const result = {
    crucibleId,
    totalPrizePool,
    finalEntries: finalizedEntries,
    totalPrizesDistributed,
  };
  if (!(await claimCrucibleCompletion(crucibleId, { prizesPaid: prizeWinners.length > 0 })))
    return result;

  // Kept a week in case the results need checking against the votes.
  await crucibleEloRedis.setTTL(crucibleId, 7 * 24 * 60 * 60);

  log(
    `Finalized crucible ${crucibleId}: ${finalizedEntries.length} entries, ${totalPrizesDistributed} Buzz in prizes`
  );

  const crucibleName = getCruciblePublishableName(crucible);
  sendCrucibleNotification({
    userId: crucible.userId,
    type: 'crucible-ended',
    category: NotificationCategory.Update,
    key: `crucible-ended:${crucibleId}`,
    details: {
      crucibleId,
      crucibleName,
      totalEntries: finalizedEntries.length,
      disqualifiedEntries: entryCount - finalizedEntries.length,
      prizePool: totalPrizePool,
      seedRefunded: seedRefunded ? crucible.seededPrizePool : 0,
    },
  });

  // 2. Send 'crucible-won' notifications to all participants with their final position
  // Group entries by userId to avoid duplicate notifications (one per user, not per entry)
  const userResults = new Map<number, FinalizedEntry>();
  for (const entry of finalizedEntries) {
    const existing = userResults.get(entry.userId);
    // Keep the best entry (lowest position = better rank)
    if (
      !existing ||
      (entry.position !== null &&
        (existing.position === null || entry.position < existing.position))
    ) {
      userResults.set(entry.userId, entry);
    }
  }

  // Send notifications for each unique participant
  for (const [participantUserId, bestEntry] of userResults) {
    // Skip notifying the crucible creator about their own entries (they already got crucible-ended)
    if (participantUserId === crucible.userId) continue;

    sendCrucibleNotification({
      userId: participantUserId,
      type: 'crucible-won',
      category: NotificationCategory.System,
      key: `crucible-won:${crucibleId}:${participantUserId}`,
      details: {
        crucibleId,
        crucibleName,
        position: bestEntry.position,
        prizeAmount: bestEntry.prizeAmount,
      },
    });
  }

  await notifyCrucibleFollowersOfResults({
    crucible,
    crucibleName,
    excludeUserIds: [crucible.userId, ...userResults.keys()],
  });

  return result;
};

type RankableEntry = {
  id: number;
  userId: number;
  score: number;
  voteCount: number;
  position: number | null;
  createdAt: Date;
};
type PrizeContext = { prizePositions: PrizePosition[]; totalPrizePool: number };

/** Places entries with enough votes by ELO (entry time breaks ties); the rest stay unplaced. */
function rankEntries(
  entries: RankableEntry[],
  {
    redisElos,
    redisVoteCounts,
    prizePositions,
    totalPrizePool,
  }: PrizeContext & { redisElos: Record<number, number>; redisVoteCounts: Record<number, number> }
): FinalizedEntry[] {
  // Redis can lose a crucible's hashes (a reset or redeploy); the last sync is the fallback.
  const entriesWithElo = entries.map((entry) => ({
    entryId: entry.id,
    userId: entry.userId,
    finalScore: redisElos[entry.id] ?? entry.score,
    voteCount: redisVoteCounts[entry.id] ?? entry.voteCount,
    createdAt: entry.createdAt,
  }));

  const minVotes = getCrucibleMinVotes({
    totalVotes: entriesWithElo.reduce((sum, entry) => sum + entry.voteCount, 0),
    entryCount: entriesWithElo.length,
  });
  const byScoreThenEntryTime = (a: (typeof entriesWithElo)[number], b: typeof a) =>
    b.finalScore - a.finalScore || a.createdAt.getTime() - b.createdAt.getTime();
  const placedEntries = entriesWithElo
    .filter((entry) => entry.voteCount >= minVotes)
    .sort(byScoreThenEntryTime);
  const unplacedEntries = entriesWithElo
    .filter((entry) => entry.voteCount < minVotes)
    .sort(byScoreThenEntryTime);

  return [
    ...placedEntries.map(({ createdAt, ...entry }, index) => ({
      ...entry,
      position: index + 1,
      prizeAmount: getCruciblePrizeAmount({
        position: index + 1,
        prizePositions,
        entryCount: placedEntries.length,
        totalPrizePool,
      }),
    })),
    ...unplacedEntries.map(({ createdAt, ...entry }) => ({
      ...entry,
      position: null,
      prizeAmount: 0,
    })),
  ];
}

/** The stored places, paid as stored; this run's ranking supplies only the unplaced rest. */
function withStoredPlaces(
  ranking: FinalizedEntry[],
  places: {
    id: number;
    userId: number;
    score: number;
    voteCount: number;
    position: number | null;
  }[],
  { prizePositions, totalPrizePool }: PrizeContext
): FinalizedEntry[] {
  const placed = new Set(places.map((place) => place.id));
  return [
    ...places.map((place) => ({
      entryId: place.id,
      userId: place.userId,
      finalScore: place.score,
      voteCount: place.voteCount,
      position: place.position,
      prizeAmount: getCruciblePrizeAmount({
        position: place.position ?? 0,
        prizePositions,
        entryCount: places.length,
        totalPrizePool,
      }),
    })),
    ...ranking
      .filter((entry) => !placed.has(entry.entryId))
      .map((entry) => ({ ...entry, position: null, prizeAmount: 0 })),
  ];
}

/**
 * Completed only from Active: past its end nothing else may move it, so a lost claim means a
 * cancel got there first and anything this run paid is now owed back to the bank.
 */
const claimCrucibleCompletion = async (
  crucibleId: number,
  { prizesPaid }: { prizesPaid: boolean }
) => {
  const { count } = await dbWrite.crucible.updateMany({
    where: { id: crucibleId, status: CrucibleStatus.Active },
    data: { status: CrucibleStatus.Completed },
  });
  if (!count)
    logToAxiom({
      type: 'error',
      name: 'crucible-finalize-claim-lost',
      message: `Crucible ${crucibleId} left Active while it was being finalized${
        prizesPaid ? ' after its prizes were paid; check for refunds of the same pool' : ''
      }.`,
      crucibleId,
      prizesPaid,
    });
  return count > 0;
};

const refundUnawardedSeed = async (
  crucibleId: number,
  seedTransactionId: string,
  reason: 'no-entries' | 'no-prizes-awarded'
) => {
  try {
    await refundCrucibleTransactionOnce({
      externalTransactionIdPrefix: seedTransactionId,
      description:
        reason === 'no-entries'
          ? 'Crucible seeded prize pool refund - no entries'
          : 'Crucible seeded prize pool refund - no prizes awarded',
      crucibleId,
      label: `seeded prize pool for crucible ${crucibleId}`,
      reason,
    });
    return true;
  } catch (error) {
    logToAxiom({
      type: 'error',
      name: 'crucible-seed-refund-failed',
      message: `Failed to refund the seeded prize pool of crucible ${crucibleId} (${reason}): ${
        error instanceof Error ? error.message : String(error)
      }`,
      crucibleId,
      seedTransactionId,
      reason,
    });
    return false;
  }
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
    where: {
      status: CrucibleStatus.Pending,
      startAt: { lte: new Date() },
      ingestion: CrucibleIngestionStatus.Scanned,
      image: { ingestion: ImageIngestionStatus.Scanned },
    },
    data: { status: CrucibleStatus.Active },
  });
  return count;
};

const UNSCANNED_VOID_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * A crucible past its start that hasn't passed review can't be seen or entered. A blocked text or
 * cover → cancelled and refunded now; a review still unfinished a day after the last change (its
 * start, or the edit that reset it) → the same, so the creator's Buzz isn't held forever. One with
 * entries passed review before an edit and runs to the end hidden, as user challenges do.
 */
export const voidUnscannedCrucibles = async (now = new Date()): Promise<number[]> => {
  const graceEnded = new Date(now.getTime() - UNSCANNED_VOID_GRACE_MS);
  // The grace is in the query, not only the loop: otherwise a page of crucibles still in their
  // grace would fill the `take` every run and starve the ones past it.
  const unscanned = await dbRead.crucible.findMany({
    where: {
      status: { in: [CrucibleStatus.Pending, CrucibleStatus.Active] },
      startAt: { lte: now },
      entries: { none: {} },
      OR: [
        { ingestion: CrucibleIngestionStatus.Blocked },
        { image: { ingestion: ImageIngestionStatus.Blocked } },
        {
          startAt: { lt: graceEnded },
          updatedAt: { lt: graceEnded },
          OR: [
            { ingestion: { not: CrucibleIngestionStatus.Scanned } },
            { image: { is: null } },
            { image: { ingestion: { not: ImageIngestionStatus.Scanned } } },
          ],
        },
      ],
    },
    select: {
      id: true,
      userId: true,
      ingestion: true,
      startAt: true,
      updatedAt: true,
      image: { select: { ingestion: true } },
    },
    orderBy: { startAt: 'asc' },
    take: 100,
  });

  const voided: number[] = [];
  for (const { id, userId, ingestion, startAt, updatedAt, image } of unscanned) {
    const blocked =
      ingestion === CrucibleIngestionStatus.Blocked ||
      image?.ingestion === ImageIngestionStatus.Blocked;
    const lastChange = Math.max(startAt?.getTime() ?? 0, updatedAt.getTime());
    if (!blocked && now.getTime() - lastChange <= UNSCANNED_VOID_GRACE_MS) continue;
    try {
      const { failedRefunds } = await cancelCrucible({
        id,
        userId: constants.system.user.id,
        isModerator: true,
      });
      voided.push(id);
      if (failedRefunds.length) {
        logToAxiom({
          type: 'error',
          name: 'crucible-unscanned-void-refund-failed',
          message: `Crucible ${id} was cancelled unreviewed but ${failedRefunds.length} refund(s) failed; re-run cancelCrucible to finish.`,
          crucibleId: id,
          failedRefunds,
        });
      }
      const refundNote = failedRefunds.length
        ? 'Your refund is being processed.'
        : 'Your Buzz has been refunded.';
      await createNotification({
        userId,
        category: NotificationCategory.System,
        type: 'system-message',
        key: `crucible-unscanned-cancelled-${id}`,
        details: {
          message: blocked
            ? `Your crucible was cancelled because it violates our Terms of Service. ${refundNote}`
            : `Your crucible was cancelled because we couldn't finish reviewing it. ${refundNote} You can create it again.`,
          url: `/crucibles/${id}`,
        },
      }).catch(() => undefined);
    } catch (error) {
      logToAxiom({
        type: 'error',
        name: 'crucible-unscanned-void',
        message: error instanceof Error ? error.message : String(error),
        crucibleId: id,
      });
    }
  }
  return voided;
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
  reason = 'cancellation',
}: {
  externalTransactionIdPrefix: string;
  description: string;
  crucibleId: number;
  label: string;
  reason?: string;
}): Promise<'refunded' | 'already-settled'> {
  try {
    await refundMultiAccountTransaction({
      externalTransactionIdPrefix,
      description,
      details: {
        entityId: crucibleId,
        entityType: 'Crucible',
        reason,
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

const NOT_RUNNING = 'Entries can only be removed while the crucible is running';

/**
 * A moderator takes an entry out of a running crucible and returns its fee. Only while it runs:
 * from its end, finalize owns the pool. The fee goes back before the entry is deleted, so a
 * refund that fails leaves the entry, and its record of what was paid, in place to try again.
 */
export const removeCrucibleEntry = async ({
  entryId,
  moderatorId,
}: RemoveCrucibleEntrySchema & { moderatorId: number }) => {
  const entry = await dbWrite.crucibleEntry.findUnique({
    where: { id: entryId },
    select: {
      crucibleId: true,
      userId: true,
      buzzTransactionId: true,
      crucible: {
        select: {
          status: true,
          endAt: true,
          entryFee: true,
          name: true,
          ingestion: true,
          textNsfw: true,
        },
      },
    },
  });
  if (!entry) throw throwNotFoundError('Entry not found');
  if (entry.userId === moderatorId) throw throwBadRequestError("You can't remove your own entry");
  const { crucible, crucibleId } = entry;
  if (crucible.status !== CrucibleStatus.Active || (crucible.endAt && crucible.endAt <= new Date()))
    throw throwBadRequestError(NOT_RUNNING);
  const fee = entry.buzzTransactionId ? crucible.entryFee : 0;

  if (entry.buzzTransactionId) {
    try {
      await refundCrucibleTransactionOnce({
        externalTransactionIdPrefix: entry.buzzTransactionId,
        description: getCrucibleTransactionDescription(
          'Crucible entry fee refund - entry removed',
          crucible
        ),
        crucibleId,
        label: `removed entry ${entryId}`,
        reason: 'entry-removed',
      });
    } catch (error) {
      logToAxiom({
        type: 'error',
        name: 'crucible-entry-removal-refund-failed',
        message: `Entry ${entryId} was kept because its fee ${
          entry.buzzTransactionId
        } could not be refunded: ${error instanceof Error ? error.message : String(error)}`,
        crucibleId,
        entryId,
        moderatorId,
        buzzTransactionId: entry.buzzTransactionId,
      });
      throw throwBadRequestError(
        "The entry fee couldn't be refunded, so the entry was kept. Try again in a moment."
      );
    }
  }

  let ended = false;
  try {
    await dbWrite.$transaction(async (tx) => {
      // Holds the crucible row, so finalize can't rank the entry while it's being removed.
      const running = await tx.$executeRaw`
        UPDATE "Crucible"
        SET "prizePool" = "prizePool" - ${fee}
        WHERE id = ${crucibleId}
          AND status = ${CrucibleStatus.Active}::"CrucibleStatus"
          AND ("endAt" IS NULL OR "endAt" > statement_timestamp())
      `;
      if (!running) {
        ended = true;
        throw throwBadRequestError(NOT_RUNNING);
      }
      await tx.crucibleEntry.delete({ where: { id: entryId } });
    });
  } catch (error) {
    // Ended between the check above and here: the fee is back with the entrant, but the entry
    // still counts toward the pool finalize pays out.
    if (ended && fee)
      logToAxiom({
        type: 'error',
        name: 'crucible-entry-removal-raced-end',
        message: `Entry ${entryId}'s fee was refunded but the crucible ended before it was removed, so the pool still counts it.`,
        crucibleId,
        entryId,
        moderatorId,
        buzzTransactionId: entry.buzzTransactionId,
      });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025')
      throw throwNotFoundError('Entry not found');
    throw error;
  }

  logToAxiom({
    type: 'info',
    name: 'crucible-entry-removed',
    crucibleId,
    entryId,
    entrantId: entry.userId,
    moderatorId,
    refundedAmount: fee,
  });
  sendCrucibleNotification({
    userId: entry.userId,
    type: 'crucible-entry-removed',
    category: NotificationCategory.System,
    key: `crucible-entry-removed:${entryId}`,
    details: {
      crucibleId,
      crucibleName: getCruciblePublishableName(crucible),
      refundedAmount: fee,
    },
  });

  return { entryId, crucibleId, refundedAmount: fee };
};

/** Keyed per crucible, so a re-run reaches only entrants whose refund was still pending. */
const notifyEntrantsOfCancellation = (
  crucible: CrucibleNameScan & { id: number; userId: number; entries: { userId: number }[] },
  failedRefunds: CancelCrucibleResult['failedRefunds']
) => {
  const pending = new Set(failedRefunds.filter((f) => f.entryId !== null).map((f) => f.userId));
  const entrants = [...new Set(crucible.entries.map((e) => e.userId))].filter(
    (userId) => userId !== crucible.userId
  );
  const details = { crucibleId: crucible.id, crucibleName: getCruciblePublishableName(crucible) };
  const settled = entrants.filter((userId) => !pending.has(userId));
  const owed = entrants.filter((userId) => pending.has(userId));
  if (settled.length)
    sendCrucibleNotification({
      userIds: settled,
      type: 'crucible-cancelled',
      category: NotificationCategory.System,
      key: `crucible-cancelled:${crucible.id}`,
      details: { ...details, refundPending: false },
    });
  if (owed.length)
    sendCrucibleNotification({
      userIds: owed,
      type: 'crucible-cancelled',
      category: NotificationCategory.System,
      key: `crucible-cancelled-pending:${crucible.id}`,
      details: { ...details, refundPending: true },
    });
};

/**
 * Pending, or Active while it can't be paying out: before its end, or with nobody entered. Past its
 * end an Active crucible belongs to finalize, and cancelling it then would refund the pool it pays
 * prizes from. `ownerId` limits the claim to that owner's crucible before it starts.
 */
export const claimCrucibleCancellation = async (
  id: number,
  { ownerId }: { ownerId?: number } = {}
) => {
  const { count } = await dbWrite.crucible.updateMany({
    where: {
      id,
      ...(ownerId !== undefined
        ? { userId: ownerId, status: CrucibleStatus.Pending }
        : {
            OR: [
              { status: CrucibleStatus.Pending },
              {
                status: CrucibleStatus.Active,
                OR: [{ endAt: null }, { endAt: { gt: new Date() } }, { entries: { none: {} } }],
              },
            ],
          }),
    },
    data: { status: CrucibleStatus.Cancelled },
  });
  return count > 0;
};

/**
 * Cancel a crucible and return every payment it took. Safe to re-run, and re-running is the
 * supported way to finish a cancel whose refunds did not all land: the status claim happens first,
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
  // Claimed before any money moves. An interrupted cancel then leaves a stopped crucible with
  // refunds owed (listed in `failedRefunds`, fixed by calling again) rather than an Active one still
  // taking entries from people who were just refunded.
  const claimed = await claimCrucibleCancellation(id, isModerator ? {} : { ownerId: userId });

  // The primary, after the claim: the entries to refund include any that landed just before it.
  const crucible = await dbWrite.crucible.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      ingestion: true,
      textNsfw: true,
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

  // A moderator may re-run an already Cancelled one: the refunds below are idempotent, and that
  // is how a partly refunded cancel gets finished.
  if (!claimed) {
    // Before start nobody can have entered, so an owner's cancel only returns their own Buzz.
    if (!isModerator)
      throw throwAuthorizationError('Only moderators can cancel a crucible once it has started');
    if (crucible.status === CrucibleStatus.Completed)
      throw throwBadRequestError('Cannot cancel a completed crucible');
    if (crucible.status !== CrucibleStatus.Cancelled)
      throw throwBadRequestError(
        'This crucible has ended and its results are being finalized, so it can no longer be cancelled'
      );
  }

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
              description: getCrucibleTransactionDescription(
                'Crucible entry fee refund - crucible cancelled',
                crucible
              ),
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

  notifyEntrantsOfCancellation(crucible, failedRefunds);

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

  const paidEntryCounts = await getPaidEntryCounts([
    ...new Set(entries.map(({ crucibleId }) => crucibleId)),
  ]);

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
        paidEntryCount: paidEntryCounts.get(crucibleId) ?? 0,
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
      i.url as "imageUrl",
      COUNT(ce.id) as "entriesCount",
      c."seededPrizePool" + c."entryFee" * COUNT(ce.id) FILTER (WHERE ce."buzzTransactionId" IS NOT NULL) as "prizePool"
    FROM "Crucible" c
    LEFT JOIN "Image" i ON c."imageId" = i.id
    LEFT JOIN "CrucibleEntry" ce ON c.id = ce."crucibleId"
    WHERE c.status = ${CrucibleStatus.Active}::"CrucibleStatus"
      -- Status lags the clock until finalize-crucibles runs; don't feature one that already ended.
      AND (c."endAt" IS NULL OR c."endAt" > now())
      ${greenSiteSql(isGreen)}
      AND ${crucibleListedSql(effectiveLevel)}
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
    GROUP BY c.id, c.name, c.description, c."entryFee", c."seededPrizePool", c."endAt", i.url
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
    buzzType: CRUCIBLE_PRIZE_BUZZ_TYPE,
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
  browsingLevel: requestedLevel,
  excludeCrucibleId,
  limit,
  excludedUserIds = [],
  isGreen = false,
}: GetJudgingSuggestionsSchema & {
  userId: number;
  excludedUserIds?: number[];
  isGreen?: boolean;
}) => {
  const browsingLevel = getEffectiveBrowsingLevel({
    isGreen,
    isLoggedIn: true,
    requested: requestedLevel,
  });
  const rows = await dbRead.$queryRaw<{ id: number }[]>`
    SELECT c.id
    FROM "Crucible" c
    LEFT JOIN "Image" i ON i.id = c."imageId"
    WHERE c.status = ${CrucibleStatus.Active}::"CrucibleStatus"
      -- Status lags the clock until finalize-crucibles runs.
      AND (c."endAt" IS NULL OR c."endAt" > now())
      ${greenSiteSql(isGreen)}
      AND (c."nsfwLevel" & ${browsingLevel}) <> 0
      AND (i."nsfwLevel" & ${browsingLevel}) <> 0
      AND ${crucibleListedSql(browsingLevel)}
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
          JOIN "Image" i ON i.id = ce."imageId"
          WHERE ce."crucibleId" = c.id AND ce."userId" <> ${userId}
            AND ${visibleEntryImageSql(Prisma.sql`c."nsfwLevel"`, browsingLevel)}
          LIMIT 2
        ) judgeable
      ) = 2
    ORDER BY c."createdAt" DESC, c.id DESC
    LIMIT ${limit}
  `;
  if (!rows.length) return [];

  return withPaidEntryCount(
    await dbRead.crucible.findMany({
      where: { id: { in: rows.map(({ id }) => id) } },
      select: crucibleListSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    })
  );
};
