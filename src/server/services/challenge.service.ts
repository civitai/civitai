import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { dbRead, dbWrite } from '~/server/db/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import {
  claimChallengeForCompletion,
  buildChallengeModerationText,
  closeChallengeCollection,
  createChallengeWinner,
  distributePrizes,
  getChallengeById,
  getChallengeWinners,
  getExistingWinnersForRetry,
  resolveEventContext,
} from '~/server/games/daily-challenge/challenge-helpers';
// Re-export getChallengeWinners so router can import from service (separation of concerns)
export { getChallengeWinners } from '~/server/games/daily-challenge/challenge-helpers';
import {
  ChallengeParticipation,
  ChallengeSort,
  challengeJudgingCategoriesSchema,
  parseChallengeMetadata,
  type ChallengeDetail,
  type ChallengeDetailForEdit,
  type ChallengeEventListItem,
  type ChallengeListItem,
  type ChallengeWithWinnersListItem,
  type ChallengeWinnerSummary,
  type GetCompletedChallengesWithWinnersInput,
  type GetInfiniteChallengesInput,
  type GetModeratorChallengesInput,
  type GetChallengeEventsInput,
  type ImageEligibilityResult,
  type UpcomingTheme,
  type UpsertChallengeInput,
  type UserChallengeUpsertInput,
  type UpsertChallengeEventInput,
  type UpdateChallengeConfigInput,
  type UpsertJudgeInput,
  type PlaygroundGenerateContentInput,
  type PlaygroundReviewImageInput,
  type PlaygroundPickWinnersInput,
  type UserChallengeEntriesResult,
  type WinnerCooldownStatus,
} from '~/server/schema/challenge.schema';
import {
  ChallengeReviewCostType,
  ChallengeIngestionStatus,
  ChallengeSource,
  ChallengeStatus,
  CollectionItemStatus,
  CollectionMode,
  CollectionReadConfiguration,
  CollectionType,
  CollectionWriteConfiguration,
  PoolTrigger,
  PrizeMode,
} from '~/shared/utils/prisma/enums';
import { createImage, imagesForModelVersionsCache } from '~/server/services/image.service';
import { getCosmeticsForUsers, getProfilePicturesForUsers } from '~/server/services/user.service';
import { throwNotFoundError } from '~/server/utils/errorHandling';
import { resolveJudgingCategories } from '~/server/services/challenge-category.service';
import { getUserSelectableJudges } from '~/server/services/challenge-judge.service';
import {
  assertCanCreateUserChallenge,
  assertUserAccountInGoodStanding,
} from '~/server/services/challenge-eligibility.service';
import { submitTextModeration } from '~/server/services/text-moderation.service';
import {
  getEffectiveBrowsingLevel,
  isChallengeHiddenByCoverScan,
  isChallengeHiddenByPoiCover,
  isImageHiddenFromGreenViewer,
} from '~/server/games/daily-challenge/challenge-visibility';
import {
  buildWinnerPayoutTransactions,
  chargeInitialPrize,
  refundUserChallengeFunds,
} from '~/server/games/daily-challenge/challenge-funding';
import {
  deriveDomainCurrency,
  isChallengeHiddenByDomainCurrency,
  isNonSfwForGreen,
  type ChallengeBuzzType,
} from '~/server/games/daily-challenge/challenge-currency';
import {
  getEntryPoolContribution,
  getMinUserChallengeStartsAt,
  getUserChallengeVisibleAt,
} from '~/shared/constants/challenge.constants';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import type { CollectionMetadataSchema } from '~/server/schema/collection.schema';
import { imageSelect } from '~/server/selectors/image.selector';
import {
  deriveChallengeNsfwLevel,
  getChallengeConfig,
  setChallengeConfig,
  getJudgingConfig,
  refreshDefaultJudgeCache,
  type JudgingConfig,
  type ChallengePrompts,
  parseJudgeScore,
} from '~/server/games/daily-challenge/daily-challenge.utils';
import {
  generateArticle,
  generateReview,
  generateThemeElements,
  generateWinners,
} from '~/server/games/daily-challenge/generative-content';
import { reviewTemplateSchema } from '~/server/games/daily-challenge/template-engine';
import { getCoverOfModel, getJudgedEntries } from '~/server/jobs/daily-challenge-processing';
import { collectionsSearchIndex } from '~/server/search-index';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { NotificationCategory } from '~/server/common/enums';
import { TransactionType } from '~/shared/constants/buzz.constants';
import {
  createBuzzTransaction,
  createBuzzTransactionMany,
  getTransactionByExternalId,
} from '~/server/services/buzz.service';
import { createNotification } from '~/server/services/notification.service';
import { withRetries } from '~/utils/errorHandling';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import type { AIModel } from '~/server/services/ai/openrouter';
import { createLogger } from '~/utils/logging';
import { isDefined } from '~/utils/type-guards';

/**
 * Get judging config efficiently using cached default judge when possible.
 * Falls back to DB query if the judge differs from default or there's a prompt override.
 */
async function getJudgingConfigForChallenge(
  judgeId: number,
  cachedDefaultJudge: JudgingConfig | null,
  judgingPromptOverride?: string | null
): Promise<JudgingConfig> {
  // If this is the default judge and no prompt override, use cached config
  if (cachedDefaultJudge && judgeId === cachedDefaultJudge.judgeId && !judgingPromptOverride) {
    return cachedDefaultJudge;
  }
  // Otherwise fetch from DB (different judge or has prompt override)
  return getJudgingConfig(judgeId, judgingPromptOverride);
}

// Helper to parse composite cursor (format: "status:sortValue:id")
function parseChallengeCursor(
  cursor: string | undefined,
  sort: ChallengeSort
): { status: ChallengeStatus; sortValue: string | number | Date; id: number } | null {
  if (!cursor) return null;
  // Split into at most 3 parts: status, sortValue (may contain colons for ISO dates), id
  const firstColon = cursor.indexOf(':');
  if (firstColon === -1) return null;
  const status = cursor.slice(0, firstColon) as ChallengeStatus;

  const rest = cursor.slice(firstColon + 1);
  const lastColon = rest.lastIndexOf(':');
  if (lastColon === -1) return null;
  const sortValueStr = rest.slice(0, lastColon);
  const idStr = rest.slice(lastColon + 1);

  const id = parseInt(idStr, 10);
  if (isNaN(id)) return null;

  switch (sort) {
    case ChallengeSort.EndingSoon:
    case ChallengeSort.Newest:
      return { status, sortValue: new Date(sortValueStr), id };
    case ChallengeSort.MostEntries:
    case ChallengeSort.HighestPrize:
      return { status, sortValue: parseInt(sortValueStr, 10), id };
    default:
      return { status, sortValue: sortValueStr, id };
  }
}

// Helper to build composite cursor (format: "status:sortValue:id")
function buildChallengeCursor(
  item: {
    id: number;
    status: ChallengeStatus;
    startsAt: Date;
    endsAt: Date;
    prizePool: number;
    entryCount: number;
  },
  sort: ChallengeSort
): string {
  switch (sort) {
    case ChallengeSort.EndingSoon:
      return `${item.status}:${item.endsAt.toISOString()}:${item.id}`;
    case ChallengeSort.MostEntries:
      return `${item.status}:${item.entryCount}:${item.id}`;
    case ChallengeSort.HighestPrize:
      return `${item.status}:${item.prizePool}:${item.id}`;
    case ChallengeSort.Newest:
    default:
      return `${item.status}:${item.startsAt.toISOString()}:${item.id}`;
  }
}

// Service functions
// Raw row shape returned by the shared challenge-card projection below. Mapped to ChallengeListItem
// by mapChallengeRowsToCards.
type ChallengeCardRow = {
  id: number;
  title: string;
  theme: string | null;
  invitation: string | null;
  coverImageId: number | null;
  startsAt: Date;
  endsAt: Date;
  status: ChallengeStatus;
  source: ChallengeSource;
  prizePool: number;
  entryCount: bigint;
  commentCount: bigint;
  modelVersionIds: number[] | null;
  modelId: number | null;
  modelName: string | null;
  nsfwLevel: number;
  allowedNsfwLevel: number;
  collectionId: number | null;
  createdById: number;
  creatorUsername: string | null;
  creatorImage: string | null;
  creatorDeletedAt: Date | null;
  judgeUserId: number | null;
  judgeUsername: string | null;
  judgeImage: string | null;
  judgeDeletedAt: Date | null;
};

// SELECT + FROM/JOINs for a challenge card. Callers append their own WHERE/ORDER BY/LIMIT. Shared by
// the infinite feed and the daily row so both render identical ChallengeCard data.
const challengeCardQuery = Prisma.sql`
    SELECT
      c.id,
      c.title,
      c.theme,
      c.invitation,
      c."coverImageId",
      c."startsAt",
      c."endsAt",
      c.status,
      c.source,
      c."prizePool",
      (SELECT COUNT(*) FROM "CollectionItem" WHERE "collectionId" = c."collectionId" AND status = 'ACCEPTED') as "entryCount",
      COALESCE((SELECT t."commentCount" FROM "Thread" t WHERE t."challengeId" = c.id), 0) as "commentCount",
      c."nsfwLevel",
      c."allowedNsfwLevel",
      c."modelVersionIds",
      (SELECT mv."modelId" FROM "ModelVersion" mv WHERE mv.id = c."modelVersionIds"[1] LIMIT 1) as "modelId",
      (SELECT m.name FROM "ModelVersion" mv JOIN "Model" m ON m.id = mv."modelId" WHERE mv.id = c."modelVersionIds"[1] LIMIT 1) as "modelName",
      c."collectionId",
      c."createdById",
      u.username as "creatorUsername",
      u.image as "creatorImage",
      u."deletedAt" as "creatorDeletedAt",
      cj."userId" as "judgeUserId",
      ju.username as "judgeUsername",
      ju.image as "judgeImage",
      ju."deletedAt" as "judgeDeletedAt"
    FROM "Challenge" c
    JOIN "User" u ON u.id = c."createdById"
    LEFT JOIN "ChallengeJudge" cj ON cj.id = c."judgeId"
    LEFT JOIN "User" ju ON ju.id = cj."userId"`;

// User challenges show the real creator; system/mod challenges keep the judge (e.g. CivBot persona)
// as the shown author.
const displayUidFor = (item: {
  source: ChallengeSource;
  judgeUserId: number | null;
  createdById: number;
}) =>
  item.source !== ChallengeSource.User && item.judgeUserId != null
    ? item.judgeUserId
    : item.createdById;

// Hydrate card rows with display user profile pictures/cosmetics and cover images, then shape into
// ChallengeListItem.
async function mapChallengeRowsToCards(items: ChallengeCardRow[]): Promise<ChallengeListItem[]> {
  const displayUserIds = [...new Set(items.map(displayUidFor))];
  const [profilePictures, cosmetics] = await Promise.all([
    getProfilePicturesForUsers(displayUserIds),
    getCosmeticsForUsers(displayUserIds),
  ]);

  const coverImageIds = items.map((item) => item.coverImageId).filter((id): id is number => !!id);
  const coverImages = await dbRead.image.findMany({
    where: { id: { in: coverImageIds } },
    select: imageSelect,
  });

  return items.map((item) => {
    const coverImage = item.coverImageId
      ? coverImages.find((img) => img.id === item.coverImageId)
      : null;

    const displayUid = displayUidFor(item);
    const showJudge = displayUid !== item.createdById;

    return {
      id: item.id,
      title: item.title,
      theme: item.theme,
      invitation: item.invitation,
      startsAt: item.startsAt,
      endsAt: item.endsAt,
      status: item.status,
      source: item.source,
      createdById: item.createdById,
      prizePool: item.prizePool,
      nsfwLevel: item.nsfwLevel,
      allowedNsfwLevel: item.allowedNsfwLevel,
      collectionId: item.collectionId,
      entryCount: Number(item.entryCount),
      commentCount: Number(item.commentCount),
      coverImage: coverImage
        ? {
            id: coverImage.id,
            url: coverImage.url,
            nsfwLevel: coverImage.nsfwLevel,
            hash: coverImage.hash,
            width: coverImage.width,
            height: coverImage.height,
            type: coverImage.type,
          }
        : null,
      modelVersionIds: item.modelVersionIds ?? [],
      createdBy: {
        id: displayUid,
        username: showJudge ? item.judgeUsername : item.creatorUsername,
        image: showJudge ? item.judgeImage : item.creatorImage,
        profilePicture: profilePictures[displayUid] ?? null,
        cosmetics: cosmetics[displayUid] ?? null,
        deletedAt: showJudge ? item.judgeDeletedAt : item.creatorDeletedAt,
      },
    };
  });
}

/**
 * Active + next few upcoming System (auto-generated daily) challenges for the horizontal "Daily
 * Challenges" row. Returns at most `limit` cards, active first then soonest-upcoming. System
 * challenges are always Scanned, so no scan gate is needed — only the visibility gate applies.
 */
export async function getDailyChallenges(limit = 4): Promise<ChallengeListItem[]> {
  const items = await dbRead.$queryRaw<ChallengeCardRow[]>`
    ${challengeCardQuery}
    WHERE c.source = ${ChallengeSource.System}::"ChallengeSource"
      AND c."visibleAt" <= now()
      AND c.status IN ('Active'::"ChallengeStatus", 'Scheduled'::"ChallengeStatus")
    ORDER BY CASE c.status WHEN 'Active' THEN 0 ELSE 1 END ASC, c."startsAt" ASC
    LIMIT ${limit}
  `;
  return mapChallengeRowsToCards(items);
}

