import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { ChallengeSource, ChallengeStatus, CollectionMode } from '~/shared/utils/prisma/enums';
import type { Prize, Score } from './daily-challenge.utils';

// =============================================================================
// Challenge Table Helpers (New System)
// =============================================================================
// Note: Challenge entries are stored as CollectionItems in the challenge's collection.
// Use collection service methods for entry management.

export type ChallengeDetails = {
  id: number;
  startsAt: Date;
  endsAt: Date;
  visibleAt: Date;
  title: string;
  description: string | null;
  theme: string | null;
  invitation: string | null;
  coverUrl: string | null;
  nsfwLevel: number;
  allowedNsfwLevel: number; // Bitwise NSFW levels allowed for entries
  modelVersionIds: number[]; // Array of allowed model version IDs
  collectionId: number | null; // Collection for entries (null if not yet created)
  judgingPrompt: string | null;
  reviewPercentage: number;
  maxReviews: number | null;
  maxEntriesPerUser: number;
  prizes: Prize[];
  entryPrize: Prize | null;
  entryPrizeRequirement: number; // Min entries for participation prize
  prizePool: number;
  operationBudget: number;
  operationSpent: number;
  createdById: number;
  source: ChallengeSource;
  status: ChallengeStatus;
  metadata: Record<string, unknown> | null;
};

type ChallengeDbRow = Omit<
  ChallengeDetails,
  'modelVersionIds' | 'coverUrl' | 'prizes' | 'entryPrize'
> & {
  modelVersionIds: number[] | null; // Can be null from DB
  coverUrl: string | null;
  prizes: Prize[] | string; // JSON comes as string or parsed
  entryPrize: Prize | string | null;
};

export async function getChallengeById(challengeId: number): Promise<ChallengeDetails | null> {
  // Note: Using dbRead directly since 'challenge' isn't in LaggingType yet
  const rows = await dbRead.$queryRaw<ChallengeDbRow[]>`
    SELECT
      c.id,
      c."startsAt",
      c."endsAt",
      c."visibleAt",
      c.title,
      c.description,
      c.theme,
      c.invitation,
      (SELECT url FROM "Image" WHERE id = c."coverImageId") as "coverUrl",
      c."nsfwLevel",
      c."allowedNsfwLevel",
      c."modelVersionIds",
      c."collectionId",
      c."judgingPrompt",
      c."reviewPercentage",
      c."maxReviews",
      c."maxEntriesPerUser",
      c.prizes,
      c."entryPrize",
      c."entryPrizeRequirement",
      c."prizePool",
      c."operationBudget",
      c."operationSpent",
      c."createdById",
      c.source,
      c.status,
      c.metadata
    FROM "Challenge" c
    WHERE c.id = ${challengeId}
  `;

  const result = rows[0];
  if (!result) return null;

  return {
    ...result,
    modelVersionIds: result.modelVersionIds ?? [],
    prizes: typeof result.prizes === 'string' ? JSON.parse(result.prizes) : result.prizes,
    entryPrize:
      typeof result.entryPrize === 'string' ? JSON.parse(result.entryPrize) : result.entryPrize,
  };
}

export async function getActiveChallengeFromDb(): Promise<ChallengeDetails | null> {
  const [row] = await dbRead.$queryRaw<{ id: number }[]>`
    SELECT id
    FROM "Challenge"
    WHERE status = ${ChallengeStatus.Active}::"ChallengeStatus"
    ORDER BY "startsAt" DESC
    LIMIT 1
  `;
  if (!row) return null;
  return getChallengeById(row.id);
}

export async function getScheduledChallengeFromDb(): Promise<ChallengeDetails | null> {
  const [row] = await dbRead.$queryRaw<{ id: number }[]>`
    SELECT id
    FROM "Challenge"
    WHERE status = ${ChallengeStatus.Scheduled}::"ChallengeStatus"
    ORDER BY "startsAt" ASC
    LIMIT 1
  `;
  if (!row) return null;
  return getChallengeById(row.id);
}

