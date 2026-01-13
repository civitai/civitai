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
  modelId: number | null;
  modelName: string | null;
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
  modelId: number | null;
  modelVersionId: number | null;
  model: {
    id: number;
    name: string;
  } | null;
  collectionId: number; // Required - entries are stored here
  judgingPrompt: string | null;
  reviewPercentage: number;
  maxEntriesPerUser: number;
  prizes: Prize[];
  entryPrize: Prize | null;
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
  const { query, status, source, sort, userId, modelId, includeEnded, limit, cursor } = input;

  // Build WHERE conditions
  const conditions: string[] = [];

  // Only show visible challenges
  conditions.push(`c."visibleAt" <= now()`);

  // Status filter
  if (status && status.length > 0) {
    const statusList = status.map((s) => `'${s}'`).join(', ');
    conditions.push(`c.status IN (${statusList})`);
  } else if (!includeEnded) {
    // Default: exclude completed/cancelled unless requested
    conditions.push(
      `c.status NOT IN ('${ChallengeStatus.Completed}', '${ChallengeStatus.Cancelled}')`
    );
  }

  // Source filter
  if (source && source.length > 0) {
    const sourceList = source.map((s) => `'${s}'`).join(', ');
    conditions.push(`c.source IN (${sourceList})`);
  }

  // Text search
  if (query) {
    conditions.push(`(c.title ILIKE '%${query}%' OR c.theme ILIKE '%${query}%')`);
  }

  // Creator filter
  if (userId) {
    conditions.push(`c."createdById" = ${userId}`);
  }

  // Model filter
  if (modelId) {
    conditions.push(`c."modelId" = ${modelId}`);
  }

  // Cursor for pagination
  if (cursor) {
    conditions.push(`c.id < ${cursor}`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Build ORDER BY
  let orderBy: string;
  switch (sort) {
    case ChallengeSort.EndingSoon:
      orderBy = `c."endsAt" ASC, c.id DESC`;
      break;
    case ChallengeSort.MostEntries:
      orderBy = `entry_count DESC, c.id DESC`;
      break;
    case ChallengeSort.HighestPrize:
      orderBy = `c."prizePool" DESC, c.id DESC`;
      break;
    case ChallengeSort.Newest:
    default:
      orderBy = `c."startsAt" DESC, c.id DESC`;
      break;
  }

  // Entry count now comes from CollectionItem via the challenge's collection
  const items = await dbRead.$queryRawUnsafe<
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
      modelId: number | null;
      modelName: string | null;
      createdById: number;
      creatorUsername: string | null;
      creatorImage: string | null;
    }>
  >(`
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
      c."modelId",
      m.name as "modelName",
      c."createdById",
      u.username as "creatorUsername",
      u.image as "creatorImage"
    FROM "Challenge" c
    LEFT JOIN "Model" m ON m.id = c."modelId"
    JOIN "User" u ON u.id = c."createdById"
    ${whereClause}
    ORDER BY ${orderBy}
    LIMIT ${limit + 1}
  `);

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
    modelId: item.modelId,
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

async function getChallengeDetail(id: number): Promise<ChallengeDetail | null> {
  const challenge = await getChallengeById(id);
  if (!challenge) return null;

  // Get entry count from the challenge's collection
  const [countResult] = await dbRead.$queryRaw<[{ count: bigint }]>`
    SELECT COUNT(*) as count
    FROM "CollectionItem"
    WHERE "collectionId" = ${challenge.collectionId}
  `;
  const entryCount = Number(countResult.count);

  // Get creator info
  const [creator] = await dbRead.$queryRaw<
    [{ id: number; username: string | null; image: string | null }]
  >`
    SELECT id, username, image
    FROM "User"
    WHERE id = ${challenge.createdById}
  `;

  // Get model info if present
  let model: { id: number; name: string } | null = null;
  if (challenge.modelId) {
    const [modelResult] = await dbRead.$queryRaw<[{ id: number; name: string }]>`
      SELECT id, name
      FROM "Model"
      WHERE id = ${challenge.modelId}
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
    modelId: challenge.modelId,
    modelVersionId: challenge.modelVersionIds[0] || null,
    model,
    collectionId: challenge.collectionId,
    judgingPrompt: challenge.judgingPrompt,
    reviewPercentage: challenge.reviewPercentage,
    maxEntriesPerUser: challenge.maxEntriesPerUser,
    prizes: challenge.prizes,
    entryPrize: challenge.entryPrize,
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
          m.name as "modelName",
          u.username as "modelCreator"
        FROM "Challenge" c
        LEFT JOIN "Model" m ON m.id = c."modelId"
        LEFT JOIN "User" u ON u.id = m."userId"
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

      const conditions: string[] = [];

      if (status && status.length > 0) {
        const statusList = status.map((s) => `'${s}'`).join(', ');
        conditions.push(`c.status IN (${statusList})`);
      }

      if (source && source.length > 0) {
        const sourceList = source.map((s) => `'${s}'`).join(', ');
        conditions.push(`c.source IN (${sourceList})`);
      }

      if (query) {
        conditions.push(`(c.title ILIKE '%${query}%' OR c.theme ILIKE '%${query}%')`);
      }

      if (cursor) {
        conditions.push(`c.id < ${cursor}`);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // Entry count now from CollectionItem
      const items = await dbRead.$queryRawUnsafe<
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
      >(`
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
      `);

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
          prizes: data.prizes as Prisma.InputJsonValue,
          entryPrize: data.entryPrize as Prisma.InputJsonValue | undefined,
        },
      });
      return challenge;
    } else {
      // Create new challenge with a Contest Collection for entries
      // First create the collection
      const collection = await dbWrite.collection.create({
        data: {
          name: `Challenge: ${data.title}`,
          description: data.description || `Entries for challenge: ${data.title}`,
          userId: ctx.user.id,
          mode: CollectionMode.Contest,
          metadata: {
            maxItemsPerUser: data.maxEntriesPerUser,
            submissionStartDate: data.startsAt,
            submissionEndDate: data.endsAt,
          },
        },
      });

      // Then create the challenge linked to the collection
      const challenge = await dbWrite.challenge.create({
        data: {
          ...data,
          collectionId: collection.id,
          createdById: ctx.user.id,
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
    const entryCount = await dbRead.collectionItem.count({
      where: { collectionId: challenge.collectionId },
    });

    if (entryCount > 0) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: `Cannot delete challenge with ${entryCount} entries. Cancel the challenge instead.`,
      });
    }

    // Delete the challenge (collection deletion would need separate handling based on business rules)
    await dbWrite.challenge.delete({
      where: { id },
    });

    return { success: true };
  }),
});

// Types are exported via their definitions above