export async function getInfiniteChallenges(
  input: GetInfiniteChallengesInput & { currentUserId?: number; isGreen?: boolean }
) {
  const {
    query,
    status,
    source,
    sort,
    userId,
    modelVersionId,
    participation,
    includeEnded,
    excludeEventChallenges,
    browsingLevel,
    limit,
    cursor,
    currentUserId,
    isGreen,
  } = input;

  // Build WHERE conditions using parameterized queries (SQL injection safe)
  const conditions: Prisma.Sql[] = [];

  // Only show challenges past their visibility window — except to their own creator, so a creator
  // can see (and manage) a not-yet-visible challenge they made. Mirrors the scan/POI gates below.
  conditions.push(
    currentUserId
      ? Prisma.sql`(c."visibleAt" <= now() OR c."createdById" = ${currentUserId})`
      : Prisma.sql`c."visibleAt" <= now()`
  );

  // Scan gate: hide challenges that haven't passed the moderation scan, except from their
  // own creator (so a creator can preview their pending challenge). System/mod challenges
  // default to Scanned, so they're unaffected.
  conditions.push(
    currentUserId
      ? Prisma.sql`(c."ingestion" = 'Scanned'::"ChallengeIngestionStatus" OR c."createdById" = ${currentUserId})`
      : Prisma.sql`c."ingestion" = 'Scanned'::"ChallengeIngestionStatus"`
  );

  // A challenge with no cover image is incomplete — never surface it in the feed.
  conditions.push(Prisma.sql`c."coverImageId" IS NOT NULL`);

  // POI gate: keep challenges whose cover depicts a real person out of public feeds (the image
  // scanner sets Image.poi). Creator can still see their own, mirroring the scan gate above.
  conditions.push(
    currentUserId
      ? Prisma.sql`(NOT EXISTS (SELECT 1 FROM "Image" i WHERE i.id = c."coverImageId" AND i."poi" = true) OR c."createdById" = ${currentUserId})`
      : Prisma.sql`NOT EXISTS (SELECT 1 FROM "Image" i WHERE i.id = c."coverImageId" AND i."poi" = true)`
  );

  // Cover-scan gate: the cover image itself must have finished moderation scanning before the
  // challenge is publicly visible — separate from the challenge text-scan gate above. Scoped to
  // user challenges only, mirroring the detail path (getChallengeDetail): System/mod covers are
  // trusted and default to Scanned, so they're exempt. Creator exempt, mirroring the POI gate.
  conditions.push(
    currentUserId
      ? Prisma.sql`(c.source <> 'User'::"ChallengeSource" OR EXISTS (SELECT 1 FROM "Image" i WHERE i.id = c."coverImageId" AND i."ingestion" = 'Scanned'::"ImageIngestionStatus") OR c."createdById" = ${currentUserId})`
      : Prisma.sql`(c.source <> 'User'::"ChallengeSource" OR EXISTS (SELECT 1 FROM "Image" i WHERE i.id = c."coverImageId" AND i."ingestion" = 'Scanned'::"ImageIngestionStatus"))`
  );

  // Domain-currency gate: green user challenges surface only on the green site, yellow only
  // off-green. Scoped to user challenges — System/mod/event (prize-only, no entry fee) are
  // universal and show on both domains, mirroring the scan/POI gates.
  const domainCurrency = deriveDomainCurrency(isGreen ?? false);
  conditions.push(
    currentUserId
      ? Prisma.sql`(c.source <> 'User'::"ChallengeSource" OR c."buzzType" = ${domainCurrency} OR c."createdById" = ${currentUserId})`
      : Prisma.sql`(c.source <> 'User'::"ChallengeSource" OR c."buzzType" = ${domainCurrency})`
  );

  // Status filter (parameterized)
  if (status && status.length > 0) {
    const statusValues = status.map((s) => Prisma.sql`${s}::"ChallengeStatus"`);
    conditions.push(Prisma.sql`c.status IN (${Prisma.join(statusValues)})`);
  } else if (!includeEnded) {
    conditions.push(
      Prisma.sql`c.status NOT IN ('Completing'::"ChallengeStatus", 'Completed'::"ChallengeStatus", 'Cancelled'::"ChallengeStatus")`
    );
  }

  // Source filter (parameterized)
  if (source && source.length > 0) {
    const sourceValues = source.map((s) => Prisma.sql`${s}::"ChallengeSource"`);
    conditions.push(Prisma.sql`c.source IN (${Prisma.join(sourceValues)})`);
  }

  // Text search (parameterized - safe from SQL injection)
  if (query) {
    const searchPattern = `%${query}%`;
    conditions.push(Prisma.sql`(c.title ILIKE ${searchPattern} OR c.theme ILIKE ${searchPattern})`);
  }

  // Creator filter (parameterized)
  if (userId) {
    conditions.push(Prisma.sql`c."createdById" = ${userId}`);
  }

  // Model version filter - check if version is in the modelVersionIds array
  if (modelVersionId) {
    conditions.push(Prisma.sql`${modelVersionId} = ANY(c."modelVersionIds")`);
  }

  // Exclude challenges that belong to an event (shown in featured section instead)
  if (excludeEventChallenges) {
    conditions.push(Prisma.sql`c."eventId" IS NULL`);
  }

  // Content level filter — models-style: exclude a challenge outright when its REAL cover image
  // level doesn't intersect the viewer's effective browsing level, rather than trusting the
  // challenge's declared `allowedNsfwLevel`. On green the level is capped server-side (see
  // getEffectiveBrowsingLevel) so a client can't bypass it by omitting `browsingLevel`. Creator
  // always sees their own. A challenge with no cover is already excluded by the IS NOT NULL gate
  // above.
  const effectiveBrowsingLevel = getEffectiveBrowsingLevel({
    isGreen: isGreen ?? false,
    isLoggedIn: currentUserId != null,
    requested: browsingLevel,
  });
  if (effectiveBrowsingLevel > 0) {
    conditions.push(
      currentUserId
        ? Prisma.sql`(c."createdById" = ${currentUserId} OR EXISTS (SELECT 1 FROM "Image" i WHERE i.id = c."coverImageId" AND (i."nsfwLevel" & ${effectiveBrowsingLevel}) <> 0))`
        : Prisma.sql`EXISTS (SELECT 1 FROM "Image" i WHERE i.id = c."coverImageId" AND (i."nsfwLevel" & ${effectiveBrowsingLevel}) <> 0)`
    );
  }

  // User participation filter (requires logged-in user)
  if (participation && currentUserId) {
    switch (participation) {
      case ChallengeParticipation.Entered:
        conditions.push(
          Prisma.sql`EXISTS (
            SELECT 1 FROM "CollectionItem" ci
            WHERE ci."collectionId" = c."collectionId"
              AND ci.status IN (${CollectionItemStatus.ACCEPTED}::"CollectionItemStatus", ${CollectionItemStatus.REVIEW}::"CollectionItemStatus")
              AND ci."addedById" = ${currentUserId}
          )`
        );
        break;
      case ChallengeParticipation.NotEntered:
        conditions.push(
          Prisma.sql`NOT EXISTS (
            SELECT 1 FROM "CollectionItem" ci
            WHERE ci."collectionId" = c."collectionId"
              AND ci.status IN (${CollectionItemStatus.ACCEPTED}::"CollectionItemStatus", ${CollectionItemStatus.REVIEW}::"CollectionItemStatus")
              AND ci."addedById" = ${currentUserId}
          )`
        );
        break;
      case ChallengeParticipation.Won:
        conditions.push(
          Prisma.sql`EXISTS (
            SELECT 1 FROM "ChallengeWinner" cw
            WHERE cw."challengeId" = c.id
              AND cw."userId" = ${currentUserId}
          )`
        );
        break;
    }
  }

  // Composite cursor for stable keyset pagination across all sort types
  // The primary sort dimension is status priority (Active=0 < Scheduled=1 < others=2),
  // so cursor conditions must account for status group transitions.
  const parsedCursor = parseChallengeCursor(cursor, sort);
  if (parsedCursor) {
    const { status: cursorStatus, sortValue, id } = parsedCursor;

    // Status priority CASE fragments for keyset comparison
    const statusPriority = Prisma.sql`CASE c.status WHEN 'Active' THEN 0 WHEN 'Scheduled' THEN 1 ELSE 2 END`;
    const cursorStatusPriority = Prisma.sql`CASE ${cursorStatus}::"ChallengeStatus" WHEN 'Active' THEN 0 WHEN 'Scheduled' THEN 1 ELSE 2 END`;

    let sortKeysetCondition: Prisma.Sql;
    switch (sort) {
      case ChallengeSort.EndingSoon:
        sortKeysetCondition = Prisma.sql`(c."endsAt" > ${sortValue as Date} OR (c."endsAt" = ${
          sortValue as Date
        } AND c.id < ${id}))`;
        break;
      case ChallengeSort.MostEntries:
        sortKeysetCondition = Prisma.sql`(
          (SELECT COUNT(*) FROM "CollectionItem" WHERE "collectionId" = c."collectionId" AND status = 'ACCEPTED') < ${
            sortValue as number
          }
          OR (
            (SELECT COUNT(*) FROM "CollectionItem" WHERE "collectionId" = c."collectionId" AND status = 'ACCEPTED') = ${
              sortValue as number
            }
            AND c.id < ${id}
          )
        )`;
        break;
      case ChallengeSort.HighestPrize:
        sortKeysetCondition = Prisma.sql`(c."prizePool" < ${
          sortValue as number
        } OR (c."prizePool" = ${sortValue as number} AND c.id < ${id}))`;
        break;
      case ChallengeSort.Newest:
      default:
        // Scheduled challenges sort soonest-first (ASC), others sort newest-first (DESC)
        if (cursorStatus === 'Scheduled') {
          sortKeysetCondition = Prisma.sql`(c."startsAt" > ${
            sortValue as Date
          } OR (c."startsAt" = ${sortValue as Date} AND c.id < ${id}))`;
        } else {
          sortKeysetCondition = Prisma.sql`(c."startsAt" < ${
            sortValue as Date
          } OR (c."startsAt" = ${sortValue as Date} AND c.id < ${id}))`;
        }
        break;
    }

    // Combined keyset: status priority changed OR (same status group AND existing sort logic)
    conditions.push(
      Prisma.sql`(
        ${statusPriority} > ${cursorStatusPriority}
        OR (
          c.status = ${cursorStatus}::"ChallengeStatus"
          AND ${sortKeysetCondition}
        )
      )`
    );
  }

  const whereClause =
    conditions.length > 0 ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;

  // Build ORDER BY (safe - not user input)
  // Primary sort: status priority (Active before Scheduled before others)
  const statusOrderPrefix = Prisma.sql`CASE c.status WHEN 'Active' THEN 0 WHEN 'Scheduled' THEN 1 ELSE 2 END ASC`;
  let orderByClause: Prisma.Sql;
  switch (sort) {
    case ChallengeSort.EndingSoon:
      orderByClause = Prisma.sql`${statusOrderPrefix}, c."endsAt" ASC, c.id DESC`;
      break;
    case ChallengeSort.MostEntries:
      orderByClause = Prisma.sql`${statusOrderPrefix}, "entryCount" DESC, c.id DESC`;
      break;
    case ChallengeSort.HighestPrize:
      orderByClause = Prisma.sql`${statusOrderPrefix}, c."prizePool" DESC, c.id DESC`;
      break;
    case ChallengeSort.Newest:
    default:
      // Scheduled challenges sort soonest-first (ASC), others sort newest-first (DESC)
      orderByClause = Prisma.sql`${statusOrderPrefix},
        CASE WHEN c.status = 'Scheduled'
          THEN EXTRACT(EPOCH FROM c."startsAt")
          ELSE -EXTRACT(EPOCH FROM c."startsAt")
        END ASC,
        c.id DESC`;
      break;
  }

  // Entry count now comes from CollectionItem via the challenge's collection
  const items = await dbRead.$queryRaw<ChallengeCardRow[]>`
    ${challengeCardQuery}
    ${whereClause}
    ORDER BY ${orderByClause}
    LIMIT ${limit + 1}
  `;

  // Check if there are more results and build composite cursor
  let nextCursor: string | undefined;
  if (items.length > limit) {
    const nextItem = items.pop();
    if (nextItem) {
      nextCursor = buildChallengeCursor(
        { ...nextItem, entryCount: Number(nextItem.entryCount) },
        sort
      );
    }
  }

  const challenges = await mapChallengeRowsToCards(items);

  return {
    items: challenges,
    nextCursor,
  };
}

/**
 * Shared helper that fetches and assembles all challenge detail data.
 * Used by both the public getChallengeDetail and moderator getChallengeForEdit.
 */
async function buildChallengeDetail(
  challenge: NonNullable<Awaited<ReturnType<typeof getChallengeById>>>
) {
  const id = challenge.id;

  // createdById is nullable (creator account deleted, FK ON DELETE SET NULL); fall back to the
  // system user (-1) so lookups don't degrade to WHERE id = NULL and drop the creator identity.
  const createdById = challenge.createdById ?? -1;

  // Get entry count from the challenge's collection (only accepted entries)
  let entryCount = 0;
  if (challenge.collectionId) {
    const [countResult] = await dbRead.$queryRaw<[{ count: bigint }]>`
      SELECT COUNT(*) as count
      FROM "CollectionItem"
      WHERE "collectionId" = ${challenge.collectionId}
        AND status = 'ACCEPTED'
    `;
    entryCount = Number(countResult.count);
  }

  // Get creator info with profile picture and cosmetics
  const [creator] = await dbRead.$queryRaw<
    [{ id: number; username: string | null; image: string | null; deletedAt: Date | null }]
  >`
    SELECT id, username, image, "deletedAt"
    FROM "User"
    WHERE id = ${createdById}
  `;

  // Fetch profile picture and cosmetics for creator
  const [profilePictures, cosmetics] = await Promise.all([
    getProfilePicturesForUsers([createdById]),
    getCosmeticsForUsers([createdById]),
  ]);

  // Get model info for all modelVersionIds
  let models: ChallengeDetail['models'] = [];
  if (challenge.modelVersionIds.length > 0) {
    const versions = await dbRead.modelVersion.findMany({
      where: { id: { in: challenge.modelVersionIds } },
      select: {
        id: true,
        name: true,
        baseModel: true,
        model: { select: { id: true, name: true } },
      },
    });

    // Batch-fetch images for all versions via cache (keyed by modelVersionId)
    const imageCache = await imagesForModelVersionsCache.fetch(challenge.modelVersionIds);

    models = versions.map((v) => {
      const img = imageCache[v.id]?.images?.[0] ?? null;
      return {
        id: v.model.id,
        name: v.model.name,
        versionId: v.id,
        versionName: v.name,
        baseModel: v.baseModel,
        image: img
          ? {
              id: img.id,
              url: img.url,
              nsfwLevel: img.nsfwLevel,
              hash: img.hash,
              width: img.width,
              height: img.height,
              type: img.type,
            }
          : null,
      };
    });
  }

  // Fetch cover image
  const coverImage = challenge.coverImageId
    ? await dbRead.image.findUnique({
        where: { id: challenge.coverImageId },
        select: imageSelect,
      })
    : null;

  // Get winners if challenge is completed
  let winners: ChallengeDetail['winners'] = [];
  if (challenge.status === ChallengeStatus.Completed) {
    const rawWinners = await getChallengeWinners(id);
    // Enrich winners with profile pictures and cosmetics
    const winnerUserIds = rawWinners.map((w) => w.userId);
    const [winnerProfilePics, winnerCosmetics] =
      winnerUserIds.length > 0
        ? await Promise.all([
            getProfilePicturesForUsers(winnerUserIds),
            getCosmeticsForUsers(winnerUserIds),
          ])
        : [{}, {}];
    winners = rawWinners.map((w) => ({
      ...w,
      profilePicture: winnerProfilePics[w.userId] ?? null,
      cosmetics: winnerCosmetics[w.userId] ?? null,
    }));
  }

  // Get judge info if challenge has a judge assigned
  let judge: ChallengeDetail['judge'] = null;
  if (challenge.judgeId) {
    const [judgeRow] = await dbRead.$queryRaw<
      [{ id: number; userId: number; name: string; bio: string | null } | undefined]
    >`
      SELECT cj.id, cj."userId", cj.name, cj.bio
      FROM "ChallengeJudge" cj
      WHERE cj.id = ${challenge.judgeId}
    `;
    if (judgeRow) {
      const [judgeProfilePics, judgeCosmetics] = await Promise.all([
        getProfilePicturesForUsers([judgeRow.userId]),
        getCosmeticsForUsers([judgeRow.userId]),
      ]);
      judge = {
        ...judgeRow,
        profilePicture: judgeProfilePics[judgeRow.userId] ?? null,
        cosmetics: judgeCosmetics[judgeRow.userId] ?? null,
      };
    }
  }

  // Display user: user challenges show the real creator; system/mod challenges keep the judge
  // (e.g. CivBot persona) as the shown author.
  const displayUserId =
    challenge.source === ChallengeSource.User ? createdById : judge?.userId ?? createdById;
  let displayUser: {
    id: number;
    username: string | null;
    image: string | null;
    deletedAt: Date | null;
  };
  let displayProfilePics: Awaited<ReturnType<typeof getProfilePicturesForUsers>>;
  let displayCosmetics: Awaited<ReturnType<typeof getCosmeticsForUsers>>;

  if (displayUserId !== createdById) {
    const [judgeUser] = await dbRead.$queryRaw<
      [{ id: number; username: string | null; image: string | null; deletedAt: Date | null }]
    >`
      SELECT id, username, image, "deletedAt" FROM "User" WHERE id = ${displayUserId}
    `;
    displayUser = judgeUser;
    [displayProfilePics, displayCosmetics] = await Promise.all([
      getProfilePicturesForUsers([displayUserId]),
      getCosmeticsForUsers([displayUserId]),
    ]);
  } else {
    displayUser = creator;
    displayProfilePics = profilePictures;
    displayCosmetics = cosmetics;
  }

  // Extract structured fields from metadata
  const metadata = parseChallengeMetadata(challenge.metadata);
  const completionSummary = metadata.completionSummary ?? null;
  const themeElements = metadata.themeElements ?? null;

  // Get challenge config for judgedTagId
  const challengeConfig = await getChallengeConfig();

  const parsed = challengeJudgingCategoriesSchema.safeParse(challenge.judgingCategories);

  return {
    id: challenge.id,
    title: challenge.title,
    description: challenge.description,
    theme: challenge.theme,
    invitation: challenge.invitation,
    coverImage: coverImage
      ? {
          id: coverImage.id,
          url: coverImage.url,
          nsfwLevel: coverImage.nsfwLevel,
          hash: coverImage.hash,
          width: coverImage.width,
          height: coverImage.height,
          type: coverImage.type,
        }
      : null,
    startsAt: challenge.startsAt,
    endsAt: challenge.endsAt,
    visibleAt: challenge.visibleAt,
    status: challenge.status,
    source: challenge.source,
    buzzType: challenge.buzzType,
    eventId: challenge.eventId,
    nsfwLevel: challenge.nsfwLevel,
    allowedNsfwLevel: challenge.allowedNsfwLevel,
    modelVersionIds: challenge.modelVersionIds,
    models,
    collectionId: challenge.collectionId,
    maxEntriesPerUser: challenge.maxEntriesPerUser,
    entryFee: challenge.entryFee,
    prizes: challenge.prizes,
    entryPrize: challenge.entryPrize,
    entryPrizeRequirement: challenge.entryPrizeRequirement,
    prizePool: challenge.prizePool,
    prizeMode: challenge.prizeMode,
    basePrizePool: challenge.basePrizePool,
    buzzPerAction: challenge.buzzPerAction,
    poolTrigger: challenge.poolTrigger,
    maxPrizePool: challenge.maxPrizePool,
    prizeDistribution: challenge.prizeDistribution,
    reviewCostType: challenge.reviewCostType,
    reviewCost: challenge.reviewCost,
    entryCount,
    createdById,
    createdBy: {
      ...displayUser,
      profilePicture: displayProfilePics[displayUserId] ?? null,
      cosmetics: displayCosmetics[displayUserId] ?? null,
    },
    judge,
    winners,
    completionSummary,
    judgedTagId: challengeConfig.judgedTagId ?? null,
    // Public by design: the upsert form promises entrants the rubric is shown publicly.
    judgingCategories: parsed.success ? parsed.data : null,
    // Internal fields used only by getChallengeForEdit
    _internal: {
      judgingPrompt: challenge.judgingPrompt,
      reviewPercentage: challenge.reviewPercentage,
      operationBudget: challenge.operationBudget,
      themeElements,
      entryFee: challenge.entryFee,
      maxParticipants: challenge.maxParticipants,
    },
  };
}