export async function getUpcomingChallengesFromDb(limit = 30): Promise<ChallengeDetails[]> {
  const rows = await dbRead.$queryRaw<{ id: number }[]>`
    SELECT id
    FROM "Challenge"
    WHERE status IN (${ChallengeStatus.Draft}::"ChallengeStatus", ${ChallengeStatus.Scheduled}::"ChallengeStatus")
    AND "startsAt" > now()
    ORDER BY "startsAt" ASC
    LIMIT ${limit}
  `;
  const challenges = await Promise.all(rows.map((row) => getChallengeById(row.id)));
  return challenges.filter((c): c is ChallengeDetails => c !== null);
}

export type CreateChallengeInput = {
  startsAt: Date;
  endsAt: Date;
  visibleAt: Date;
  title: string;
  description?: string;
  theme?: string;
  invitation?: string;
  coverImageId?: number;
  nsfwLevel?: number;
  allowedNsfwLevel?: number; // Bitwise NSFW levels for entries (default 1 = PG only)
  modelVersionIds?: number[]; // Array of allowed model version IDs
  judgingPrompt?: string;
  reviewPercentage?: number;
  maxReviews?: number;
  collectionId?: number; // Optional - auto-created if not provided
  maxEntriesPerUser?: number;
  prizes: Prize[];
  entryPrize?: Prize;
  entryPrizeRequirement?: number; // Min entries for participation prize
  prizePool?: number;
  operationBudget?: number;
  createdById: number;
  source?: ChallengeSource;
  status?: ChallengeStatus;
  metadata?: Record<string, unknown>;
};

/**
 * Creates a Contest Collection for a challenge.
 * Call this before createChallengeRecord to get the collectionId.
 */
export async function createChallengeCollection(input: {
  title: string;
  description?: string;
  userId: number;
  startsAt: Date;
  endsAt: Date;
  maxEntriesPerUser: number;
  allowedNsfwLevel?: number; // Bitwise NSFW levels (default 1 = PG only)
}): Promise<number> {
  const collection = await dbWrite.collection.create({
    data: {
      name: `Challenge: ${input.title}`,
      description: input.description || `Entries for challenge: ${input.title}`,
      userId: input.userId,
      mode: CollectionMode.Contest,
      metadata: {
        maxItemsPerUser: input.maxEntriesPerUser,
        submissionStartDate: input.startsAt,
        submissionEndDate: input.endsAt,
        forcedBrowsingLevel: input.allowedNsfwLevel ?? 1, // Enforce NSFW restrictions
      },
    },
    select: { id: true },
  });
  return collection.id;
}

