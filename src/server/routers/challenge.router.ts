import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  getChallengeById,
  getChallengeWinners,
} from '~/server/games/daily-challenge/challenge-helpers';
import {
  ChallengeSort,
  deleteChallengeSchema,
  getChallengeWinnersSchema,
  getInfiniteChallengesSchema,
  getModeratorChallengesSchema,
  updateChallengeStatusSchema,
  upsertChallengeSchema,
  type GetInfiniteChallengesInput,
  type Prize,
} from '~/server/schema/challenge.schema';
import { getByIdSchema } from '~/server/schema/base.schema';
import { moderatorProcedure, publicProcedure, router } from '~/server/trpc';
import { ChallengeSource, ChallengeStatus, CollectionMode } from '~/shared/utils/prisma/enums';

// Types for query results
export type ChallengeListItem = {
  id: number;
  title: string;
  theme: string | null;
  coverUrl: string | null;
  startsAt: Date;
  endsAt: Date;
  status: ChallengeStatus;
  source: ChallengeSource;
  prizePool: number;
  entryCount: number;
  modelName: string | null; // Derived from first modelVersionId
  createdBy: {
    id: number;
    username: string | null;
    image: string | null;
  };
};

export type ChallengeDetail = {
  id: number;
  title: string;
  description: string | null;
  theme: string | null;
  invitation: string | null;
  coverUrl: string | null;
  startsAt: Date;
  endsAt: Date;
  visibleAt: Date;
  status: ChallengeStatus;
  source: ChallengeSource;
  nsfwLevel: number;
  allowedNsfwLevel: number; // Bitwise NSFW levels allowed for entries
  modelVersionIds: number[]; // Array of allowed model version IDs
  model: {
    id: number;
    name: string;
  } | null; // Derived from first modelVersionId
  collectionId: number | null; // Collection for entries (null if not yet created)
  judgingPrompt: string | null;
  reviewPercentage: number;
  maxEntriesPerUser: number;
  prizes: Prize[];
  entryPrize: Prize | null;
  entryPrizeRequirement: number; // Min entries for participation prize
  prizePool: number;
  entryCount: number;
  createdBy: {
    id: number;
    username: string | null;
    image: string | null;
  };
  winners: Array<{
    place: number;
    userId: number;
    username: string;
    imageId: number;
    imageUrl: string;
    buzzAwarded: number;
    reason: string | null;
  }>;
};

// Service functions
async function getInfiniteChallenges(input: GetInfiniteChallengesInput) {
  const { query, status, source, sort, userId, modelVersionId, includeEnded, limit, cursor } = input;

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
    conditions.push(
      Prisma.sql`(c.title ILIKE ${searchPattern} OR c.theme ILIKE ${searchPattern})`
    );
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
    conditions.length > 0
      ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`
      : Prisma.empty;

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
      coverUrl: string | null;
      startsAt: Date;
      endsAt: Date;
      status: ChallengeStatus;
      source: ChallengeSource;
      prizePool: number;
      entryCount: bigint;
      modelName: string | null;
      createdById: number;
      creatorUsername: string | null;
      creatorImage: string | null;
    }>
  >`
    SELECT
      c.id,
      c.title,
      c.theme,
      (SELECT url FROM "Image" WHERE id = c."coverImageId") as "coverUrl",
      c."startsAt",
      c."endsAt",
      c.status,
      c.source,
      c."prizePool",
      (SELECT COUNT(*) FROM "CollectionItem" WHERE "collectionId" = c."collectionId") as "entryCount",
      (SELECT m.name FROM "ModelVersion" mv JOIN "Model" m ON m.id = mv."modelId" WHERE mv.id = c."modelVersionIds"[1] LIMIT 1) as "modelName",
      c."createdById",
      u.username as "creatorUsername",
      u.image as "creatorImage"
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

  // Transform results
  const challenges: ChallengeListItem[] = items.map((item) => ({
    id: item.id,
    title: item.title,
    theme: item.theme,
    coverUrl: item.coverUrl,
    startsAt: item.startsAt,
    endsAt: item.endsAt,
    status: item.status,
    source: item.source,
    prizePool: item.prizePool,
    entryCount: Number(item.entryCount),
    modelName: item.modelName,
    createdBy: {
      id: item.createdById,
      username: item.creatorUsername,
      image: item.creatorImage,
    },
  }));

  return {
    items: challenges,
    nextCursor,
  };
}