/**
 * Public challenge detail — strips sensitive fields that could give users
 * an unfair advantage (judging prompt, theme elements, etc.).
 */
export async function getChallengeDetail(
  id: number,
  viewerId?: number,
  isGreen?: boolean,
  isModerator?: boolean
): Promise<ChallengeDetail | null> {
  const challenge = await getChallengeById(id);
  if (!challenge) return null;

  // Visibility check: only show challenges that are visible to the public. The creator and
  // moderators may preview a not-yet-visible or Cancelled challenge, and are likewise exempt
  // from the scan/POI/cover gates below (mods need to inspect hidden challenges; the creator
  // needs to see their own pending/blocked one).
  const now = new Date();
  const canPreviewUnpublished =
    isModerator === true || (viewerId != null && challenge.createdById === viewerId);
  if (challenge.visibleAt > now && !canPreviewUnpublished) return null;
  if (challenge.status === ChallengeStatus.Cancelled && !canPreviewUnpublished) return null;

  // Scan gate: user-created challenges stay hidden until moderation scan passes.
  if (
    !canPreviewUnpublished &&
    challenge.source === ChallengeSource.User &&
    challenge.ingestion !== ChallengeIngestionStatus.Scanned
  ) {
    return null;
  }

  // POI + cover-scan gate: a cover depicting a real person (Image.poi, set by the image scanner),
  // or one that hasn't finished moderation scanning yet, keeps the challenge out of public view —
  // direct-URL parity with the feed filter. Mod/creator exempt; skip the lookup entirely for trusted
  // System challenges. NSFW-on-green gating is handled client-side by <Gated> (MatureContentRedirect)
  // on the detail page, matching how model/image detail pages gate mature content on the safe site.
  if (!canPreviewUnpublished && challenge.source === ChallengeSource.User && challenge.coverImageId) {
    const cover = await dbRead.image.findUnique({
      where: { id: challenge.coverImageId },
      select: { poi: true, ingestion: true },
    });
    if (
      isChallengeHiddenByPoiCover(
        {
          source: challenge.source,
          createdById: challenge.createdById,
          coverPoi: cover?.poi ?? false,
        },
        viewerId
      )
    )
      return null;

    if (
      isChallengeHiddenByCoverScan(
        { source: challenge.source, createdById: challenge.createdById, coverImage: cover },
        viewerId
      )
    )
      return null;
  }

  // Domain-currency gate — direct-URL parity with the feed filter. Like the other gates above,
  // moderators and creators can preview unpublished/hidden challenges regardless of domain.
  if (
    !canPreviewUnpublished &&
    isChallengeHiddenByDomainCurrency(
      {
        source: challenge.source,
        buzzType: challenge.buzzType,
        createdById: challenge.createdById,
      },
      isGreen ?? false,
      viewerId
    )
  )
    return null;

  const { _internal, ...detail } = await buildChallengeDetail(challenge);
  return detail;
}

/**
 * Moderator-only challenge detail — returns all fields including sensitive
 * ones needed for the edit form (judging prompt, theme elements, etc.).
 * Bypasses visibility checks.
 */
export async function getChallengeForEdit(id: number): Promise<ChallengeDetailForEdit | null> {
  const challenge = await getChallengeById(id);
  if (!challenge) return null;

  const { _internal, ...detail } = await buildChallengeDetail(challenge);
  return { ...detail, ..._internal };
}

export async function getUpcomingThemes(count: number): Promise<UpcomingTheme[]> {
  const items = await dbRead.$queryRaw<
    Array<{
      startsAt: Date;
      theme: string | null;
      modelName: string | null;
      modelCreator: string | null;
    }>
  >`
    SELECT
      c."startsAt",
      c.theme,
      (SELECT m.name FROM "ModelVersion" mv JOIN "Model" m ON m.id = mv."modelId" WHERE mv.id = c."modelVersionIds"[1]) as "modelName",
      (SELECT u.username FROM "ModelVersion" mv JOIN "Model" m ON m.id = mv."modelId" JOIN "User" u ON u.id = m."userId" WHERE mv.id = c."modelVersionIds"[1]) as "modelCreator"
    FROM "Challenge" c
    WHERE c."visibleAt" <= NOW()
    AND c.status IN (
      ${ChallengeStatus.Scheduled}::"ChallengeStatus",
      ${ChallengeStatus.Active}::"ChallengeStatus"
    )
    AND c."startsAt" > NOW()
    ORDER BY c."startsAt" ASC
    LIMIT ${count}
  `;

  return items.map((item) => ({
    date: item.startsAt.toISOString().split('T')[0],
    theme: item.theme || 'Mystery Theme',
    modelName: item.modelName || 'Any Model',
    modelCreator: item.modelCreator || null,
  }));
}

export async function getModeratorChallenges(input: GetModeratorChallengesInput) {
  const { query, status, source, limit, cursor } = input;

  // Build WHERE conditions using parameterized queries (SQL injection safe)
  const conditions: Prisma.Sql[] = [];

  if (status && status.length > 0) {
    const statusValues = status.map((s) => Prisma.sql`${s}::"ChallengeStatus"`);
    conditions.push(Prisma.sql`c.status IN (${Prisma.join(statusValues)})`);
  }

  if (source && source.length > 0) {
    const sourceValues = source.map((s) => Prisma.sql`${s}::"ChallengeSource"`);
    conditions.push(Prisma.sql`c.source IN (${Prisma.join(sourceValues)})`);
  }

  if (query) {
    const searchPattern = `%${query}%`;
    conditions.push(Prisma.sql`(c.title ILIKE ${searchPattern} OR c.theme ILIKE ${searchPattern})`);
  }

  if (cursor) {
    conditions.push(Prisma.sql`c.id < ${cursor}`);
  }

  const whereClause =
    conditions.length > 0 ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;

  // Entry count now from CollectionItem
  const items = await dbRead.$queryRaw<
    Array<{
      id: number;
      title: string;
      theme: string | null;
      startsAt: Date;
      endsAt: Date;
      visibleAt: Date;
      status: ChallengeStatus;
      source: ChallengeSource;
      prizePool: number;
      entryCount: bigint;
      reviewCostType: ChallengeReviewCostType;
      reviewCost: number;
      collectionId: number;
      createdById: number;
      creatorUsername: string | null;
    }>
  >`
    SELECT
      c.id,
      c.title,
      c.theme,
      c."startsAt",
      c."endsAt",
      c."visibleAt",
      c.status,
      c.source,
      c."prizePool",
      c."reviewCostType",
      c."reviewCost",
      (SELECT COUNT(*) FROM "CollectionItem" WHERE "collectionId" = c."collectionId" AND status = 'ACCEPTED') as "entryCount",
      c."collectionId",
      c."createdById",
      u.username as "creatorUsername"
    FROM "Challenge" c
    JOIN "User" u ON u.id = c."createdById"
    ${whereClause}
    ORDER BY c."startsAt" DESC, c.id DESC
    LIMIT ${limit + 1}
  `;

  let nextCursor: number | undefined;
  if (items.length > limit) {
    const nextItem = items.pop();
    nextCursor = nextItem?.id;
  }

  return {
    items: items.map((item) => ({
      ...item,
      entryCount: Number(item.entryCount),
    })),
    nextCursor,
  };
}