export async function createChallengeRecord(input: CreateChallengeInput): Promise<number> {
  const challenge = await dbWrite.challenge.create({
    data: {
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      visibleAt: input.visibleAt,
      title: input.title,
      description: input.description,
      theme: input.theme,
      invitation: input.invitation,
      coverImageId: input.coverImageId,
      nsfwLevel: input.nsfwLevel ?? 1,
      allowedNsfwLevel: input.allowedNsfwLevel ?? 1,
      modelVersionIds: input.modelVersionIds ?? [],
      judgingPrompt: input.judgingPrompt,
      reviewPercentage: input.reviewPercentage ?? 100,
      maxReviews: input.maxReviews,
      collectionId: input.collectionId, // Optional - can be null
      maxEntriesPerUser: input.maxEntriesPerUser ?? 20,
      prizes: input.prizes as unknown as Prisma.InputJsonValue,
      entryPrize: input.entryPrize as unknown as Prisma.InputJsonValue,
      entryPrizeRequirement: input.entryPrizeRequirement ?? 10,
      prizePool: input.prizePool ?? 0,
      operationBudget: input.operationBudget ?? 0,
      createdById: input.createdById,
      source: input.source ?? ChallengeSource.System,
      status: input.status ?? ChallengeStatus.Draft,
      metadata: input.metadata as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  return challenge.id;
}

export async function updateChallengeStatus(
  challengeId: number,
  status: ChallengeStatus
): Promise<void> {
  await dbWrite.challenge.update({
    where: { id: challengeId },
    data: { status },
  });
}

export async function setChallengeActive(challengeId: number): Promise<void> {
  await updateChallengeStatus(challengeId, ChallengeStatus.Active);
  // Cache the active challenge in Redis for quick access
  const challenge = await getChallengeById(challengeId);
  await redis.packed.set(REDIS_KEYS.DAILY_CHALLENGE.DETAILS, challenge);
}

// =============================================================================
// Winner Helpers
// =============================================================================

export type CreateWinnerInput = {
  challengeId: number;
  userId: number;
  imageId: number;
  place: number;
  buzzAwarded: number;
  pointsAwarded: number;
  reason?: string;
};

export async function createChallengeWinner(input: CreateWinnerInput): Promise<number> {
  const winner = await dbWrite.challengeWinner.create({
    data: {
      challengeId: input.challengeId,
      userId: input.userId,
      imageId: input.imageId,
      place: input.place,
      buzzAwarded: input.buzzAwarded,
      pointsAwarded: input.pointsAwarded,
      reason: input.reason,
    },
    select: { id: true },
  });
  return winner.id;
}

export async function getChallengeWinners(challengeId: number): Promise<
  Array<{
    id: number;
    userId: number;
    username: string;
    imageId: number;
    imageUrl: string;
    place: number;
    buzzAwarded: number;
    pointsAwarded: number;
    reason: string | null;
  }>
> {
  return dbRead.$queryRaw`
    SELECT
      cw.id,
      cw."userId",
      u.username,
      cw."imageId",
      i.url as "imageUrl",
      cw.place,
      cw."buzzAwarded",
      cw."pointsAwarded",
      cw.reason
    FROM "ChallengeWinner" cw
    JOIN "User" u ON u.id = cw."userId"
    JOIN "Image" i ON i.id = cw."imageId"
    WHERE cw."challengeId" = ${challengeId}
    ORDER BY cw.place ASC
  `;
}

// =============================================================================
// Collection Helpers
// =============================================================================

export async function closeChallengeCollection(challenge: { collectionId: number | null }) {
  if (!challenge.collectionId) return; // No collection to close

  await dbWrite.$executeRaw`
    UPDATE "Collection"
    SET write = 'Private'::"CollectionWriteConfiguration"
    WHERE id = ${challenge.collectionId};
  `;

  await dbWrite.$executeRaw`
    DELETE FROM "CollectionContributor"
    WHERE "collectionId" = ${challenge.collectionId}
  `;
}

/**
 * Creates a challenge with an auto-created collection.
 * This is the preferred way to create challenges.
 */
export async function createChallengeWithCollection(
  input: Omit<CreateChallengeInput, 'collectionId'>
): Promise<{ challengeId: number; collectionId: number }> {
  // Create the collection first
  const collectionId = await createChallengeCollection({
    title: input.title,
    description: input.description,
    userId: input.createdById,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    maxEntriesPerUser: input.maxEntriesPerUser ?? 20,
    allowedNsfwLevel: input.allowedNsfwLevel,
  });

  // Create the challenge with the collection
  const challengeId = await createChallengeRecord({
    ...input,
    collectionId,
  });

  return { challengeId, collectionId };
}

/**
 * Get entry count for a challenge from its collection
 */
export async function getChallengeEntryCount(collectionId: number | null): Promise<number> {
  if (!collectionId) return 0;

  const [result] = await dbRead.$queryRaw<[{ count: bigint }]>`
    SELECT COUNT(*) as count
    FROM "CollectionItem"
    WHERE "collectionId" = ${collectionId}
  `;
  return Number(result.count);
}

// =============================================================================
// Utility Helpers
// =============================================================================

export async function updateChallengeField<K extends keyof CreateChallengeInput>(
  challengeId: number,
  field: K,
  value: CreateChallengeInput[K]
): Promise<void> {
  await dbWrite.challenge.update({
    where: { id: challengeId },
    data: { [field]: value },
  });
}

export async function incrementOperationSpent(challengeId: number, amount: number): Promise<void> {
  // Use atomic increment to avoid race conditions
  await dbWrite.$executeRaw`
    UPDATE "Challenge"
    SET "operationSpent" = "operationSpent" + ${amount}
    WHERE id = ${challengeId}
  `;
}