async function getChallengeDetail(
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
    // Hide drafts and cancelled challenges from public
    if (
      challenge.status === ChallengeStatus.Draft ||
      challenge.status === ChallengeStatus.Cancelled
    ) {
      return null;
    }
  }

  // Get entry count from the challenge's collection
  let entryCount = 0;
  if (challenge.collectionId) {
    const [countResult] = await dbRead.$queryRaw<[{ count: bigint }]>`
      SELECT COUNT(*) as count
      FROM "CollectionItem"
      WHERE "collectionId" = ${challenge.collectionId}
    `;
    entryCount = Number(countResult.count);
  }

  // Get creator info
  const [creator] = await dbRead.$queryRaw<
    [{ id: number; username: string | null; image: string | null }]
  >`
    SELECT id, username, image
    FROM "User"
    WHERE id = ${challenge.createdById}
  `;

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

  // Get winners if challenge is completed
  let winners: ChallengeDetail['winners'] = [];
  if (challenge.status === ChallengeStatus.Completed) {
    winners = await getChallengeWinners(id);
  }

  return {
    id: challenge.id,
    title: challenge.title,
    description: challenge.description,
    theme: challenge.theme,
    invitation: challenge.invitation,
    coverUrl: challenge.coverUrl,
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
    entryCount,
    createdBy: creator,
    winners,
  };
}

// Router definition
export const challengeRouter = router({
  // Get paginated list of challenges
  getInfinite: publicProcedure
    .input(getInfiniteChallengesSchema)
    .query(({ input }) => getInfiniteChallenges(input)),

  // Get single challenge by ID
  getById: publicProcedure.input(getByIdSchema).query(({ input }) => getChallengeDetail(input.id)),

  // Get upcoming challenge themes for preview widget
  getUpcomingThemes: publicProcedure
    .input(z.object({ count: z.number().min(1).max(10).default(3) }))
    .query(async ({ input }) => {
      const { count } = input;

      // Get upcoming visible challenges
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
    }),

  // Get challenge winners
  getWinners: publicProcedure.input(getChallengeWinnersSchema).query(async ({ input }) => {
    return getChallengeWinners(input.challengeId);
  }),

  // Moderator: Get all challenges (including drafts)
  getModeratorList: moderatorProcedure
    .input(getModeratorChallengesSchema)
    .query(async ({ input }) => {
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
        conditions.push(
          Prisma.sql`(c.title ILIKE ${searchPattern} OR c.theme ILIKE ${searchPattern})`
        );
      }

      if (cursor) {
        conditions.push(Prisma.sql`c.id < ${cursor}`);
      }

      const whereClause =
        conditions.length > 0
          ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`
          : Prisma.empty;

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
          (SELECT COUNT(*) FROM "CollectionItem" WHERE "collectionId" = c."collectionId") as "entryCount",
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
    }),

  // Moderator: Create or update a challenge
  upsert: moderatorProcedure.input(upsertChallengeSchema).mutation(async ({ input, ctx }) => {
    const { id, ...data } = input;

    if (id) {
      // Update existing challenge
      const challenge = await dbWrite.challenge.update({
        where: { id },
        data: {
          ...data,
          modelVersionIds: data.modelVersionIds ?? [],
          prizes: data.prizes as Prisma.InputJsonValue,
          entryPrize: data.entryPrize as Prisma.InputJsonValue | undefined,
        },
      });
      return challenge;
    } else {
      // Create new challenge with a Contest Collection for entries
      // First create the collection with proper Contest Mode settings
      const collection = await dbWrite.collection.create({
        data: {
          name: `Challenge: ${data.title}`,
          description: data.description || `Entries for challenge: ${data.title}`,
          userId: ctx.user.id,
          mode: CollectionMode.Contest,
          metadata: {
            maxItemsPerUser: data.maxEntriesPerUser ?? 20,
            submissionStartDate: data.startsAt,
            submissionEndDate: data.endsAt,
            forcedBrowsingLevel: data.allowedNsfwLevel ?? 1, // Enforce NSFW restrictions
          },
        },
      });

      // Then create the challenge linked to the collection
      const challenge = await dbWrite.challenge.create({
        data: {
          ...data,
          collectionId: collection.id,
          createdById: ctx.user.id,
          modelVersionIds: data.modelVersionIds ?? [],
          allowedNsfwLevel: data.allowedNsfwLevel ?? 1,
          entryPrizeRequirement: data.entryPrizeRequirement ?? 10,
          prizes: data.prizes as Prisma.InputJsonValue,
          entryPrize: data.entryPrize as Prisma.InputJsonValue | undefined,
        },
      });
      return challenge;
    }
  }),

  // Moderator: Update challenge status
  updateStatus: moderatorProcedure
    .input(updateChallengeStatusSchema)
    .mutation(async ({ input }) => {
      const { id, status } = input;

      const challenge = await dbWrite.challenge.update({
        where: { id },
        data: { status },
      });

      return challenge;
    }),

  // Moderator: Delete a challenge
  delete: moderatorProcedure.input(deleteChallengeSchema).mutation(async ({ input }) => {
    const { id } = input;

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
  }),
});

// Types are exported via their definitions above