export async function upsertChallenge({
  userId,
  ...input
}: UpsertChallengeInput & { userId: number }) {
  const {
    id,
    coverImage,
    judgeId,
    eventId,
    themeElements: inputThemeElements,
    judgingCategories: judgingCategoriesInput,
    ...data
  } = input;

  // Derive label + criteria from the ChallengeCategory library (throws on unknown keys) so only
  // server-derived text is persisted / reaches the judge prompt.
  const judgingCategories = judgingCategoriesInput?.length
    ? await resolveJudgingCategories(judgingCategoriesInput)
    : null;

  // Defense-in-depth: validate endsAt > startsAt (also validated by Zod schema)
  if (data.endsAt <= data.startsAt) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'End date must be after start date',
    });
  }

  // Handle cover image - create Image record if needed (like Article does)
  let coverImageId: number;
  if (coverImage.id) {
    // Use existing image ID
    coverImageId = coverImage.id;
  } else {
    // Create new Image record from uploaded file
    const result = await createImage({ ...coverImage, userId });
    coverImageId = result.id;
  }

  // Helper: resolve judging config and generate theme elements.
  async function tryGenerateThemeElements(theme: string): Promise<string[] | undefined> {
    const challengeConfig = await getChallengeConfig();
    const resolvedJudgeId = judgeId ?? challengeConfig.defaultJudgeId;
    if (!resolvedJudgeId) return undefined;

    const judgingConfig = await getJudgingConfig(resolvedJudgeId);
    const elements = await generateThemeElements({ theme, config: judgingConfig });

    return elements.length ? elements : undefined;
  }

  if (id) {
    // Update existing challenge
    const challenge = await dbRead.challenge.findUnique({
      where: { id },
      select: {
        collectionId: true,
        metadata: true,
        status: true,
        startsAt: true,
        modelVersionIds: true,
        allowedNsfwLevel: true,
        source: true,
        maxEntriesPerUser: true,
        entryPrizeRequirement: true,
        prizeMode: true,
        basePrizePool: true,
        buzzPerAction: true,
        poolTrigger: true,
        maxPrizePool: true,
        prizeDistribution: true,
        judgingCategories: true,
      },
    });
    if (!challenge) throw throwNotFoundError('Challenge not found');

    // Block edits to terminal/completing challenges
    if (
      challenge.status === ChallengeStatus.Completing ||
      challenge.status === ChallengeStatus.Completed ||
      challenge.status === ChallengeStatus.Cancelled
    ) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: `Cannot edit a ${challenge.status.toLowerCase()} challenge.`,
      });
    }

    // For Active challenges: restore locked fields from DB (silently override attempted changes)
    if (challenge.status === ChallengeStatus.Active) {
      data.status = challenge.status;
      data.startsAt = challenge.startsAt;
      data.modelVersionIds = challenge.modelVersionIds;
      data.allowedNsfwLevel = challenge.allowedNsfwLevel;
      data.source = challenge.source as typeof data.source;
      data.maxEntriesPerUser = challenge.maxEntriesPerUser;
      data.entryPrizeRequirement = challenge.entryPrizeRequirement;
      data.prizeMode = challenge.prizeMode as typeof data.prizeMode;
      data.basePrizePool = challenge.basePrizePool;
      data.buzzPerAction = challenge.buzzPerAction;
      data.poolTrigger = challenge.poolTrigger as typeof data.poolTrigger;
      data.maxPrizePool = challenge.maxPrizePool;
      data.prizeDistribution = challenge.prizeDistribution as typeof data.prizeDistribution;

      // Validate endsAt > now() for Active challenges (can't set end date to the past)
      if (data.endsAt <= new Date()) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'End date must be in the future for an active challenge.',
        });
      }
    }

    // Judging categories lock once the challenge starts — entries are already judged against
    // them. Locked for every post-Scheduled status (not just Active): rewriting them on a
    // Completing/Completed/Cancelled challenge would make re-review rescore already-judged
    // entries under a different rubric.
    const effectiveJudgingCategories =
      challenge.status !== ChallengeStatus.Scheduled
        ? (challenge.judgingCategories as Prisma.InputJsonValue) ?? Prisma.JsonNull
        : judgingCategories
        ? (judgingCategories as unknown as Prisma.InputJsonValue)
        : Prisma.JsonNull;

    // Resolve theme elements: use provided ones, keep existing, or auto-generate
    const existingMetadata = parseChallengeMetadata(challenge.metadata);
    const existingThemeElements = existingMetadata.themeElements;
    let themeElements: string[] | undefined;
    if (inputThemeElements?.length) {
      // Explicitly provided by the form — use as-is
      themeElements = inputThemeElements;
    } else if (data.theme && !existingThemeElements?.length) {
      // No existing elements and none provided — auto-generate
      themeElements = await tryGenerateThemeElements(data.theme);
    }

    // Use transaction to update both challenge and collection metadata atomically
    const updatedChallenge = await dbWrite.$transaction(async (tx) => {
      // Update the challenge
      const updated = await tx.challenge.update({
        where: { id },
        data: {
          ...data,
          nsfwLevel: deriveChallengeNsfwLevel(data.allowedNsfwLevel ?? 1),
          coverImageId,
          judgeId: judgeId ?? null,
          eventId: eventId ?? null,
          modelVersionIds: data.modelVersionIds ?? [],
          prizes: data.prizes,
          entryPrize: data.entryPrize ? data.entryPrize : Prisma.JsonNull,
          prizeDistribution: data.prizeDistribution
            ? (data.prizeDistribution as unknown as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          judgingCategories: effectiveJudgingCategories,
          ...(themeElements && {
            metadata: { ...existingMetadata, themeElements },
          }),
        },
      });

      // Sync collection metadata if challenge has a collection
      if (challenge.collectionId) {
        // Get current collection metadata to merge with updates
        const collection = await tx.collection.findUnique({
          where: { id: challenge.collectionId },
          select: { metadata: true },
        });

        const currentMetadata = {
          ...(collection?.metadata as CollectionMetadataSchema),
          submissionStartDate: data.startsAt,
          submissionEndDate: data.endsAt,
          maxItemsPerUser: data.maxEntriesPerUser,
          forcedBrowsingLevel: data.allowedNsfwLevel,
        };

        await tx.collection.update({
          where: { id: challenge.collectionId },
          data: { metadata: currentMetadata },
        });
      }

      return updated;
    });

    return updatedChallenge;
  } else {
    // Auto-activate if startsAt is in the past or now
    const status = data.startsAt <= new Date() ? ChallengeStatus.Active : data.status;

    // Resolve theme elements: use provided ones or auto-generate
    const newThemeElements = inputThemeElements?.length
      ? inputThemeElements
      : data.theme
      ? await tryGenerateThemeElements(data.theme)
      : undefined;

    // Create new challenge with a Contest Collection for entries
    const challenge = await dbWrite.$transaction(async (tx) => {
      // First create the collection with proper Contest Mode settings
      const collection = await tx.collection.create({
        data: {
          name: `Challenge: ${data.title}`,
          description: data.description || `Entries for challenge: ${data.title}`,
          userId,
          mode: CollectionMode.Contest,
          write: CollectionWriteConfiguration.Review,
          read: CollectionReadConfiguration.Public,
          type: CollectionType.Image,
          imageId: coverImageId,
          metadata: {
            maxItemsPerUser: data.maxEntriesPerUser ?? 20,
            submissionStartDate: data.startsAt,
            submissionEndDate: data.endsAt,
            forcedBrowsingLevel: data.allowedNsfwLevel ?? 1,
            disableFollowOnSubmission: true,
            disableTagRequired: true,
          },
        },
      });

      // Then create the challenge linked to the collection
      return await tx.challenge.create({
        data: {
          ...data,
          status,
          nsfwLevel: deriveChallengeNsfwLevel(data.allowedNsfwLevel ?? 1),
          coverImageId,
          judgeId: judgeId ?? null,
          eventId: eventId ?? null,
          collectionId: collection.id,
          createdById: userId,
          modelVersionIds: data.modelVersionIds ?? [],
          allowedNsfwLevel: data.allowedNsfwLevel ?? 1,
          entryPrizeRequirement: data.entryPrizeRequirement ?? 10,
          prizes: data.prizes,
          entryPrize: data.entryPrize ? data.entryPrize : Prisma.JsonNull,
          prizeDistribution: data.prizeDistribution
            ? (data.prizeDistribution as unknown as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          judgingCategories: judgingCategories
            ? (judgingCategories as unknown as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          ...(newThemeElements && { metadata: { themeElements: newThemeElements } }),
        },
      });
    });

    return challenge;
  }
}

// Create/update a PUBLIC (user-created) challenge. Restricted, safe path — forces
// source=User, scan gating (Pending), category-based judging (no free-form prompt),
// entry-fee funding (Dynamic pool). Entry-fee charging + initial-prize escrow are live
// via challenge-funding.ts.
export async function upsertUserChallenge({
  userId,
  buzzType,
  ...input
}: UserChallengeUpsertInput & { userId: number; buzzType: ChallengeBuzzType }) {
  const {
    id,
    coverImage,
    judgeId,
    themeElements,
    entryFee,
    initialPrizeBuzz,
    prizeDistribution,
    judgingCategories,
    maxParticipants,
    ...rest
  } = input;

  if (rest.endsAt <= rest.startsAt) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'End date must be after start date' });
  }

  // Start must be at least CHALLENGE_MIN_START_LEAD_HOURS out — no "starts right now" challenges.
  // On create this always applies; on edit it's only re-checked when the start date actually moves
  // (guarded below, against the stored startsAt), so an unrelated edit near start time isn't blocked.
  const minStartsAt = getMinUserChallengeStartsAt();
  if (!id && rest.startsAt < minStartsAt) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Challenge must start at least 3 hours from now.',
    });
  }

  // Judge must be an existing, active judge — users can only pick, not create or reprompt one.
  // Read/write parity: validate against exactly the set the user picker offered (getActiveJudges),
  // including the whitelist fallback — never a separate query that could drift from the form.
  if (judgeId != null) {
    const selectableJudges = await getUserSelectableJudges();
    if (!selectableJudges.some((j) => j.id === judgeId))
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Selected judge is not available.' });
  }

  const allowedNsfwLevel = rest.allowedNsfwLevel ?? sfwBrowsingLevelsFlag;
  // buzzType is derived from the caller's current domain, but it's immutable once stored — on
  // create it's what will be stored, so gate here; on edit the STORED buzzType is what matters
  // (gated below, against `existing.buzzType`, after it's loaded).
  if (!id && isNonSfwForGreen(buzzType, allowedNsfwLevel))
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Green challenges must be Safe-For-Work.',
    });
  const themeEls = themeElements?.length ? themeElements : undefined;

  // Derive label + criteria from the ChallengeCategory library (throws on unknown keys) so only
  // server-derived text is persisted / reaches the judge prompt.
  const resolvedJudgingCategories = await resolveJudgingCategories(judgingCategories);

  // Create — gate on eligibility (score + standing + tier concurrent cap) before creating any
  // resources, so an ineligible caller can't leave an orphan cover Image behind. Edit — only
  // re-check account standing (banned/deleted/muted/active-strike), NOT the score/cap/daily-limit
  // create gates, so a since-muted/struck/banned creator can't keep editing a Scheduled challenge
  // while a transient dip in the (known-flaky) creator score doesn't lock out an otherwise-good
  // creator from editing their own challenge.
  if (!id) await assertCanCreateUserChallenge(userId);
  else await assertUserAccountInGoodStanding(userId);

  // Cover image: reuse an existing Image or create one from the upload (like the mod path).
  // A reused id must belong to the caller — otherwise anyone could surface another user's
  // (possibly unpublished/blocked) image on a public challenge card, and the challenge scan
  // only covers text.
  let coverImageId: number;
  if (coverImage.id != null) {
    const ownedImage = await dbRead.image.findFirst({
      where: { id: coverImage.id, userId },
      select: { id: true },
    });
    if (!ownedImage)
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Cover image not found.' });
    coverImageId = ownedImage.id;
  } else {
    coverImageId = (await createImage({ ...coverImage, userId })).id;
  }

  // Fields shared by create + update. Entry-fee funded pools are modeled with the existing
  // Dynamic prize machinery: pool grows by `buzzPerAction` (net of the house cut) per entry.
  const commonData = {
    title: rest.title,
    description: rest.description ?? null,
    theme: rest.theme,
    invitation: rest.invitation ?? null,
    coverImageId,
    allowedNsfwLevel,
    nsfwLevel: deriveChallengeNsfwLevel(allowedNsfwLevel),
    modelVersionIds: rest.modelVersionIds ?? [],
    maxEntriesPerUser: rest.maxEntriesPerUser,
    maxParticipants: maxParticipants ?? null,
    startsAt: rest.startsAt,
    endsAt: rest.endsAt,
    judgeId,
    judgingPrompt: null,
    judgingCategories: resolvedJudgingCategories as unknown as Prisma.InputJsonValue,
    entryFee,
    prizeMode: PrizeMode.Dynamic,
    poolTrigger: PoolTrigger.Entry,
    buzzPerAction: getEntryPoolContribution(entryFee),
    basePrizePool: initialPrizeBuzz,
    // Seed the displayed pool with the escrowed initial prize so an Upcoming challenge
    // shows its prize before the dynamic-pool recompute job runs (it only runs once Active).
    prizePool: initialPrizeBuzz,
    prizeDistribution: prizeDistribution as unknown as Prisma.InputJsonValue,
  };

  if (id) {
    const existing = await dbRead.challenge.findUnique({
      where: { id },
      select: {
        createdById: true,
        source: true,
        status: true,
        collectionId: true,
        basePrizePool: true,
        metadata: true,
        buzzType: true,
        startsAt: true,
        title: true,
        description: true,
        theme: true,
        invitation: true,
      },
    });
    if (!existing) throw throwNotFoundError('Challenge not found');
    if (existing.source !== ChallengeSource.User)
      throw new TRPCError({ code: 'FORBIDDEN', message: 'This challenge cannot be edited here.' });
    if (existing.createdById !== userId)
      throw new TRPCError({ code: 'FORBIDDEN', message: 'You can only edit your own challenges.' });
    // Text/config locks once live: only Scheduled challenges with no entries yet are editable.
    if (existing.status !== ChallengeStatus.Scheduled)
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'A published challenge can no longer be edited.',
      });
    if (existing.collectionId) {
      const entryCount = await dbRead.collectionItem.count({
        where: { collectionId: existing.collectionId },
      });
      if (entryCount > 0)
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'This challenge already has entries and can no longer be edited.',
        });
    }
    // buzzType is editable while Scheduled, but not once an initial prize is escrowed — it was
    // charged in the old currency, so switching would strand those funds. Reject that case.
    const existingBuzzType: ChallengeBuzzType = existing.buzzType === 'green' ? 'green' : 'yellow';
    if (buzzType !== existingBuzzType && existing.basePrizePool > 0)
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Remove the initial prize before changing the challenge currency.',
      });
    if (isNonSfwForGreen(buzzType, allowedNsfwLevel))
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Green challenges must be Safe-For-Work.',
      });

    const startChanged = rest.startsAt.getTime() !== existing.startsAt.getTime();
    if (startChanged && rest.startsAt < minStartsAt)
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Challenge must start at least 3 hours from now.',
      });

    // Only reset the scan verdict when the moderated text actually changed. Resetting on every
    // edit deadlocks: the re-scan submit dedups on contentHash against the already-Succeeded
    // EntityModeration row, so no webhook ever flips ingestion back to Scanned and the challenge
    // sits hidden until the activation job voids it.
    const moderatedTextChanged =
      buildChallengeModerationText(commonData) !== buildChallengeModerationText(existing);

    const updated = await dbWrite.$transaction(async (tx) => {
      // Conditional on status IN THE WRITE: the Scheduled/entry-count checks above ran on the
      // read replica, so the hourly activation job (or a racing entry charge) could have flipped
      // this challenge Active in between — an unconditional update would then rewrite prizePool
      // over real collected contributions and hide a live challenge behind the scan gate.
      const { count } = await tx.challenge.updateMany({
        where: { id, status: ChallengeStatus.Scheduled },
        data: {
          ...commonData,
          buzzType,
          // The initial prize is escrowed once at creation; never let an edit rewrite the
          // (already-charged) pool from client input — that would pay out unfunded Buzz.
          // Edits are limited to Scheduled + no entries, so the pool equals the base here.
          basePrizePool: existing.basePrizePool,
          prizePool: existing.basePrizePool,
          ...(moderatedTextChanged && {
            ingestion: ChallengeIngestionStatus.Pending,
            scannedAt: null,
          }),
          // Recompute the visibility window from the (possibly updated) start date.
          visibleAt: getUserChallengeVisibleAt(rest.startsAt),
          ...(themeEls && {
            metadata: { ...parseChallengeMetadata(existing.metadata), themeElements: themeEls },
          }),
        },
      });
      if (count === 0)
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'A published challenge can no longer be edited.',
        });
      const saved = await tx.challenge.findUniqueOrThrow({ where: { id } });

      if (existing.collectionId) {
        const collection = await tx.collection.findUnique({
          where: { id: existing.collectionId },
          select: { metadata: true },
        });
        await tx.collection.update({
          where: { id: existing.collectionId },
          data: {
            metadata: {
              ...(collection?.metadata as CollectionMetadataSchema),
              submissionStartDate: rest.startsAt,
              submissionEndDate: rest.endsAt,
              maxItemsPerUser: rest.maxEntriesPerUser,
              forcedBrowsingLevel: allowedNsfwLevel,
            },
          },
        });
      }

      return saved;
    });

    // Re-scan only text changes (fail-soft; the scan gate hides it until Scanned).
    if (moderatedTextChanged) await scanUserChallenge(id);
    return updated;
  }

  const created = await dbWrite.$transaction(async (tx) => {
    const collection = await tx.collection.create({
      data: {
        name: `Challenge: ${rest.title}`,
        description: rest.description || `Entries for challenge: ${rest.title}`,
        userId,
        mode: CollectionMode.Contest,
        write: CollectionWriteConfiguration.Review,
        read: CollectionReadConfiguration.Public,
        type: CollectionType.Image,
        imageId: coverImageId,
        metadata: {
          maxItemsPerUser: rest.maxEntriesPerUser,
          submissionStartDate: rest.startsAt,
          submissionEndDate: rest.endsAt,
          forcedBrowsingLevel: allowedNsfwLevel,
          disableFollowOnSubmission: true,
          disableTagRequired: true,
        },
      },
    });

    return tx.challenge.create({
      data: {
        ...commonData,
        collectionId: collection.id,
        createdById: userId,
        source: ChallengeSource.User,
        buzzType,
        status: ChallengeStatus.Scheduled,
        ingestion: ChallengeIngestionStatus.Pending,
        // Visible from 1 week before start (and only once scanned — the ingestion gate is separate).
        visibleAt: getUserChallengeVisibleAt(rest.startsAt),
        ...(themeEls && { metadata: { themeElements: themeEls } }),
      },
    });
  });

  // Escrow the creator's initial prize (if any). On failure, roll back the unfunded
  // challenge + its auto-created collection so we never leave a partially funded challenge.
  if (initialPrizeBuzz > 0) {
    try {
      await chargeInitialPrize({
        challengeId: created.id,
        userId,
        amount: initialPrizeBuzz,
        fromAccountType: buzzType,
      });
    } catch (e) {
      // Prize charge failed — remove the unfunded challenge + its auto-created collection. If the
      // cleanup itself fails we'd strand an unfunded challenge, so log loudly instead of swallowing.
      await dbWrite.challenge.delete({ where: { id: created.id } }).catch((cleanupError) => {
        logToAxiom({
          type: 'error',
          name: 'user-challenge-rollback-failed',
          message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          stack: cleanupError instanceof Error ? cleanupError.stack : undefined,
          challengeId: created.id,
          userId,
        });
      });
      if (created.collectionId)
        await dbWrite.collection
          .delete({ where: { id: created.collectionId } })
          .catch((cleanupError) => {
            logToAxiom({
              type: 'error',
              name: 'user-challenge-collection-rollback-failed',
              message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
              stack: cleanupError instanceof Error ? cleanupError.stack : undefined,
              challengeId: created.id,
              collectionId: created.collectionId,
              userId,
            });
          });
      throw e;
    }
  }

  // Moderation scan (fail-soft) — flips Pending → Scanned/Blocked; hidden until Scanned.
  await scanUserChallenge(created.id);

  return created;
}

