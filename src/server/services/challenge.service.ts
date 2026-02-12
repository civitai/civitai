import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  closeChallengeCollection,
  createChallengeWinner,
  getChallengeById,
  getChallengeWinners,
} from '~/server/games/daily-challenge/challenge-helpers';
// Re-export getChallengeWinners so router can import from service (separation of concerns)
export { getChallengeWinners } from '~/server/games/daily-challenge/challenge-helpers';
import {
  ChallengeSort,
  type ChallengeCompletionSummary,
  type ChallengeDetail,
  type ChallengeEventListItem,
  type ChallengeListItem,
  type GetInfiniteChallengesInput,
  type GetModeratorChallengesInput,
  type GetChallengeEventsInput,
  type ImageEligibilityResult,
  type UpcomingTheme,
  type UpsertChallengeInput,
  type UpsertChallengeEventInput,
  type UpdateChallengeConfigInput,
} from '~/server/schema/challenge.schema';
import type { ChallengeSource } from '~/shared/utils/prisma/enums';
import {
  ChallengeStatus,
  CollectionMode,
  CollectionReadConfiguration,
  CollectionType,
  CollectionWriteConfiguration,
} from '~/shared/utils/prisma/enums';
import { createImage, imagesForModelVersionsCache } from '~/server/services/image.service';
import { getCosmeticsForUsers, getProfilePicturesForUsers } from '~/server/services/user.service';
import { throwNotFoundError } from '~/server/utils/errorHandling';
import type { CollectionMetadataSchema } from '~/server/schema/collection.schema';
import { imageSelect } from '~/server/selectors/image.selector';
import {
  getChallengeConfig,
  setChallengeConfig,
  getJudgingConfig,
  type JudgingConfig,
} from '~/server/games/daily-challenge/daily-challenge.utils';
import { generateWinners } from '~/server/games/daily-challenge/generative-content';
import { getJudgedEntries } from '~/server/jobs/daily-challenge-processing';
import { collectionsSearchIndex } from '~/server/search-index';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { NotificationCategory } from '~/server/common/enums';
import { TransactionType } from '~/shared/constants/buzz.constants';
import { createBuzzTransactionMany } from '~/server/services/buzz.service';
import { createNotification } from '~/server/services/notification.service';
import { withRetries } from '~/utils/errorHandling';
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
export async function getInfiniteChallenges(input: GetInfiniteChallengesInput) {
  const {
    query,
    status,
    source,
    sort,
    userId,
    modelVersionId,
    includeEnded,
    excludeEventChallenges,
    limit,
    cursor,
  } = input;

  // Build WHERE conditions using parameterized queries (SQL injection safe)
  const conditions: Prisma.Sql[] = [];

  // Only show visible challenges
  conditions.push(Prisma.sql`c."visibleAt" <= now()`);

  // Status filter (parameterized)
  if (status && status.length > 0) {
    const statusValues = status.map((s) => Prisma.sql`${s}::"ChallengeStatus"`);
    conditions.push(Prisma.sql`c.status IN (${Prisma.join(statusValues)})`);
  } else if (!includeEnded) {
    conditions.push(
      Prisma.sql`c.status NOT IN ('Completed'::"ChallengeStatus", 'Cancelled'::"ChallengeStatus")`
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
      modelVersionIds: number[] | null;
      modelId: number | null;
      modelName: string | null;
      collectionId: number | null;
      createdById: number;
      creatorUsername: string | null;
      creatorImage: string | null;
      creatorDeletedAt: Date | null;
      judgeUserId: number | null;
      judgeUsername: string | null;
      judgeImage: string | null;
      judgeDeletedAt: Date | null;
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
    LEFT JOIN "User" ju ON ju.id = cj."userId"
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

  // Fetch profile pictures for display users (judge when present, else creator)
  const displayUserIds = [...new Set(items.map((item) => item.judgeUserId ?? item.createdById))];
  const [profilePictures, cosmetics] = await Promise.all([
    getProfilePicturesForUsers(displayUserIds),
    getCosmeticsForUsers(displayUserIds),
  ]);

  // Fetch cover images
  const coverImageIds = items.map((item) => item.coverImageId).filter((id): id is number => !!id);
  const coverImages = await dbRead.image.findMany({
    where: { id: { in: coverImageIds } },
    select: imageSelect,
  });

  // Transform results
  const challenges: ChallengeListItem[] = items.map((item) => {
    const coverImage = item.coverImageId
      ? coverImages.find((img) => img.id === item.coverImageId)
      : null;

    return {
      id: item.id,
      title: item.title,
      theme: item.theme,
      invitation: item.invitation,
      startsAt: item.startsAt,
      endsAt: item.endsAt,
      status: item.status,
      source: item.source,
      prizePool: item.prizePool,
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
        id: item.judgeUserId ?? item.createdById,
        username: item.judgeUsername ?? item.creatorUsername,
        image: item.judgeImage ?? item.creatorImage,
        profilePicture: profilePictures[item.judgeUserId ?? item.createdById] ?? null,
        cosmetics: cosmetics[item.judgeUserId ?? item.createdById] ?? null,
        deletedAt: item.judgeDeletedAt ?? item.creatorDeletedAt,
      },
    };
  });

  return {
    items: challenges,
    nextCursor,
  };
}

export async function getChallengeDetail(
  id: number,
  bypassVisibility = false
): Promise<ChallengeDetail | null> {
  const challenge = await getChallengeById(id);
  if (!challenge) return null;

  // Fetch eventId (not in the shared getChallengeById helper)
  const challengeEventData = await dbRead.challenge.findUnique({
    where: { id },
    select: { eventId: true },
  });
  const eventId = challengeEventData?.eventId ?? null;

  // Visibility check: only show challenges that are visible to the public
  // unless bypassVisibility is true (for moderators)
  if (!bypassVisibility) {
    const now = new Date();
    if (challenge.visibleAt > now) {
      return null; // Not yet visible
    }
    // Hide cancelled challenges from public
    if (challenge.status === ChallengeStatus.Cancelled) {
      return null;
    }
  }

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

  // Get comment count from the challenge's thread
  const commentThread = await dbRead.thread.findUnique({
    where: { challengeId: id },
    select: { commentCount: true },
  });
  const commentCount = commentThread?.commentCount ?? 0;

  // Get creator info with profile picture and cosmetics
  const [creator] = await dbRead.$queryRaw<
    [{ id: number; username: string | null; image: string | null; deletedAt: Date | null }]
  >`
    SELECT id, username, image, "deletedAt"
    FROM "User"
    WHERE id = ${challenge.createdById}
  `;

  // Fetch profile picture and cosmetics for creator
  const [profilePictures, cosmetics] = await Promise.all([
    getProfilePicturesForUsers([challenge.createdById]),
    getCosmeticsForUsers([challenge.createdById]),
  ]);

  // Get model info for all modelVersionIds
  let models: ChallengeDetail['models'] = [];
  if (challenge.modelVersionIds.length > 0) {
    const versions = await dbRead.modelVersion.findMany({
      where: { id: { in: challenge.modelVersionIds } },
      select: {
        id: true,
        name: true,
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

  // Resolve display user: prefer judge's user over creator
  const displayUserId = judge?.userId ?? challenge.createdById;
  let displayUser: {
    id: number;
    username: string | null;
    image: string | null;
    deletedAt: Date | null;
  };
  let displayProfilePics: Awaited<ReturnType<typeof getProfilePicturesForUsers>>;
  let displayCosmetics: Awaited<ReturnType<typeof getCosmeticsForUsers>>;

  if (displayUserId !== challenge.createdById) {
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

  // Extract completion summary from metadata
  const metadata = challenge.metadata as Record<string, unknown> | null;
  const completionSummary =
    (metadata?.completionSummary as ChallengeCompletionSummary | undefined) ?? null;

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
    eventId,
    nsfwLevel: challenge.nsfwLevel,
    allowedNsfwLevel: challenge.allowedNsfwLevel,
    modelVersionIds: challenge.modelVersionIds,
    models,
    collectionId: challenge.collectionId,
    judgingPrompt: challenge.judgingPrompt,
    reviewPercentage: challenge.reviewPercentage,
    maxEntriesPerUser: challenge.maxEntriesPerUser,
    prizes: challenge.prizes,
    entryPrize: challenge.entryPrize,
    entryPrizeRequirement: challenge.entryPrizeRequirement,
    prizePool: challenge.prizePool,
    operationBudget: challenge.operationBudget,
    entryCount,
    commentCount,
    createdBy: {
      ...displayUser,
      profilePicture: displayProfilePics[displayUserId] ?? null,
      cosmetics: displayCosmetics[displayUserId] ?? null,
    },
    judge,
    winners,
    completionSummary,
  };
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
  const { id, coverImage, judgeId, eventId, ...data } = input;

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
      },
    });
    if (!challenge) throw throwNotFoundError('Challenge not found');

    // Block edits to terminal challenges
    if (
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

      // Validate endsAt > now() for Active challenges (can't set end date to the past)
      if (data.endsAt <= new Date()) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'End date must be in the future for an active challenge.',
        });
      }
    }

    // Use transaction to update both challenge and collection metadata atomically
    const updatedChallenge = await dbWrite.$transaction(async (tx) => {
      // Update the challenge
      const updated = await tx.challenge.update({
        where: { id },
        data: {
          ...data,
          coverImageId,
          judgeId: judgeId ?? null,
          eventId: eventId ?? null,
          modelVersionIds: data.modelVersionIds ?? [],
          prizes: data.prizes,
          entryPrize: data.entryPrize ? data.entryPrize : Prisma.JsonNull,
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
        },
      });
    });

    return challenge;
  }
}

