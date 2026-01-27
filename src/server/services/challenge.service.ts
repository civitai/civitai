import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import dayjs from '~/shared/utils/dayjs';
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
  type ChallengeListItem,
  type GetInfiniteChallengesInput,
  type GetModeratorChallengesInput,
  type UpcomingTheme,
  type UpsertChallengeInput,
} from '~/server/schema/challenge.schema';
import type { ChallengeSource } from '~/shared/utils/prisma/enums';
import {
  ChallengeStatus,
  CollectionMode,
  CollectionReadConfiguration,
  CollectionType,
  CollectionWriteConfiguration,
} from '~/shared/utils/prisma/enums';
import { createImage } from '~/server/services/image.service';
import { getCosmeticsForUsers, getProfilePicturesForUsers } from '~/server/services/user.service';
import { throwNotFoundError } from '~/server/utils/errorHandling';
import type { CollectionMetadataSchema } from '~/server/schema/collection.schema';
import { imageSelect } from '~/server/selectors/image.selector';
import {
  getChallengeConfig,
  getChallengeTypeConfig,
} from '~/server/games/daily-challenge/daily-challenge.utils';
import { generateWinners } from '~/server/games/daily-challenge/generative-content';
import { getJudgedEntries } from '~/server/jobs/daily-challenge-processing';
import { NotificationCategory } from '~/server/common/enums';
import { TransactionType } from '~/shared/constants/buzz.constants';
import { createBuzzTransactionMany } from '~/server/services/buzz.service';
import { createNotification } from '~/server/services/notification.service';
import { withRetries } from '~/utils/errorHandling';
import { createLogger } from '~/utils/logging';
import { isDefined } from '~/utils/type-guards';