// Submits a user challenge's author-supplied text (title/theme/description/invitation) to the
// async text-moderation pipeline (`EntityModeration` + XGuard). The result callback resolves
// ingestion via `challengeModerationAdapter`: `blocked` → Blocked (hidden), `nsfw` → Scanned with
// nsfwLevel floored to R, clean → Scanned. Idempotent — unchanged content dedups on contentHash.
// The scan gate keeps the challenge hidden until it reaches Scanned.
export async function scanUserChallenge(challengeId: number): Promise<void> {
  const challenge = await dbRead.challenge.findUnique({
    where: { id: challengeId },
    select: { title: true, description: true, theme: true, invitation: true },
  });
  if (!challenge) return;

  try {
    await submitTextModeration({
      entityType: 'Challenge',
      entityId: challengeId,
      content: buildChallengeModerationText(challenge),
      labels: ['nsfw'],
      priority: 'low',
    });
  } catch (e) {
    // Submit failure already persists a Failed EntityModeration row (the retry cron re-submits);
    // log but don't rethrow so create/edit isn't blocked on a moderation-gateway hiccup.
    logToAxiom({
      type: 'error',
      name: 'user-challenge-scan-failed',
      message: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? e.stack : undefined,
      challengeId,
    });
  }
}

// Public-safe judge options for the user challenge form: id/name/bio only (no prompt fields).
export async function updateChallengeStatus(id: number, status: ChallengeStatus) {
  const challenge = await dbWrite.challenge.update({
    where: { id },
    data: { status },
  });
  return challenge;
}

export async function deleteChallenge(id: number) {
  // Read on the primary, not the read replica: replica lag let a delete see a stale `Scheduled`
  // status for a challenge the activation job had just flipped to `Active`, then refund + delete a
  // now-live challenge out from under its entrants.
  const challenge = await dbWrite.challenge.findUnique({
    where: { id },
    select: { id: true, status: true, collectionId: true, source: true },
  });

  if (!challenge) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Challenge not found',
    });
  }

  // Block deletion of active challenges
  if (challenge.status === ChallengeStatus.Active) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Cannot delete an active challenge. Cancel it first.',
    });
  }

  // Refund BEFORE deleting: refundUserChallengeFunds reads the Challenge row, so once the row is
  // gone nothing can return the creator's escrowed prize or collected entry fees. Only Scheduled or
  // already-Cancelled User challenges are refunded — a Completing/Completed pool was (or is being)
  // paid out to winners, so refunding it would double-spend from account 0.
  if (
    challenge.source === ChallengeSource.User &&
    (challenge.status === ChallengeStatus.Scheduled ||
      challenge.status === ChallengeStatus.Cancelled)
  ) {
    // If still Scheduled, atomically claim it (Scheduled -> Cancelled) first so a delete racing the
    // activation job can't refund + delete a now-live challenge: if activation won, count is 0 and
    // we abort. An already-Cancelled challenge (voided, or a delete retried after its refund threw
    // mid-way) skips the claim and just re-refunds — so a failed refund is self-healing on retry
    // rather than stranding the funds.
    if (challenge.status === ChallengeStatus.Scheduled) {
      const claimed = await dbWrite.challenge.updateMany({
        where: { id, status: ChallengeStatus.Scheduled },
        data: { status: ChallengeStatus.Cancelled },
      });
      if (claimed.count !== 1) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'This challenge is no longer in a deletable state.',
        });
      }
    }
    // Idempotent via deterministic externalTransactionId prefixes (the buzz service dedups), so
    // re-refunding an already-Cancelled challenge is a net-zero no-op, not a double-spend.
    await refundUserChallengeFunds(id);
  }

  const collectionId = challenge.collectionId;

  // Keep challenge + collection deletion in one transaction so a failed collection delete
  // cannot leave an orphaned contest collection after the challenge row is removed.
  await dbWrite.$transaction(async (tx) => {
    // Delete challenge first (cascades to ChallengeWinner)
    await tx.challenge.delete({ where: { id } });

    // Delete the associated collection and all its data
    if (collectionId) {
      await tx.collection.delete({ where: { id: collectionId } });
    }
  });

  if (collectionId) {
    // Remove from search index
    await collectionsSearchIndex.queueUpdate([
      { id: collectionId, action: SearchIndexUpdateQueueAction.Delete },
    ]);
  }

  return { success: true };
}

// User-scoped delete: a creator may delete their own challenge only while it is still Scheduled
// with no entries (no entry fees collected). Delegates to deleteChallenge, which already refunds
// the creator's escrowed prize for Scheduled User challenges before removing challenge + collection.
export async function deleteUserChallenge({ id, userId }: { id: number; userId: number }) {
  const existing = await dbRead.challenge.findUnique({
    where: { id },
    select: { source: true, createdById: true, status: true, collectionId: true },
  });
  if (!existing) throw throwNotFoundError('Challenge not found');
  if (existing.source !== ChallengeSource.User)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'This challenge cannot be deleted here.' });
  if (existing.createdById !== userId)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'You can only delete your own challenges.' });
  if (existing.status !== ChallengeStatus.Scheduled)
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'A published challenge can no longer be deleted.',
    });
  if (existing.collectionId) {
    const entryCount = await dbRead.collectionItem.count({
      where: { collectionId: existing.collectionId },
    });
    if (entryCount > 0)
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'This challenge already has entries and can no longer be deleted.',
      });
  }
  // deleteChallenge re-reads status and only refunds/deletes a Scheduled row, so a race with the
  // activation job fails safe (blocks Active) rather than double-refunding.
  return deleteChallenge(id);
}

// User-safe fetch for the edit form. getChallengeForEdit is moderator-only; this guards ownership
// first, then returns the same shape. User challenges have judgingPrompt = null, so nothing
// moderator-sensitive is exposed.
export async function getUserChallengeForEdit({ id, userId }: { id: number; userId: number }) {
  const existing = await dbRead.challenge.findUnique({
    where: { id },
    select: { source: true, createdById: true, status: true },
  });
  if (!existing) throw throwNotFoundError('Challenge not found');
  if (existing.source !== ChallengeSource.User || existing.createdById !== userId)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'You can only edit your own challenges.' });
  if (existing.status !== ChallengeStatus.Scheduled)
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'A published challenge can no longer be edited.',
    });
  return getChallengeForEdit(id);
}

export async function getUserEntryCount(challengeId: number, userId: number) {
  // Get the challenge's collection
  const challenge = await dbRead.challenge.findUnique({
    where: { id: challengeId },
    select: { collectionId: true },
  });

  if (!challenge?.collectionId) {
    return { count: 0 };
  }

  // Count user's entries in the collection
  const count = await dbRead.collectionItem.count({
    where: {
      collectionId: challenge.collectionId,
      addedById: userId,
    },
  });

  return { count };
}

// =============================================================================
// Paid Review
// =============================================================================

/**
 * Pay Buzz to guarantee entries get reviewed by the AI judge.
 * Tags entries with reviewMeTagId so the next job run picks them up.
 */
export async function requestReview(
  challengeId: number,
  imageIds: number[] | undefined,
  userId: number
) {
  // 1. Get challenge with reviewCostType + reviewCost
  const challenge = await getChallengeById(challengeId);
  if (!challenge) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Challenge not found' });
  }
  if (challenge.status !== ChallengeStatus.Active) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Challenge is not active',
    });
  }
  const isFlat = challenge.reviewCostType === ChallengeReviewCostType.Flat;
  if (challenge.reviewCostType === ChallengeReviewCostType.None || challenge.reviewCost <= 0) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Paid review is not available for this challenge',
    });
  }
  if (!challenge.collectionId) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Challenge has no collection',
    });
  }

  // 2. Find eligible entries (not already queued/judged)
  const config = await getChallengeConfig();
  const eligibleEntries = await dbRead.$queryRaw<{ imageId: number }[]>`
    SELECT ci."imageId"
    FROM "CollectionItem" ci
    JOIN "Image" i ON i.id = ci."imageId"
    WHERE ci."collectionId" = ${challenge.collectionId}
      AND ci.status IN ('ACCEPTED', 'REVIEW')
      AND (ci."tagId" IS NULL OR ci."tagId" NOT IN (${config.reviewMeTagId}, ${config.judgedTagId}))
      AND i."userId" = ${userId}
      ${
        imageIds?.length
          ? Prisma.sql`AND ci."imageId" = ANY(ARRAY[${Prisma.join(imageIds)}])`
          : Prisma.empty
      }
  `;

  if (!isFlat && imageIds?.length && eligibleEntries.length !== imageIds.length) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Some entries are not eligible for review (already judged, queued, or not yours)',
    });
  }

  // 3. Charge buzz
  const eligibleImageIds = eligibleEntries.map((e) => e.imageId);
  let totalCost: number;

  if (isFlat) {
    // Flat rate: single transaction for all entries (covers future entries too)
    totalCost = challenge.reviewCost;
    await createBuzzTransaction({
      fromAccountId: userId,
      toAccountId: 0,
      type: TransactionType.Purchase,
      amount: totalCost,
      description: `Challenge review: all entries (flat rate)`,
      externalTransactionId: `challenge-review-flat-${challengeId}-${userId}`,
    });
  } else {
    if (eligibleEntries.length === 0) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'No eligible entries to review',
      });
    }
    // Per-entry: individual transactions for refund tracking
    totalCost = challenge.reviewCost * eligibleEntries.length;
    await createBuzzTransactionMany(
      eligibleEntries.map((e) => ({
        fromAccountId: userId,
        toAccountId: 0,
        type: TransactionType.Purchase,
        amount: challenge.reviewCost,
        description: `Challenge review: entry ${e.imageId}`,
        externalTransactionId: `challenge-review-${challengeId}-${e.imageId}`,
      }))
    );
  }

  // 4. Tag eligible entries with reviewMeTagId and store note for tracking
  if (eligibleImageIds.length > 0) {
    const notePrefix = isFlat ? 'challenge-review-flat' : 'challenge-review';
    await dbWrite.$executeRaw`
      UPDATE "CollectionItem"
      SET "tagId" = ${config.reviewMeTagId},
          "note" = ${notePrefix} || '-' || ${String(challengeId)} || '-' || "imageId"
      WHERE "collectionId" = ${challenge.collectionId}
        AND "imageId" = ANY(ARRAY[${Prisma.join(eligibleImageIds)}])
    `;
  }

  return { queued: eligibleEntries.length, totalCost };
}

/**
 * Get user's entries that haven't been judged or queued for review yet.
 */
export async function getUserUnjudgedEntries(
  challengeId: number,
  userId: number
): Promise<UserChallengeEntriesResult> {
  const challenge = await dbRead.challenge.findUnique({
    where: { id: challengeId },
    select: { collectionId: true, reviewCostType: true, reviewCost: true },
  });

  if (!challenge?.collectionId) return { entries: [], hasFlatRatePurchase: false };

  const config = await getChallengeConfig();
  const entries = await dbRead.$queryRaw<{ imageId: number; url: string; tagId: number | null }[]>`
    SELECT ci."imageId", i.url, ci."tagId"
    FROM "CollectionItem" ci
    JOIN "Image" i ON i.id = ci."imageId"
    WHERE ci."collectionId" = ${challenge.collectionId}
      AND ci.status IN ('ACCEPTED', 'REVIEW')
      AND i."userId" = ${userId}
    ORDER BY ci."createdAt" DESC
  `;

  // Check if user has already purchased flat rate review
  let hasFlatRatePurchase = false;
  if (challenge.reviewCostType === ChallengeReviewCostType.Flat) {
    const txId = `challenge-review-flat-${challengeId}-${userId}`;
    const tx = await getTransactionByExternalId(txId);
    hasFlatRatePurchase = !!tx;
  }

  return {
    entries: entries.map((e) => ({
      ...e,
      reviewStatus:
        e.tagId === config.judgedTagId
          ? ('reviewed' as const)
          : e.tagId === config.reviewMeTagId
          ? ('queued' as const)
          : ('pending' as const),
    })),
    hasFlatRatePurchase,
  };
}

const log = createLogger('challenge-service', 'blue');

/**
 * End an active challenge early and pick winners.
 * This closes the collection and runs the full winner-picking flow.
 */