export async function updateChallengeStatus(id: number, status: ChallengeStatus) {
  const challenge = await dbWrite.challenge.update({
    where: { id },
    data: { status },
  });
  return challenge;
}

export async function deleteChallenge(id: number) {
  const challenge = await dbRead.challenge.findUnique({
    where: { id },
    select: { id: true, status: true, collectionId: true },
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

  const collectionId = challenge.collectionId;

  // Delete challenge first (cascades to ChallengeWinner)
  await dbWrite.challenge.delete({ where: { id } });

  // Delete the associated collection and all its data
  if (collectionId) {
    await dbWrite.collection.delete({ where: { id: collectionId } });

    // Remove from search index
    await collectionsSearchIndex.queueUpdate([
      { id: collectionId, action: SearchIndexUpdateQueueAction.Delete },
    ]);
  }

  return { success: true };
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

  // Close the collection
  await closeChallengeCollection(challenge);
  log('Collection closed');

  // Get judged entries
  if (!challenge.collectionId) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Challenge has no collection for entries.',
    });
  }

  const judgedEntries = await getJudgedEntries(challenge.collectionId, config);
  if (!judgedEntries.length) {
    // No judged entries, just mark as completed
    await dbWrite.challenge.update({
      where: { id: challengeId },
      data: { status: ChallengeStatus.Completed },
    });
    log('No judged entries, challenge marked as completed without winners');
    return { success: true, winnersCount: 0 };
  }

  // Run LLM winner picking
  log('Sending entries for final judgment');
  const { winners, process, outcome } = await generateWinners({
    theme: challenge.theme || 'Creative Challenge',
    entries: judgedEntries.map((entry) => ({
      creator: entry.username,
      creatorId: entry.userId,
      summary: entry.summary,
      score: entry.score,
    })),
    config: judgingConfig,
  });

  // Map winners to entries
  const winningEntries = winners
    .map((winner, i) => {
      const entry = judgedEntries.find(
        (e) =>
          e.username.toLowerCase() === winner.creator.toLowerCase() || e.userId === winner.creatorId
      );
      if (!entry) return null;
      return {
        ...entry,
        position: i + 1,
        prize: challenge.prizes[i]?.buzz ?? 0,
        reason: winner.reason,
      };
    })
    .filter(isDefined);

  // Create ChallengeWinner records
  for (const entry of winningEntries) {
    await createChallengeWinner({
      challengeId,
      userId: entry.userId,
      imageId: entry.imageId,
      place: entry.position,
      buzzAwarded: entry.prize,
      pointsAwarded: challenge.prizes[entry.position - 1]?.points ?? 0,
      reason: entry.reason,
    });
  }
  log('ChallengeWinner records created');

  // Send prizes to winners
  // Note: externalTransactionId uses challengeId-userId-place pattern for idempotency
  // This ensures retries don't create duplicate payments
  await withRetries(() =>
    createBuzzTransactionMany(
      winningEntries.map((entry) => ({
        type: TransactionType.Reward,
        toAccountId: entry.userId,
        fromAccountId: 0, // central bank
        amount: entry.prize,
        description: `Challenge Winner Prize #${entry.position}: ${challenge.title}`,
        externalTransactionId: `challenge-winner-prize-${challengeId}-${entry.userId}-place-${entry.position}`,
        toAccountType: 'yellow',
      }))
    )
  );
  log('Prizes sent');

  // Notify winners
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

  // Update challenge status to Completed and store completion summary
  const existingMetadata = typeof challenge.metadata === 'object' ? challenge.metadata : {};
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

  return { success: true, winnersCount: winningEntries.length };
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

  // Validate status
  if (
    challenge.status !== ChallengeStatus.Active &&
    challenge.status !== ChallengeStatus.Scheduled
  ) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `Cannot void challenge with status "${String(
        challenge.status
      )}". Challenge must be Active or Scheduled.`,
    });
  }

  log('Voiding challenge:', challengeId);

  // Close the collection if exists
  await closeChallengeCollection(challenge);
  log('Collection closed');

  // Update challenge status to Cancelled
  await dbWrite.challenge.update({
    where: { id: challengeId },
    data: { status: ChallengeStatus.Cancelled },
  });
  log('Challenge status updated to Cancelled');

  return { success: true };
}

/**
 * Get active ChallengeJudge records for the moderator dropdown.
 */
export async function getActiveJudges() {
  return dbRead.challengeJudge.findMany({
    where: { active: true },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      userId: true,
      name: true,
      bio: true,
      reviewPrompt: true,
    },
  });
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

  // Get image details + their resources in one query
  const images = await dbRead.$queryRawUnsafe<
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

  // Collect all display user IDs (judge user or creator)
  const displayUserIds = [
    ...new Set(
      allChallenges.map((c) => (c.judgeId ? judgeUserMap.get(c.judgeId) : null) ?? c.createdById)
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
      const displayUserId = (c.judgeId ? judgeUserMap.get(c.judgeId) : null) ?? c.createdById;
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