// Service functions
export async function getInfiniteChallenges(input: GetInfiniteChallengesInput) {
  const { query, status, source, sort, userId, modelVersionId, includeEnded, limit, cursor } =
    input;

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
      Prisma.sql`c.status NOT IN (${ChallengeStatus.Completed}::"ChallengeStatus", ${ChallengeStatus.Cancelled}::"ChallengeStatus")`
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

  // Cursor for pagination (parameterized)
  if (cursor) {
    conditions.push(Prisma.sql`c.id < ${cursor}`);
  }

  const whereClause =
    conditions.length > 0 ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;

  // Build ORDER BY (safe - not user input)
  let orderByClause: Prisma.Sql;
  switch (sort) {
    case ChallengeSort.EndingSoon:
      orderByClause = Prisma.sql`c."endsAt" ASC, c.id DESC`;
      break;
    case ChallengeSort.MostEntries:
      orderByClause = Prisma.sql`"entryCount" DESC, c.id DESC`;
      break;
    case ChallengeSort.HighestPrize:
      orderByClause = Prisma.sql`c."prizePool" DESC, c.id DESC`;
      break;
    case ChallengeSort.Newest:
    default:
      orderByClause = Prisma.sql`c."startsAt" DESC, c.id DESC`;
      break;
  }

  // Entry count now comes from CollectionItem via the challenge's collection
  const items = await dbRead.$queryRaw<
    Array<{
      id: number;
      title: string;
      theme: string | null;
      coverImageId: number | null;
      startsAt: Date;
      endsAt: Date;
      status: ChallengeStatus;
      source: ChallengeSource;
      prizePool: number;
      entryCount: bigint;
      modelVersionIds: number[] | null;
      modelId: number | null;
      modelName: string | null;
      collectionId: number | null;
      createdById: number;
      creatorUsername: string | null;
      creatorImage: string | null;
      creatorDeletedAt: Date | null;
    }>
  >`
    SELECT
      c.id,
      c.title,
      c.theme,
      c."coverImageId",
      c."startsAt",
      c."endsAt",
      c.status,
      c.source,
      c."prizePool",
      (SELECT COUNT(*) FROM "CollectionItem" WHERE "collectionId" = c."collectionId" AND status = 'ACCEPTED') as "entryCount",
      c."modelVersionIds",
      (SELECT mv."modelId" FROM "ModelVersion" mv WHERE mv.id = c."modelVersionIds"[1] LIMIT 1) as "modelId",
      (SELECT m.name FROM "ModelVersion" mv JOIN "Model" m ON m.id = mv."modelId" WHERE mv.id = c."modelVersionIds"[1] LIMIT 1) as "modelName",
      c."collectionId",
      c."createdById",
      u.username as "creatorUsername",
      u.image as "creatorImage",
      u."deletedAt" as "creatorDeletedAt"
    FROM "Challenge" c
    JOIN "User" u ON u.id = c."createdById"
    ${whereClause}
    ORDER BY ${orderByClause}
    LIMIT ${limit + 1}
  `;

  // Check if there are more results
  let nextCursor: number | undefined;
  if (items.length > limit) {
    const nextItem = items.pop();
    nextCursor = nextItem?.id;
  }

  // Fetch profile pictures for all creators
  const creatorIds = [...new Set(items.map((item) => item.createdById))];
  const [profilePictures, cosmetics] = await Promise.all([
    getProfilePicturesForUsers(creatorIds),
    getCosmeticsForUsers(creatorIds),
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
      startsAt: item.startsAt,
      endsAt: item.endsAt,
      status: item.status,
      source: item.source,
      prizePool: item.prizePool,
      entryCount: Number(item.entryCount),
      modelVersionIds: item.modelVersionIds ?? [],
      model: item.modelId && item.modelName ? { id: item.modelId, name: item.modelName } : null,
      collectionId: item.collectionId,
      createdBy: {
        id: item.createdById,
        username: item.creatorUsername,
        image: item.creatorImage,
        profilePicture: profilePictures[item.createdById] ?? null,
        cosmetics: cosmetics[item.createdById] ?? null,
        deletedAt: item.creatorDeletedAt,
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

  // Get model info from first modelVersionId if present
  let model: { id: number; name: string } | null = null;
  if (challenge.modelVersionIds.length > 0) {
    const [modelResult] = await dbRead.$queryRaw<[{ id: number; name: string }]>`
      SELECT m.id, m.name
      FROM "ModelVersion" mv
      JOIN "Model" m ON m.id = mv."modelId"
      WHERE mv.id = ${challenge.modelVersionIds[0]}
    `;
    model = modelResult || null;
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
    winners = await getChallengeWinners(id);
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
    nsfwLevel: challenge.nsfwLevel,
    allowedNsfwLevel: challenge.allowedNsfwLevel,
    modelVersionIds: challenge.modelVersionIds,
    model,
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
    createdBy: {
      ...creator,
      profilePicture: profilePictures[challenge.createdById] ?? null,
      cosmetics: cosmetics[challenge.createdById] ?? null,
    },
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
  const { id, coverImage, ...data } = input;

  // Handle cover image - create Image record if needed (like Article does)
  let coverImageId: number | null = null;
  if (coverImage) {
    if (coverImage.id) {
      // Use existing image ID
      coverImageId = coverImage.id;
    } else if (coverImage.url) {
      // Create new Image record from uploaded file
      const result = await createImage({ ...coverImage, userId });
      coverImageId = result.id;
    }
  }

  if (id) {
    // Update existing challenge
    const challenge = await dbRead.challenge.findUnique({
      where: { id },
      select: { collectionId: true, metadata: true },
    });
    if (!challenge) throw throwNotFoundError('Challenge not found');

    // Use transaction to update both challenge and collection metadata atomically
    const updatedChallenge = await dbWrite.$transaction(async (tx) => {
      // Update the challenge
      const updated = await tx.challenge.update({
        where: { id },
        data: {
          ...data,
          coverImageId,
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
          coverImageId,
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
  // Get the challenge to find its collection
  const challenge = await dbRead.challenge.findUnique({
    where: { id },
    select: { collectionId: true },
  });

  if (!challenge) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Challenge not found',
    });
  }

  // Check if challenge collection has any entries
  if (challenge.collectionId) {
    const entryCount = await dbRead.collectionItem.count({
      where: { collectionId: challenge.collectionId },
    });

    if (entryCount > 0) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: `Cannot delete challenge with ${entryCount} entries. Cancel the challenge instead.`,
      });
    }
  }

  // Delete the challenge (collection deletion would need separate handling based on business rules)
  await dbWrite.challenge.delete({
    where: { id },
  });

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
      message: `Cannot end challenge with status "${challenge.status}". Challenge must be Active.`,
    });
  }

  // Get challenge config for judging
  const config = await getChallengeConfig();
  const challengeTypeConfig = await getChallengeTypeConfig(config.challengeType);

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
    config: challengeTypeConfig,
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
  const dateStr = dayjs().format('YYYY-MM-DD-HHmm');
  await withRetries(() =>
    createBuzzTransactionMany(
      winningEntries.map((entry, i) => ({
        type: TransactionType.Reward,
        toAccountId: entry.userId,
        fromAccountId: 0, // central bank
        amount: entry.prize,
        description: `Challenge Winner Prize ${i + 1}: ${challenge.title}`,
        externalTransactionId: `challenge-winner-prize-${challengeId}-${dateStr}-${i + 1}`,
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
        await withRetries(() =>
          createBuzzTransactionMany(
            entryPrizeUsers.map(({ userId }) => ({
              type: TransactionType.Reward,
              toAccountId: userId,
              fromAccountId: 0, // central bank
              amount: challenge.entryPrize!.buzz,
              description: `Challenge Entry Prize: ${challenge.title}`,
              externalTransactionId: `challenge-entry-prize-${challengeId}-${dateStr}-${userId}`,
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
      message: `Cannot void challenge with status "${challenge.status}". Challenge must be Active or Scheduled.`,
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