export async function endChallengeAndPickWinners(challengeId: number) {
  // Get the challenge
  const challenge = await getChallengeById(challengeId);
  if (!challenge) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Challenge not found' });
  }

  // Validate status
  if (challenge.status !== ChallengeStatus.Active) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `Cannot end challenge with status "${String(
        challenge.status
      )}". Challenge must be Active.`,
    });
  }

  // Atomic claim to prevent concurrent processing
  const claimed = await claimChallengeForCompletion(challengeId);
  if (!claimed) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'Challenge is already being completed by another process.',
    });
  }

  // Get challenge config for judging
  const config = await getChallengeConfig();
  const judgeId = challenge.judgeId ?? config.defaultJudgeId;
  if (!judgeId)
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'No judge assigned and no defaultJudgeId configured',
    });
  // Use cached default judge if applicable, otherwise fetch from DB
  const judgingConfig = await getJudgingConfigForChallenge(
    judgeId,
    config.defaultJudge,
    challenge.judgingPrompt
  );

  log('Ending challenge and picking winners:', challengeId);

  try {
    // Close the collection
    await closeChallengeCollection(challenge);
    log('Collection closed');

    // Entry fees charged since the last periodic review recompute grew prizePool but not the
    // stored per-place breakdown; with the collection closed the pool is final, so recompute
    // before winners are mapped/paid or the last window's fees stay stranded in account 0.
    if (challenge.source === ChallengeSource.User) {
      const fresh = await dbWrite.challenge.findUnique({
        where: { id: challengeId },
        select: { prizePool: true, prizeDistribution: true },
      });
      const distribution = Array.isArray(fresh?.prizeDistribution)
        ? (fresh.prizeDistribution as number[])
        : null;
      if (fresh && distribution?.length) {
        const finalPrizes = distributePrizes(fresh.prizePool, distribution);
        await dbWrite.challenge.update({
          where: { id: challengeId },
          data: { prizes: finalPrizes as unknown as Prisma.InputJsonValue },
        });
        challenge.prizes = finalPrizes;
        log('Final prize breakdown recomputed from collected pool:', {
          prizePool: fresh.prizePool,
          prizes: finalPrizes,
        });
      }
    }

    // Check if winners already exist from a previous (failed) run.
    // If so, skip LLM generation entirely to avoid non-deterministic re-picks.
    const existingWinners = await getExistingWinnersForRetry(challengeId);

    let winningEntries: Array<{
      userId: number;
      imageId: number | null;
      position: number;
      prize: number;
      reason: string | null;
    }>;
    let process: string | undefined;
    let outcome: string | undefined;

    if (existingWinners.length > 0) {
      log('Reusing existing winners from previous run (retry-safe):', existingWinners.length);
      winningEntries = existingWinners.map((w) => ({
        userId: w.userId,
        imageId: w.imageId,
        position: w.place,
        prize: w.buzzAwarded,
        reason: w.reason,
      }));
    } else {
      // Get judged entries
      if (!challenge.collectionId) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Challenge has no collection for entries.',
        });
      }

      // Resolve event context for cooldown scoping (eventId comes from getChallengeById)
      const eventContext = await resolveEventContext(challenge.eventId);

      // Rank by stored judgingCategories when present (any source); otherwise the fixed
      // theme/wittiness/humor/aesthetic rubric. Parse defensively — a malformed value falls back
      // to the fixed schema.
      const userJudgingCategories = challengeJudgingCategoriesSchema.safeParse(
        challenge.judgingCategories
      );
      const userCategories = userJudgingCategories.success
        ? userJudgingCategories.data
        : undefined;

      const judgedEntries = await getJudgedEntries(
        challenge.collectionId,
        config,
        eventContext,
        challenge.source,
        userCategories
      );
      if (!judgedEntries.length) {
        // Zero-winner completion of a paid user challenge strands its entry fees + initial prize in
        // account 0 (no payout runs below). Reverse the actual charges (mint-safe + idempotent —
        // keyed off real charges) BEFORE marking Completed. No-op for daily/mod/system.
        if (challenge.source === ChallengeSource.User) {
          const { refundedEntries } = await refundUserChallengeFunds(challengeId);
          log(`Refunded ${refundedEntries} entry fees (no winners)`);
          if (refundedEntries > 0) {
            await notifyEntrantsOfCancellation(challenge);
          }
        }
        await dbWrite.challenge.update({
          where: { id: challengeId },
          data: { status: ChallengeStatus.Completed },
        });
        log('No judged entries, challenge marked as completed without winners');
        return { success: true, winnersCount: 0 };
      }

      // Run LLM winner picking
      log('Sending entries for final judgment');
      const generated = await generateWinners({
        theme: challenge.theme || 'Creative Challenge',
        entries: judgedEntries.map((entry) => ({
          creator: entry.username,
          creatorId: entry.userId,
          summary: entry.summary,
          score: entry.score,
        })),
        config: judgingConfig,
      });
      process = generated.process;
      outcome = generated.outcome;

      // Map winners to entries by numeric creatorId only. `winner.creator` is the LLM's echo of the
      // (user-controlled, spoofable) display name — matching on it let a second entrant who set their
      // name equal to another's hijack `find`'s first-match and steal the payout. judgedEntries is
      // deduped to one entry per userId, so creatorId alone disambiguates. (Parity with the cron path.)
      winningEntries = generated.winners
        .map((winner, i) => {
          const entry = judgedEntries.find((e) => e.userId === winner.creatorId);
          if (!entry) return null;
          return {
            userId: entry.userId,
            imageId: entry.imageId,
            position: i + 1,
            prize: challenge.prizes[i]?.buzz ?? 0,
            reason: winner.reason,
          };
        })
        .filter(isDefined);

      // Create ChallengeWinner records (idempotent via P2002 handling)
      for (const entry of winningEntries) {
        await createChallengeWinner({
          challengeId,
          userId: entry.userId,
          imageId: entry.imageId!, // always non-null on fresh winner path
          place: entry.position,
          buzzAwarded: entry.prize,
          pointsAwarded: challenge.prizes[entry.position - 1]?.points ?? 0,
          reason: entry.reason ?? undefined,
        });
      }
      log('ChallengeWinner records created');
    }

    // Send prizes to winners in the challenge's stored currency (green vs yellow). Routed through
    // the same builder as the cron completion path — hardcoding 'yellow' here minted yellow and
    // stranded the collected green pool for green challenges. Deterministic externalTransactionId
    // (challenge-winner-prize-{cid}-{uid}-place-{n}) keeps retries idempotent.
    await withRetries(() =>
      createBuzzTransactionMany(
        buildWinnerPayoutTransactions({
          challengeId,
          title: challenge.title,
          buzzType: challenge.buzzType,
          winners: winningEntries,
        })
      )
    );
    log('Prizes sent');

    // Send entry participation prizes to all eligible users
    if (challenge.entryPrize && challenge.entryPrize.buzz > 0 && challenge.collectionId) {
      const earnedEntryPrizes = await dbRead.$queryRaw<{ userId: number }[]>`
        SELECT DISTINCT i."userId"
        FROM "CollectionItem" ci
        JOIN "Image" i ON i.id = ci."imageId"
        WHERE ci."collectionId" = ${challenge.collectionId}
          AND ci.status = 'ACCEPTED'
        GROUP BY i."userId"
        HAVING COUNT(*) >= ${challenge.entryPrizeRequirement}
      `;

      if (earnedEntryPrizes.length > 0) {
        const winnerUserIds = winningEntries.map((e) => e.userId);
        // Exclude winners from entry prizes (they get winner prizes instead)
        const entryPrizeUsers = earnedEntryPrizes.filter((e) => !winnerUserIds.includes(e.userId));

        if (entryPrizeUsers.length > 0) {
          // Note: externalTransactionId uses challengeId-userId pattern for idempotency
          // This ensures retries don't create duplicate payments
          await withRetries(() =>
            createBuzzTransactionMany(
              entryPrizeUsers.map(({ userId }) => ({
                type: TransactionType.Reward,
                toAccountId: userId,
                fromAccountId: 0, // central bank
                amount: challenge.entryPrize!.buzz,
                description: `Challenge Entry Prize: ${challenge.title}`,
                externalTransactionId: `challenge-entry-prize-${challengeId}-${userId}`,
                toAccountType: 'blue',
              }))
            )
          );
          log('Entry participation prizes sent:', entryPrizeUsers.length);

          // Notify entry prize recipients
          await createNotification({
            type: 'challenge-participation',
            category: NotificationCategory.System,
            key: `challenge-participation:${challengeId}:final`,
            userIds: entryPrizeUsers.map((e) => e.userId),
            details: {
              challengeId,
              challengeName: challenge.title,
              prize: challenge.entryPrize!.buzz,
            },
          });
          log('Entry prize users notified');
        }
      }
    }

    // Partial-winner residual: unfilled prize buzz stays in account 0 by design (spec decision).
    if (challenge.source === ChallengeSource.User) {
      const totalPrizeBuzz = challenge.prizes.reduce((sum, p) => sum + (p.buzz ?? 0), 0);
      const distributedPrizeBuzz = winningEntries.reduce((sum, e) => sum + e.prize, 0);
      const residualBuzz = totalPrizeBuzz - distributedPrizeBuzz;
      if (residualBuzz > 0) {
        await logToAxiom({
          type: 'info',
          name: 'challenge-partial-winner-residual',
          message:
            'User challenge completed with fewer winners than prize places; buzz not paid out',
          challengeId,
          residualBuzz,
          winnersCount: winningEntries.length,
          prizePlaces: challenge.prizes.length,
        });
      }
    }

    // Set Completed status + store summary (AFTER all prizes distributed)
    const existingMetadata = parseChallengeMetadata(challenge.metadata);
    await dbWrite.challenge.update({
      where: { id: challengeId },
      data: {
        metadata: {
          ...existingMetadata,
          completionSummary: {
            judgingProcess: process,
            outcome: outcome,
            completedAt: new Date().toISOString(),
          },
        },
        status: ChallengeStatus.Completed,
      },
    });
    log('Challenge status updated to Completed');

    // Notify winners (non-critical, last)
    for (const entry of winningEntries) {
      await createNotification({
        type: 'challenge-winner',
        category: NotificationCategory.System,
        key: `challenge-winner:${challengeId}:${entry.position}`,
        userId: entry.userId,
        details: {
          challengeId,
          challengeName: challenge.title,
          position: entry.position,
          prize: entry.prize,
        },
      });
    }
    log('Winners notified');

    return { success: true, winnersCount: winningEntries.length };
  } catch (error) {
    // On failure, challenge stays in 'Completing' for recovery to handle
    log('Error during manual winner picking, challenge stays in Completing for recovery:', error);
    throw error;
  }
}

/**
 * Distinct paying entrants for a challenge — owners of images *currently* entered into its
 * collection, excluding the creator. This is an approximation of "who actually got refunded",
 * not an exact match, and the divergence is accepted rather than re-architected to query the
 * buzz ledger: a moderator-added entry has a CollectionItem row despite its fee charge being
 * bypassed, so that user may be notified without having paid; and a paid entry removed from the
 * collection before the void still has its pool fee reversed by `refundUserChallengeFunds`
 * (matched by transaction-id prefix, independent of this query) but won't appear here, so that
 * payer won't be notified. The refund itself is unaffected either way — only this courtesy
 * notification is approximate.
 */
async function getPayingEntrantUserIds(collectionId: number, createdById: number | null) {
  const rows = await dbRead.$queryRaw<{ userId: number }[]>`
    SELECT DISTINCT i."userId"
    FROM "CollectionItem" ci
    JOIN "Image" i ON i.id = ci."imageId"
    WHERE ci."collectionId" = ${collectionId}
  `;
  return rows.map((r) => r.userId).filter((userId) => userId !== createdById);
}

/** Notify every distinct paying entrant that their challenge was cancelled/refunded. Call only
 * after a refund has actually happened (`refundedEntries > 0`) so no-fee/no-entrant/System
 * challenges never fire this. Best-effort: the refund has already succeeded by the time this
 * runs, so a failure here is logged and swallowed rather than propagating and blocking the
 * status flip to Cancelled/Completed. */
async function notifyEntrantsOfCancellation(challenge: {
  id: number;
  title: string;
  collectionId: number | null;
  createdById: number | null;
  entryFee: number;
}) {
  if (!challenge.collectionId) return;
  try {
    const entrantUserIds = await getPayingEntrantUserIds(
      challenge.collectionId,
      challenge.createdById
    );
    if (entrantUserIds.length === 0) return;

    await createNotification({
      type: 'challenge-cancelled',
      category: NotificationCategory.System,
      key: `challenge-cancelled:${challenge.id}`,
      userIds: entrantUserIds,
      details: {
        challengeId: challenge.id,
        challengeTitle: challenge.title,
        refundedBuzz: getEntryPoolContribution(challenge.entryFee),
      },
    });
    log(`Notified ${entrantUserIds.length} entrants of challenge cancellation`);
  } catch (err) {
    await logToAxiom({
      type: 'error',
      name: 'challenge-cancelled-notification',
      challengeId: challenge.id,
      message: (err as Error).message,
    });
  }
}

/**
 * Void/cancel a challenge without picking winners.
 * Closes the collection and marks the challenge as Cancelled.
 */
export async function voidChallenge(challengeId: number) {
  // Get the challenge
  const challenge = await getChallengeById(challengeId);
  if (!challenge) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Challenge not found' });
  }

  // Validate status. Cancelled is allowed so a void whose refund threw mid-way can be re-run to
  // finish the (idempotent) refund, rather than stranding the funds.
  if (
    challenge.status !== ChallengeStatus.Active &&
    challenge.status !== ChallengeStatus.Scheduled &&
    challenge.status !== ChallengeStatus.Cancelled
  ) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `Cannot void challenge with status "${String(
        challenge.status
      )}". Challenge must be Active, Scheduled, or Cancelled.`,
    });
  }

  log('Voiding challenge:', challengeId);

  // Claim the row (Active/Scheduled -> Cancelled) BEFORE refunding, unless it is already Cancelled
  // (a retry of a prior void whose refund failed — skip the claim and just re-refund idempotently).
  // The claim stops (a) two concurrent voids from both refunding, and (b) — critically — a void from
  // refunding a pool the completion cron is simultaneously claiming to pay to winners, which would
  // mint (the cron's own Active->Completing claim can no longer win once we've flipped to Cancelled).
  // If the claim is lost, another void or completion advanced the row; do not refund here — a
  // stranded refund is recovered by re-running void, which lands on the Cancelled branch below.
  if (challenge.status !== ChallengeStatus.Cancelled) {
    const claimed = await dbWrite.challenge.updateMany({
      where: {
        id: challengeId,
        status: { in: [ChallengeStatus.Active, ChallengeStatus.Scheduled] },
      },
      data: { status: ChallengeStatus.Cancelled },
    });
    if (claimed.count !== 1) {
      log('Void claim lost (completion or a concurrent void won); skipping refund');
      return { success: true };
    }
    log('Challenge status updated to Cancelled');
  }

  // Close the collection if exists
  await closeChallengeCollection(challenge);
  log('Collection closed');

  const { refundedEntries } = await refundUserChallengeFunds(challengeId);
  log(`Refunded ${refundedEntries} entry fees`);
  if (refundedEntries > 0) {
    await notifyEntrantsOfCancellation(challenge);
  }

  return { success: true };
}

/**
 * Get active ChallengeJudge records for the moderator dropdown.
 */
export type ActiveJudge = {
  id: number;
  userId: number | null;
  name: string;
  bio: string | null;
  reviewPrompt: string | null;
};

// Active judges for the challenge form dropdowns. Moderators get every active judge plus the
// sensitive fields (userId and reviewPrompt — the full judging rubric). Everyone else gets only the
// publicly selectable, SFW judges with display fields; userId/reviewPrompt are never fetched and come
// back null. Gate on the REAL ctx.user.isModerator — never a client-supplied flag — since reviewPrompt
// leaking would let entrants game the judge.
export async function getActiveJudges({
  isModerator,
}: {
  isModerator: boolean;
}): Promise<ActiveJudge[]> {
  if (isModerator) {
    return dbRead.challengeJudge.findMany({
      where: { active: true },
      orderBy: { name: 'asc' },
      select: { id: true, userId: true, name: true, bio: true, reviewPrompt: true },
    });
  }

  const rows = await getUserSelectableJudges();
  return rows.map((r) => ({ ...r, userId: null, reviewPrompt: null }));
}

/**
 * Check whether images are eligible for a challenge entry.
 * Validates NSFW level, model version usage (via ImageResourceNew), and recency.
 */
export async function checkImageEligibility(
  challengeId: number,
  imageIds: number[]
): Promise<ImageEligibilityResult[]> {
  const challenge = await dbRead.challenge.findUnique({
    where: { id: challengeId },
    select: {
      allowedNsfwLevel: true,
      modelVersionIds: true,
      startsAt: true,
    },
  });

  if (!challenge) throw throwNotFoundError(`No challenge with id ${challengeId}`);

  // Route to writer while DataPacket replica is missing ImageResourceNew backfill.
  const useWrite = await isFlipt(FLIPT_FEATURE_FLAGS.IMAGE_RESOURCE_USE_WRITE);
  const db = useWrite ? dbWrite : dbRead;
  // Get image details + their resources in one query
  const images = await db.$queryRawUnsafe<
    Array<{
      id: number;
      nsfwLevel: number;
      createdAt: Date;
      modelVersionIds: number[] | null;
    }>
  >(
    `
    SELECT
      i.id,
      i."nsfwLevel",
      i."createdAt",
      array_agg(DISTINCT ir."modelVersionId") FILTER (WHERE ir."modelVersionId" IS NOT NULL) AS "modelVersionIds"
    FROM "Image" i
    LEFT JOIN "ImageResourceNew" ir ON ir."imageId" = i.id
    WHERE i.id = ANY($1::int[])
    GROUP BY i.id
    `,
    imageIds
  );

  const imageMap = new Map(images.map((img) => [img.id, img]));

  return imageIds.map((imageId) => {
    const image = imageMap.get(imageId);
    if (!image) return { imageId, eligible: false, reasons: ['Image not found'] };

    const reasons: string[] = [];

    // Check NSFW level
    if (image.nsfwLevel !== 0 && (image.nsfwLevel & challenge.allowedNsfwLevel) === 0) {
      reasons.push('NSFW restricted');
    }

    // Check recency
    if (new Date(image.createdAt) < new Date(challenge.startsAt)) {
      reasons.push('Created before challenge');
    }

    // Check model version requirement
    if (challenge.modelVersionIds.length > 0) {
      const imageVersionIds = image.modelVersionIds ?? [];
      const hasEligibleModel = imageVersionIds.some((vid) =>
        challenge.modelVersionIds.includes(vid)
      );
      if (!hasEligibleModel) {
        reasons.push('Wrong model');
      }
    }

    return { imageId, eligible: reasons.length === 0, reasons };
  });
}

/**
 * Get system challenge configuration with resolved judge info.
 */
export async function getChallengeSystemConfig() {
  const config = await getChallengeConfig();

  let defaultJudge: { id: number; name: string; bio: string | null } | null = null;
  if (config.defaultJudgeId) {
    const judge = await dbRead.challengeJudge.findUnique({
      where: { id: config.defaultJudgeId },
      select: { id: true, name: true, bio: true },
    });
    if (judge) defaultJudge = judge;
  }

  return { defaultJudgeId: config.defaultJudgeId, defaultJudge };
}

/**
 * Update system challenge configuration (e.g., default judge).
 */
export async function updateChallengeSystemConfig(input: UpdateChallengeConfigInput) {
  if (input.defaultJudgeId !== null) {
    const judge = await dbRead.challengeJudge.findUnique({
      where: { id: input.defaultJudgeId },
      select: { id: true, active: true },
    });
    if (!judge) throw new TRPCError({ code: 'NOT_FOUND', message: 'Judge not found' });
    if (!judge.active)
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Cannot set an inactive judge as default',
      });
  }

  await setChallengeConfig({ defaultJudgeId: input.defaultJudgeId });
  return getChallengeSystemConfig();
}

// --- Challenge Events ---

/**
 * Get active challenge events with their challenges.
 * Returns events where active=true and endDate >= now, ordered by startDate.
 */
export async function getActiveEvents(): Promise<ChallengeEventListItem[]> {
  const events = await dbRead.challengeEvent.findMany({
    where: {
      active: true,
      endDate: { gte: new Date() },
    },
    orderBy: { startDate: 'asc' },
    select: {
      id: true,
      title: true,
      description: true,
      titleColor: true,
      startDate: true,
      endDate: true,
      challenges: {
        where: {
          visibleAt: { lte: new Date() },
          status: { not: ChallengeStatus.Cancelled },
        },
        orderBy: { startsAt: 'asc' },
        select: {
          id: true,
          title: true,
          theme: true,
          invitation: true,
          coverImageId: true,
          startsAt: true,
          endsAt: true,
          status: true,
          source: true,
          nsfwLevel: true,
          allowedNsfwLevel: true,
          prizePool: true,
          modelVersionIds: true,
          collectionId: true,
          createdById: true,
          judgeId: true,
        },
      },
    },
  });

  // Batch-enrich all challenges across all events
  const allChallenges = events.flatMap((e) => e.challenges);
  if (allChallenges.length === 0) {
    return events.map((e) => ({ ...e, challenges: [] }));
  }

  // Get judge user IDs for challenges that have judges
  const judgeIds = [...new Set(allChallenges.map((c) => c.judgeId).filter(isDefined))];
  const judgeUserMap = new Map<number, number>();
  if (judgeIds.length > 0) {
    const judges = await dbRead.challengeJudge.findMany({
      where: { id: { in: judgeIds } },
      select: { id: true, userId: true },
    });
    for (const j of judges) judgeUserMap.set(j.id, j.userId);
  }

  // Collect all display user IDs (creator for user challenges, else judge user)
  const displayUserIds = [
    ...new Set(
      allChallenges
        .map((c) =>
          displayUidFor({
            source: c.source,
            judgeUserId: c.judgeId ? judgeUserMap.get(c.judgeId) ?? null : null,
            createdById: c.createdById ?? -1,
          })
        )
        .filter(isDefined)
    ),
  ];

  // Batch-fetch users, profile pictures, cosmetics, cover images, entry counts
  const [users, profilePictures, cosmetics] = await Promise.all([
    dbRead.user
      .findMany({
        where: { id: { in: displayUserIds } },
        select: { id: true, username: true, image: true, deletedAt: true },
      })
      .then((u) => new Map(u.map((x) => [x.id, x]))),
    getProfilePicturesForUsers(displayUserIds),
    getCosmeticsForUsers(displayUserIds),
  ]);

  const coverImageIds = allChallenges.map((c) => c.coverImageId).filter(isDefined);
  const coverImages =
    coverImageIds.length > 0
      ? await dbRead.image
          .findMany({ where: { id: { in: coverImageIds } }, select: imageSelect })
          .then((imgs) => new Map(imgs.map((img) => [img.id, img])))
      : new Map();

  // Get entry counts for all challenges
  const collectionIds = allChallenges.map((c) => c.collectionId).filter(isDefined);
  const entryCounts = new Map<number, number>();
  if (collectionIds.length > 0) {
    const counts = await dbRead.$queryRaw<
      Array<{ collectionId: number; count: bigint }>
    >`SELECT "collectionId", COUNT(*) as count FROM "CollectionItem" WHERE "collectionId" IN (${Prisma.join(
      collectionIds
    )}) AND status = 'ACCEPTED' GROUP BY "collectionId"`;
    for (const row of counts) entryCounts.set(row.collectionId, Number(row.count));
  }

  // Get comment counts for all challenges
  const allChallengeIds = allChallenges.map((c) => c.id);
  const commentCounts = new Map<number, number>();
  if (allChallengeIds.length > 0) {
    const counts = await dbRead.$queryRaw<
      Array<{ challengeId: number; commentCount: number }>
    >`SELECT "challengeId", "commentCount" FROM "Thread" WHERE "challengeId" IN (${Prisma.join(
      allChallengeIds
    )})`;
    for (const row of counts) commentCounts.set(row.challengeId, row.commentCount);
  }

  return events.map((event) => ({
    id: event.id,
    title: event.title,
    description: event.description,
    titleColor: event.titleColor,
    startDate: event.startDate,
    endDate: event.endDate,
    challenges: event.challenges.map((c) => {
      // createdById can be null (creator account deleted); fall back to the system user (-1).
      const displayUserId = displayUidFor({
        source: c.source,
        judgeUserId: c.judgeId ? judgeUserMap.get(c.judgeId) ?? null : null,
        createdById: c.createdById ?? -1,
      });
      const user = users.get(displayUserId);
      const coverImage = c.coverImageId ? coverImages.get(c.coverImageId) : null;

      return {
        id: c.id,
        title: c.title,
        theme: c.theme,
        invitation: c.invitation,
        startsAt: c.startsAt,
        endsAt: c.endsAt,
        status: c.status,
        source: c.source,
        // createdById can be null (creator account deleted); fall back to the system user (-1),
        // matching the displayUserId fallback above.
        createdById: c.createdById ?? -1,
        nsfwLevel: c.nsfwLevel,
        allowedNsfwLevel: c.allowedNsfwLevel,
        prizePool: c.prizePool,
        collectionId: c.collectionId,
        entryCount: c.collectionId ? entryCounts.get(c.collectionId) ?? 0 : 0,
        commentCount: commentCounts.get(c.id) ?? 0,
        coverImage: coverImage
          ? {
              id: coverImage.id,
              url: coverImage.url,
              nsfwLevel: coverImage.nsfwLevel,
              hash: coverImage.hash,
              width: coverImage.width,
              height: coverImage.height,
              type: coverImage.type,
            }
          : null,
        modelVersionIds: c.modelVersionIds ?? [],
        createdBy: {
          id: displayUserId,
          username: user?.username ?? null,
          image: user?.image ?? null,
          profilePicture: profilePictures[displayUserId] ?? null,
          cosmetics: cosmetics[displayUserId] ?? null,
          deletedAt: user?.deletedAt ?? null,
        },
      };
    }),
  }));
}

/**
 * Get all challenge events (for moderator management).
 */
export async function getChallengeEvents(input: GetChallengeEventsInput) {
  const where = input.activeOnly ? { active: true, endDate: { gte: new Date() } } : {};
  return dbRead.challengeEvent.findMany({
    where,
    orderBy: { startDate: 'desc' },
    select: {
      id: true,
      title: true,
      description: true,
      titleColor: true,
      startDate: true,
      endDate: true,
      active: true,
      winnerCooldownDays: true,
      createdAt: true,
      _count: { select: { challenges: true } },
    },
  });
}

/**
 * Create or update a challenge event.
 */
export async function upsertChallengeEvent({
  userId,
  ...input
}: UpsertChallengeEventInput & { userId: number }) {
  const { id, ...data } = input;

  if (data.endDate <= data.startDate) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'End date must be after start date',
    });
  }

  return dbWrite.$transaction(async (tx) => {
    if (id) {
      return tx.challengeEvent.update({
        where: { id },
        data,
      });
    }

    return tx.challengeEvent.create({
      data: {
        ...data,
        createdById: userId,
      },
    });
  });
}

/**
 * Delete a challenge event.
 * The FK on Challenge.eventId is defined with onDelete: SetNull,
 * so linked challenges are automatically unlinked by the DB.
 */
export async function deleteChallengeEvent(id: number) {
  await dbWrite.challengeEvent.delete({ where: { id } });
  return { success: true };
}

// --- Judge Playground ---

/**
 * Get a single judge by ID with all prompt fields.
 */
export async function getJudgeById(id: number) {
  const judge = await dbRead.challengeJudge.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      name: true,
      bio: true,
      active: true,
      sourceCollectionId: true,
      systemPrompt: true,
      collectionPrompt: true,
      contentPrompt: true,
      reviewPrompt: true,
      reviewTemplate: true,
      winnerSelectionPrompt: true,
      userSelectable: true,
    },
  });
  if (!judge) throw new TRPCError({ code: 'NOT_FOUND', message: 'Judge not found' });
  return judge;
}

/**
 * Create or update a ChallengeJudge.
 * If the saved judge is the current default, refresh the cached config in Redis.
 */
export async function upsertJudge(input: UpsertJudgeInput & { userId: number }) {
  const { id, userId, ...data } = input;

  // Validate reviewTemplate JSON if provided
  if (data.reviewTemplate) {
    try {
      const parsed = JSON.parse(data.reviewTemplate);
      reviewTemplateSchema.parse(parsed);
    } catch (e) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Invalid review template: ${e instanceof Error ? e.message : 'Invalid JSON'}`,
      });
    }
  }

  const judge = await dbWrite.challengeJudge.upsert({
    where: { id: id ?? -1 },
    create: {
      userId,
      name: data.name,
      bio: data.bio ?? null,
      sourceCollectionId: data.sourceCollectionId ?? null,
      systemPrompt: data.systemPrompt ?? null,
      collectionPrompt: data.collectionPrompt ?? null,
      contentPrompt: data.contentPrompt ?? null,
      reviewPrompt: data.reviewPrompt ?? null,
      reviewTemplate: data.reviewTemplate ?? null,
      winnerSelectionPrompt: data.winnerSelectionPrompt ?? null,
      active: data.active ?? true,
      userSelectable: data.userSelectable ?? false,
    },
    update: {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.bio !== undefined && { bio: data.bio }),
      ...(data.sourceCollectionId !== undefined && {
        sourceCollectionId: data.sourceCollectionId,
      }),
      ...(data.systemPrompt !== undefined && { systemPrompt: data.systemPrompt }),
      ...(data.collectionPrompt !== undefined && { collectionPrompt: data.collectionPrompt }),
      ...(data.contentPrompt !== undefined && { contentPrompt: data.contentPrompt }),
      ...(data.reviewPrompt !== undefined && { reviewPrompt: data.reviewPrompt }),
      ...(data.reviewTemplate !== undefined && { reviewTemplate: data.reviewTemplate }),
      ...(data.winnerSelectionPrompt !== undefined && {
        winnerSelectionPrompt: data.winnerSelectionPrompt,
      }),
      ...(data.active !== undefined && { active: data.active }),
      ...(data.userSelectable !== undefined && { userSelectable: data.userSelectable }),
    },
  });

  // Refresh Redis cache if this judge is the current default
  const config = await getChallengeConfig();
  if (config.defaultJudgeId === judge.id) {
    await refreshDefaultJudgeCache();
  }

  return judge;
}

/**
 * Apply prompt overrides to a JudgingConfig, returning a new config.
 */
function applyPromptOverrides(
  config: JudgingConfig,
  overrides?: Partial<ChallengePrompts>
): JudgingConfig {
  if (!overrides) return config;
  return {
    ...config,
    prompts: {
      ...config.prompts,
      ...(overrides.systemMessage !== undefined && { systemMessage: overrides.systemMessage }),
      ...(overrides.collection !== undefined && { collection: overrides.collection }),
      ...(overrides.content !== undefined && { content: overrides.content }),
      ...(overrides.review !== undefined && { review: overrides.review }),
      ...(overrides.winner !== undefined && { winner: overrides.winner }),
    },
  };
}

/**
 * Playground: Generate challenge content for a model version.
 */
export async function playgroundGenerateContent(input: PlaygroundGenerateContentInput) {
  // Get judge config
  const config = await getChallengeConfig();
  const judgeId = input.judgeId ?? config.defaultJudgeId ?? 1;
  let judgingConfig = await getJudgingConfig(judgeId);

  // Apply prompt overrides
  judgingConfig = applyPromptOverrides(judgingConfig, input.promptOverrides);

  // Get model version info
  const modelVersion = await dbRead.modelVersion.findUnique({
    where: { id: input.modelVersionId },
    select: {
      id: true,
      model: { select: { id: true, name: true, user: { select: { username: true } } } },
    },
  });
  if (!modelVersion) throw new TRPCError({ code: 'NOT_FOUND', message: 'Model version not found' });

  const coverImage = await getCoverOfModel(modelVersion.model.id);

  const result = await generateArticle({
    resource: {
      modelId: modelVersion.model.id,
      title: modelVersion.model.name,
      creator: modelVersion.model.user.username ?? 'Unknown',
    },
    image: coverImage,
    challengeDate: new Date(),
    prizes: config.prizes,
    entryPrizeRequirement: config.entryPrizeRequirement,
    entryPrize: config.entryPrize,
    allowedNsfwLevel: 1,
    config: judgingConfig,
    model: (input.aiModel || undefined) as AIModel | undefined,
  });

  return result;
}

/**
 * Playground: Review an image with a judge.
 */
export async function playgroundReviewImage(input: PlaygroundReviewImageInput) {
  const config = await getChallengeConfig();
  const judgeId = input.judgeId ?? config.defaultJudgeId ?? 1;
  let judgingConfig = await getJudgingConfig(judgeId);

  judgingConfig = applyPromptOverrides(judgingConfig, input.promptOverrides);

  // Apply reviewTemplate override from playground draft
  if (input.reviewTemplate != null) {
    judgingConfig = { ...judgingConfig, reviewTemplate: input.reviewTemplate || null };
  }

  // Resolve imageId to an image URL
  const image = await dbRead.image.findUnique({
    where: { id: input.imageId },
    select: { url: true, user: { select: { username: true } } },
  });
  if (!image) throw new TRPCError({ code: 'NOT_FOUND', message: 'Image not found' });

  const imageUrl = getEdgeUrl(image.url, { width: 1200, name: 'image', optimized: true });

  const categories = input.judgingCategories?.length
    ? (await resolveJudgingCategories(input.judgingCategories)).map((c) => ({
        key: c.key,
        name: c.label,
        criteria: c.criteria,
      }))
    : undefined;

  const result = await generateReview({
    theme: input.theme,
    themeElements: input.themeElements,
    creator: input.creator ?? image.user?.username ?? 'Unknown',
    imageUrl,
    config: judgingConfig,
    categories,
    nsfw: input.nsfw,
    model: (input.aiModel || undefined) as AIModel | undefined,
  });

  return result;
}

/**
 * Playground: Pick winners from a challenge's judged entries.
 */
export async function playgroundPickWinners(input: PlaygroundPickWinnersInput) {
  const challengeConfig = await getChallengeConfig();
  const judgeId = input.judgeId ?? challengeConfig.defaultJudgeId ?? 1;
  let judgingConfig = await getJudgingConfig(judgeId);

  judgingConfig = applyPromptOverrides(judgingConfig, input.promptOverrides);

  const challenge = await getChallengeById(input.challengeId);
  if (!challenge) throw new TRPCError({ code: 'NOT_FOUND', message: 'Challenge not found' });
  if (!challenge.collectionId)
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Challenge has no collection' });

  // Rank by stored judgingCategories when present (any source); otherwise the fixed rubric. Parse
  // defensively — a malformed value falls back to the fixed schema.
  const userJudgingCategories = challengeJudgingCategoriesSchema.safeParse(
    challenge.judgingCategories
  );
  const userCategories = userJudgingCategories.success ? userJudgingCategories.data : undefined;

  const entries = await getJudgedEntries(
    challenge.collectionId,
    challengeConfig,
    undefined,
    challenge.source,
    userCategories
  );
  if (entries.length < 3)
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Need at least 3 judged entries, found ${entries.length}`,
    });

  const result = await generateWinners({
    entries: entries.map((e) => ({
      creatorId: e.userId,
      creator: e.username,
      summary: e.summary,
      score: e.score,
    })),
    theme: challenge.theme ?? 'Unknown',
    config: judgingConfig,
    model: (input.aiModel || undefined) as AIModel | undefined,
  });

  return result;
}

// ─── Previous Winners Page ───────────────────────────────────────────────────

export async function getCompletedChallengesWithWinners(
  input: GetCompletedChallengesWithWinnersInput & { isGreen?: boolean; currentUserId?: number }
) {
  const { cursor, limit, eventId, browsingLevel, query, isGreen, currentUserId } = input;

  // Phase 1: Query completed challenges with cursor pagination
  const conditions: Prisma.Sql[] = [
    Prisma.sql`c."visibleAt" <= now()`,
    Prisma.sql`c.status = 'Completed'::"ChallengeStatus"`,
    Prisma.sql`EXISTS (SELECT 1 FROM "ChallengeWinner" cw WHERE cw."challengeId" = c.id)`,
  ];

  if (eventId) {
    conditions.push(Prisma.sql`c."eventId" = ${eventId}`);
  }

  // Domain-currency gate — parity with the feed: a user challenge only appears on its own domain
  // (green on green, yellow off-green). System/mod/event challenges are universal. Creator exempt.
  const domainCurrency = deriveDomainCurrency(isGreen ?? false);
  conditions.push(
    currentUserId
      ? Prisma.sql`(c.source <> 'User'::"ChallengeSource" OR c."buzzType" = ${domainCurrency} OR c."createdById" = ${currentUserId})`
      : Prisma.sql`(c.source <> 'User'::"ChallengeSource" OR c."buzzType" = ${domainCurrency})`
  );

  // Content level filter — parity with the feed: exclude a challenge whose REAL cover image level
  // doesn't intersect the viewer's effective (green-capped) browsing level, rather than trusting
  // the declared allowedNsfwLevel. Creator sees their own.
  const effectiveBrowsingLevel = getEffectiveBrowsingLevel({
    isGreen: isGreen ?? false,
    isLoggedIn: currentUserId != null,
    requested: browsingLevel,
  });
  if (effectiveBrowsingLevel > 0) {
    conditions.push(
      currentUserId
        ? Prisma.sql`(c."createdById" = ${currentUserId} OR EXISTS (SELECT 1 FROM "Image" i WHERE i.id = c."coverImageId" AND (i."nsfwLevel" & ${effectiveBrowsingLevel}) <> 0))`
        : Prisma.sql`EXISTS (SELECT 1 FROM "Image" i WHERE i.id = c."coverImageId" AND (i."nsfwLevel" & ${effectiveBrowsingLevel}) <> 0)`
    );
  }

  if (query) {
    const searchPattern = `%${String(query)}%`;
    conditions.push(Prisma.sql`(c.title ILIKE ${searchPattern} OR c.theme ILIKE ${searchPattern})`);
  }

  // Cursor-based pagination: "endsAt:id"
  if (cursor) {
    const lastColon = cursor.lastIndexOf(':');
    if (lastColon !== -1) {
      const endsAtStr = cursor.slice(0, lastColon);
      const idStr = cursor.slice(lastColon + 1);
      const id = parseInt(idStr, 10);
      const endsAt = new Date(endsAtStr);
      if (!isNaN(id) && !isNaN(endsAt.getTime())) {
        conditions.push(
          Prisma.sql`(c."endsAt" < ${endsAt} OR (c."endsAt" = ${endsAt} AND c.id < ${id}))`
        );
      }
    }
  }

  const whereClause = Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`;

  const items = await dbRead.$queryRaw<
    Array<{
      id: number;
      title: string;
      theme: string | null;
      invitation: string | null;
      coverImageId: number | null;
      startsAt: Date;
      endsAt: Date;
      status: ChallengeStatus;
      source: ChallengeSource;
      prizePool: number;
      entryCount: bigint;
      commentCount: bigint;
      nsfwLevel: number;
      allowedNsfwLevel: number;
      modelVersionIds: number[] | null;
      collectionId: number | null;
      createdById: number;
      creatorUsername: string | null;
      creatorImage: string | null;
      creatorDeletedAt: Date | null;
      judgeUserId: number | null;
      judgeUsername: string | null;
      judgeImage: string | null;
      judgeDeletedAt: Date | null;
      metadata: Record<string, unknown> | null;
    }>
  >`
    SELECT
      c.id,
      c.title,
      c.theme,
      c.invitation,
      c."coverImageId",
      c."startsAt",
      c."endsAt",
      c.status,
      c.source,
      c."prizePool",
      (SELECT COUNT(*) FROM "CollectionItem" WHERE "collectionId" = c."collectionId" AND status = 'ACCEPTED') as "entryCount",
      COALESCE((SELECT t."commentCount" FROM "Thread" t WHERE t."challengeId" = c.id), 0) as "commentCount",
      c."nsfwLevel",
      c."allowedNsfwLevel",
      c."modelVersionIds",
      c."collectionId",
      c."createdById",
      u.username as "creatorUsername",
      u.image as "creatorImage",
      u."deletedAt" as "creatorDeletedAt",
      cj."userId" as "judgeUserId",
      ju.username as "judgeUsername",
      ju.image as "judgeImage",
      ju."deletedAt" as "judgeDeletedAt",
      c.metadata
    FROM "Challenge" c
    JOIN "User" u ON u.id = c."createdById"
    LEFT JOIN "ChallengeJudge" cj ON cj.id = c."judgeId"
    LEFT JOIN "User" ju ON ju.id = cj."userId"
    ${whereClause}
    ORDER BY c."endsAt" DESC, c.id DESC
    LIMIT ${limit + 1}
  `;

  // Check for more results
  let nextCursor: string | undefined;
  if (items.length > limit) {
    const nextItem = items.pop();
    if (nextItem) {
      nextCursor = `${nextItem.endsAt.toISOString()}:${nextItem.id}`;
    }
  }

  if (items.length === 0) {
    return { items: [] as ChallengeWithWinnersListItem[], nextCursor };
  }

  // Phase 2: Batch-fetch all winners for returned challenge IDs
  const challengeIds = items.map((i) => i.id);
  const winnerRows = await dbRead.$queryRaw<
    Array<{
      challengeId: number;
      place: number;
      userId: number;
      username: string;
      imageId: number | null;
      imageUrl: string | null;
      imageNsfwLevel: number | null;
      imageHash: string | null;
      buzzAwarded: number;
      reason: string | null;
      collectionItemNote: string | null;
    }>
  >`
    SELECT
      cw."challengeId",
      cw.place,
      cw."userId",
      u.username,
      cw."imageId",
      i.url as "imageUrl",
      i."nsfwLevel" as "imageNsfwLevel",
      i.hash as "imageHash",
      cw."buzzAwarded",
      cw.reason,
      ci.note as "collectionItemNote"
    FROM "ChallengeWinner" cw
    JOIN "User" u ON u.id = cw."userId"
    LEFT JOIN "Image" i ON i.id = cw."imageId"
    JOIN "Challenge" c ON c.id = cw."challengeId"
    LEFT JOIN "CollectionItem" ci ON ci."collectionId" = c."collectionId"
      AND ci."imageId" = cw."imageId"
    WHERE cw."challengeId" IN (${Prisma.join(challengeIds)})
    ORDER BY cw.place ASC
  `;

  // Batch enrich: profile pictures + cosmetics for both display users (creators/judges) and winners
  const winnerUserIds = [...new Set(winnerRows.map((w) => w.userId))];
  const displayUserIds = [...new Set(items.map(displayUidFor))];
  const allUserIds = [...new Set([...displayUserIds, ...winnerUserIds])];
  const [profilePictures, cosmetics] = await Promise.all([
    getProfilePicturesForUsers(allUserIds),
    getCosmeticsForUsers(allUserIds),
  ]);

  // Group winners by challengeId. Defense-in-depth: on green, null out any winner thumbnail whose
  // real image level isn't SFW (a green challenge's entries are already SFW by the entry gate, so
  // this only bites on mislabeled data). The frontend WinnerPodiumCard also keys ImageGuard2 on
  // imageNsfwLevel.
  const winnersByChallengeId = new Map<number, ChallengeWinnerSummary[]>();
  for (const w of winnerRows) {
    const list = winnersByChallengeId.get(w.challengeId) ?? [];
    const hideThumb = (isGreen ?? false) && isImageHiddenFromGreenViewer(w.imageNsfwLevel, currentUserId);
    list.push({
      place: w.place,
      userId: w.userId,
      username: w.username,
      imageId: w.imageId,
      imageUrl: hideThumb ? null : w.imageUrl,
      imageNsfwLevel: w.imageNsfwLevel,
      imageHash: w.imageHash,
      buzzAwarded: w.buzzAwarded,
      reason: w.reason,
      judgeScore: parseJudgeScore(w.collectionItemNote),
      profilePicture: profilePictures[w.userId] ?? null,
      cosmetics: cosmetics[w.userId] ?? null,
    });
    winnersByChallengeId.set(w.challengeId, list);
  }

  // Fetch cover images
  const coverImageIds = items.map((item) => item.coverImageId).filter((id): id is number => !!id);
  const coverImages =
    coverImageIds.length > 0
      ? await dbRead.image.findMany({
          where: { id: { in: coverImageIds } },
          select: imageSelect,
        })
      : [];

  // Transform results
  const coverImageMap = new Map(coverImages.map((img) => [img.id, img]));
  const challenges: ChallengeWithWinnersListItem[] = items.map((item) => {
    const coverImage = item.coverImageId ? coverImageMap.get(item.coverImageId) ?? null : null;
    const metadata = parseChallengeMetadata(item.metadata);

    const displayUid = displayUidFor(item);
    const showJudge = displayUid !== item.createdById;

    return {
      id: item.id,
      title: item.title,
      theme: item.theme,
      invitation: item.invitation,
      startsAt: item.startsAt,
      endsAt: item.endsAt,
      status: item.status,
      source: item.source,
      createdById: item.createdById,
      prizePool: item.prizePool,
      nsfwLevel: item.nsfwLevel,
      allowedNsfwLevel: item.allowedNsfwLevel,
      collectionId: item.collectionId,
      entryCount: Number(item.entryCount),
      commentCount: Number(item.commentCount),
      coverImage: coverImage
        ? {
            id: coverImage.id,
            url: coverImage.url,
            nsfwLevel: coverImage.nsfwLevel,
            hash: coverImage.hash,
            width: coverImage.width,
            height: coverImage.height,
            type: coverImage.type,
          }
        : null,
      modelVersionIds: item.modelVersionIds ?? [],
      createdBy: {
        id: displayUid,
        username: showJudge ? item.judgeUsername : item.creatorUsername,
        image: showJudge ? item.judgeImage : item.creatorImage,
        profilePicture: profilePictures[displayUid] ?? null,
        cosmetics: cosmetics[displayUid] ?? null,
        deletedAt: showJudge ? item.judgeDeletedAt : item.creatorDeletedAt,
      },
      winners: winnersByChallengeId.get(item.id) ?? [],
      completionSummary: metadata.completionSummary ?? null,
    };
  });

  return { items: challenges, nextCursor };
}

// ─── Winner Cooldown Status ──────────────────────────────────────────────────

export async function getWinnerCooldownStatus(
  challengeId: number,
  userId: number
): Promise<WinnerCooldownStatus> {
  // 1. Look up challenge's eventId
  const [challenge] = await dbRead.$queryRaw<[{ eventId: number | null }] | []>`
    SELECT "eventId" FROM "Challenge" WHERE id = ${challengeId}
  `;

  if (!challenge) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Challenge not found' });
  }

  // 2. Resolve event context
  const eventContext = await resolveEventContext(challenge.eventId);

  // 3. Get global config for default cooldown
  const config = await getChallengeConfig();

  // 4. Determine effective cooldown
  if (eventContext.winnerCooldownDays === 0) {
    // Event explicitly disables cooldown
    return {
      onCooldown: false,
      cooldownEndsAt: null,
      lastWinDate: null,
      lastWinChallengeId: null,
      cooldownDays: 0,
    };
  }

  const cooldownInterval =
    eventContext.winnerCooldownDays != null
      ? `${eventContext.winnerCooldownDays} day`
      : config.winnerCooldown;

  // Parse interval to days for the response
  const cooldownDays =
    eventContext.winnerCooldownDays != null
      ? eventContext.winnerCooldownDays
      : parseInt(config.winnerCooldown, 10) || 7;

  // 5. Query user's most recent win within scope
  const eventCondition =
    challenge.eventId != null
      ? Prisma.sql`AND ch."eventId" = ${challenge.eventId}`
      : Prisma.sql`AND ch."eventId" IS NULL`;

  const [lastWin] = await dbRead.$queryRaw<[{ createdAt: Date; challengeId: number }] | []>`
    SELECT cw."createdAt", cw."challengeId"
    FROM "ChallengeWinner" cw
    JOIN "Challenge" ch ON ch.id = cw."challengeId"
    WHERE cw."userId" = ${userId}
      AND ch.status = 'Completed'
      AND cw."createdAt" > now() - ${cooldownInterval}::interval
      ${eventCondition}
    ORDER BY cw."createdAt" DESC
    LIMIT 1
  `;

  if (!lastWin) {
    return {
      onCooldown: false,
      cooldownEndsAt: null,
      lastWinDate: null,
      lastWinChallengeId: null,
      cooldownDays,
    };
  }

  // 6. Calculate cooldown end
  const cooldownEndsAt = new Date(lastWin.createdAt.getTime() + cooldownDays * 24 * 60 * 60 * 1000);

  return {
    onCooldown: cooldownEndsAt > new Date(),
    cooldownEndsAt,
    lastWinDate: lastWin.createdAt,
    lastWinChallengeId: lastWin.challengeId,
    cooldownDays,
  };
}
