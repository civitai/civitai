import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { removeTags } from '~/utils/string-helpers';
import type { ChallengeBuzzType } from '~/server/games/daily-challenge/challenge-currency';
import {
  challengeJudgingCategoriesSchema,
  type ChallengeJudgingCategory,
} from '~/server/schema/challenge.schema';
import {
  getIsSafeBrowsingLevel,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { CHALLENGE_JOB_BATCH_SIZE } from '~/shared/constants/challenge.constants';
import type { PoolTrigger } from '~/shared/utils/prisma/enums';
import {
  ChallengeReviewCostType,
  ChallengeIngestionStatus,
  ChallengeSource,
  ChallengeStatus,
  CollectionMode,
  PrizeMode,
} from '~/shared/utils/prisma/enums';
import {
  deriveChallengeNsfwLevel,
  parseJudgeScore,
  type JudgeScore,
  type Prize,
} from './daily-challenge.utils';

// Re-export pure pool computation (lives in separate file to avoid pulling
// DB/Redis into client bundles)
export { computeDynamicPool, distributePrizes } from './challenge-pool';

// Author-supplied text sent to the text-moderation scan. `invitation` is intentionally excluded —
// it isn't surfaced on user-created challenges. Description is RTE HTML, so tags are stripped.
export function buildChallengeModerationText(challenge: {
  title: string | null;
  theme: string | null;
  description: string | null;
}) {
  return [challenge.title, challenge.theme, challenge.description ? removeTags(challenge.description) : null]
    .filter(Boolean)
    .join('\n');
}

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
  coverImageId: number | null;
  coverUrl: string | null;
  coverImageHash: string | null;
  coverImageWidth: number | null;
  coverImageHeight: number | null;
  nsfwLevel: number;
  allowedNsfwLevel: number; // Bitwise NSFW levels allowed for entries
  modelVersionIds: number[]; // Array of allowed model version IDs
  collectionId: number | null; // Collection for entries (null if not yet created)
  judgeId: number | null; // ChallengeJudge ID (null if no judge assigned)
  judgingPrompt: string | null;
  reviewPercentage: number;
  maxReviews: number | null;
  maxEntriesPerUser: number;
  prizes: Prize[];
  entryPrize: Prize | null;
  entryPrizeRequirement: number; // Min entries for participation prize
  prizePool: number;
  prizeMode: PrizeMode;
  basePrizePool: number;
  buzzPerAction: number;
  poolTrigger: PoolTrigger | null;
  maxPrizePool: number | null;
  prizeDistribution: number[] | null;
  operationBudget: number;
  operationSpent: number;
  reviewCostType: ChallengeReviewCostType;
  reviewCost: number;
  createdById: number | null; // nullable: creator account deletion sets this NULL (FK ON DELETE SET NULL)
  source: ChallengeSource;
  buzzType: ChallengeBuzzType;
  status: ChallengeStatus;
  ingestion: ChallengeIngestionStatus;
  scannedAt: Date | null;
  entryFee: number;
  maxParticipants: number | null;
  judgingCategories: unknown; // raw JSON; parse with challengeJudgingCategoriesSchema
  eventId: number | null;
  metadata: Record<string, unknown> | null;
};

type ChallengeDbRow = Omit<
  ChallengeDetails,
  | 'modelVersionIds'
  | 'coverImageId'
  | 'coverUrl'
  | 'coverImageHash'
  | 'coverImageWidth'
  | 'coverImageHeight'
  | 'prizes'
  | 'entryPrize'
  | 'prizeDistribution'
  | 'judgeId'
> & {
  modelVersionIds: number[] | null; // Can be null from DB
  coverImageId: number | null;
  coverUrl: string | null;
  coverImageHash: string | null;
  coverImageWidth: number | null;
  coverImageHeight: number | null;
  prizes: Prize[] | string; // JSON comes as string or parsed
  entryPrize: Prize | string | null;
  prizeDistribution: number[] | string | null; // JSON comes as string or parsed; null for Fixed mode
  judgeId: number | null;
};

// Shared column list for both the single-row and batched challenge lookups — keeps the two
// queries (and their cover-image subquery hydration) from drifting apart.
const challengeSelectFragment = Prisma.sql`
  c.id,
  c."startsAt",
  c."endsAt",
  c."visibleAt",
  c.title,
  c.description,
  c.theme,
  c.invitation,
  c."coverImageId",
  (SELECT url FROM "Image" WHERE id = c."coverImageId") as "coverUrl",
  (SELECT hash FROM "Image" WHERE id = c."coverImageId") as "coverImageHash",
  (SELECT width FROM "Image" WHERE id = c."coverImageId") as "coverImageWidth",
  (SELECT height FROM "Image" WHERE id = c."coverImageId") as "coverImageHeight",
  c."nsfwLevel",
  c."allowedNsfwLevel",
  c."modelVersionIds",
  c."collectionId",
  c."judgeId",
  c."judgingPrompt",
  c."reviewPercentage",
  c."maxReviews",
  c."maxEntriesPerUser",
  c.prizes,
  c."entryPrize",
  c."entryPrizeRequirement",
  c."prizePool",
  c."prizeMode",
  c."basePrizePool",
  c."buzzPerAction",
  c."poolTrigger",
  c."maxPrizePool",
  c."prizeDistribution",
  c."operationBudget",
  c."operationSpent",
  c."reviewCostType",
  c."reviewCost",
  c."createdById",
  c.source,
  c."buzzType",
  c.status,
  c."ingestion",
  c."scannedAt",
  c."entryFee",
  c."maxParticipants",
  c."judgingCategories",
  c."eventId",
  c.metadata
`;

function hydrateChallengeRow(result: ChallengeDbRow): ChallengeDetails {
  return {
    ...result,
    // $queryRaw returns the TEXT column as an arbitrary string; narrow to the union (app only ever
    // writes 'green'/'yellow', default 'yellow') so the typed contract holds downstream.
    buzzType: result.buzzType === 'green' ? 'green' : 'yellow',
    modelVersionIds: result.modelVersionIds ?? [],
    prizes: typeof result.prizes === 'string' ? JSON.parse(result.prizes) : result.prizes,
    entryPrize:
      typeof result.entryPrize === 'string' ? JSON.parse(result.entryPrize) : result.entryPrize,
    prizeDistribution:
      result.prizeDistribution == null
        ? null
        : typeof result.prizeDistribution === 'string'
        ? JSON.parse(result.prizeDistribution)
        : result.prizeDistribution,
  };
}

/**
 * Batched version of `getChallengeById` — fetches N challenges (incl. cover-image hydration)
 * in a single set-based query instead of N correlated round-trips. Order is not guaranteed;
 * callers should map results by id. Returns `[]` immediately (no query) for an empty input.
 */
export async function getChallengesByIds(challengeIds: number[]): Promise<ChallengeDetails[]> {
  if (challengeIds.length === 0) return [];

  // Note: Using dbRead directly since 'challenge' isn't in LaggingType yet
  const rows = await dbRead.$queryRaw<ChallengeDbRow[]>`
    SELECT ${challengeSelectFragment}
    FROM "Challenge" c
    WHERE c.id = ANY(${challengeIds}::int[])
  `;

  return rows.map(hydrateChallengeRow);
}

export async function getChallengeById(challengeId: number): Promise<ChallengeDetails | null> {
  const [result] = await getChallengesByIds([challengeId]);
  return result ?? null;
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

/**
 * Gets ALL active challenges (supports multiple concurrent challenges).
 * Returns challenges ordered by startsAt ASC (id tiebreak), bounded to
 * CHALLENGE_JOB_BATCH_SIZE per run so the same challenges aren't perpetually starved.
 */
export async function getActiveChallengesFromDb(
  limit = CHALLENGE_JOB_BATCH_SIZE
): Promise<ChallengeDetails[]> {
  const rows = await dbRead.$queryRaw<{ id: number }[]>`
    SELECT id
    FROM "Challenge"
    WHERE status = ${ChallengeStatus.Active}::"ChallengeStatus"
    ORDER BY "startsAt" ASC, id ASC
    LIMIT ${limit}
  `;
  return getChallengesByIds(rows.map((row) => row.id));
}

/**
 * Gets active challenges that have ENDED (endsAt <= now).
 * These challenges need winner picking and status transition.
 * Returns challenges ordered by endsAt ASC (oldest first, id tiebreak), bounded to
 * CHALLENGE_JOB_BATCH_SIZE per run.
 */
export async function getEndedActiveChallengesFromDb(): Promise<ChallengeDetails[]> {
  const rows = await dbRead.$queryRaw<{ id: number }[]>`
    SELECT id
    FROM "Challenge"
    WHERE status = ${ChallengeStatus.Active}::"ChallengeStatus"
    AND "endsAt" <= now()
    ORDER BY "endsAt" ASC, id ASC
    LIMIT ${CHALLENGE_JOB_BATCH_SIZE}
  `;
  return getChallengesByIds(rows.map((row) => row.id));
}

/**
 * Gets recently-completed challenges that still have stuck REVIEW CollectionItems.
 * Used by the reconciliation pass to re-process challenges that weren't fully settled.
 * Returns challenges whose endsAt is within the last windowHours hours, ordered by endsAt ASC
 * (id tiebreak), bounded to CHALLENGE_JOB_BATCH_SIZE per run.
 */
export async function getChallengesToReconcileFromDb(windowHours = 48): Promise<ChallengeDetails[]> {
  const rows = await dbRead.$queryRaw<{ id: number }[]>`
    SELECT c.id
    FROM "Challenge" c
    WHERE c.status = ${ChallengeStatus.Completed}::"ChallengeStatus"
    AND c."endsAt" > now() - (${windowHours} * interval '1 hour')
    AND EXISTS (
      SELECT 1 FROM "CollectionItem" ci
      WHERE ci."collectionId" = c."collectionId" AND ci.status = 'REVIEW'
    )
    ORDER BY c."endsAt" ASC, c.id ASC
    LIMIT ${CHALLENGE_JOB_BATCH_SIZE}
  `;
  return getChallengesByIds(rows.map((row) => row.id));
}

/**
 * Gets scheduled challenges that are ready to START (startsAt <= now).
 * These challenges should be activated.
 * Returns challenges ordered by startsAt ASC (oldest first, id tiebreak), bounded to
 * CHALLENGE_JOB_BATCH_SIZE per run.
 */
export async function getScheduledChallengesReadyToStart(): Promise<ChallengeDetails[]> {
  const rows = await dbRead.$queryRaw<{ id: number }[]>`
    SELECT id
    FROM "Challenge"
    WHERE status = ${ChallengeStatus.Scheduled}::"ChallengeStatus"
    AND "startsAt" <= now()
    AND ("source" != 'User' OR "ingestion" = 'Scanned')
    ORDER BY "startsAt" ASC, id ASC
    LIMIT ${CHALLENGE_JOB_BATCH_SIZE}
  `;
  return getChallengesByIds(rows.map((row) => row.id));
}

/**
 * Gets user-created challenges that are past their start time but never passed moderation scan
 * (Blocked, or stuck Pending/Error). None of these can activate (getScheduledChallengesReadyToStart
 * requires Scanned), so without intervention they sit Scheduled+hidden forever with the creator's
 * initial prize escrowed. Blocked ones are voided; Pending/Error ones get a re-scan attempt and
 * are voided once well past start. Returns id + ingestion ordered by startsAt ASC (id tiebreak),
 * bounded to CHALLENGE_JOB_BATCH_SIZE per run.
 */
export async function getUnscannedUserChallengesPastStart(): Promise<
  { id: number; ingestion: ChallengeIngestionStatus; startsAt: Date }[]
> {
  const rows = await dbRead.$queryRaw<
    { id: number; ingestion: ChallengeIngestionStatus; startsAt: Date }[]
  >`
    SELECT id, "ingestion", "startsAt"
    FROM "Challenge"
    WHERE status = ${ChallengeStatus.Scheduled}::"ChallengeStatus"
    AND source = ${ChallengeSource.User}::"ChallengeSource"
    AND "ingestion" != ${ChallengeIngestionStatus.Scanned}::"ChallengeIngestionStatus"
    AND "startsAt" <= now()
    ORDER BY "startsAt" ASC, id ASC
    LIMIT ${CHALLENGE_JOB_BATCH_SIZE}
  `;
  return rows;
}

/**
 * Gets an upcoming system-created challenge (scheduled).
 * Used to determine if auto-generation of a new system challenge is needed.
 * Returns null if no scheduled system challenge exists.
 */
export async function getUpcomingSystemChallengeFromDb(): Promise<ChallengeDetails | null> {
  const [row] = await dbRead.$queryRaw<{ id: number }[]>`
    SELECT id
    FROM "Challenge"
    WHERE source = ${ChallengeSource.System}::"ChallengeSource"
    AND status = ${ChallengeStatus.Scheduled}::"ChallengeStatus"
    ORDER BY "startsAt" ASC
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
    WHERE status = ${ChallengeStatus.Scheduled}::"ChallengeStatus"
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
  judgeId?: number | null;
  reviewPercentage?: number;
  maxReviews?: number;
  collectionId?: number; // Optional - auto-created if not provided
  maxEntriesPerUser?: number;
  prizes: Prize[];
  entryPrize?: Prize;
  entryPrizeRequirement?: number; // Min entries for participation prize
  prizePool?: number;
  prizeMode?: PrizeMode;
  basePrizePool?: number;
  buzzPerAction?: number;
  poolTrigger?: PoolTrigger | null;
  maxPrizePool?: number | null;
  prizeDistribution?: number[] | null;
  operationBudget?: number;
  reviewCostType?: ChallengeReviewCostType;
  reviewCost?: number;
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
        forcedBrowsingLevel: input.allowedNsfwLevel ?? sfwBrowsingLevelsFlag, // Enforce NSFW restrictions
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
      nsfwLevel: input.nsfwLevel ?? deriveChallengeNsfwLevel(input.allowedNsfwLevel ?? 1),
      allowedNsfwLevel: input.allowedNsfwLevel ?? 1,
      modelVersionIds: input.modelVersionIds ?? [],
      judgingPrompt: input.judgingPrompt,
      judgeId: input.judgeId ?? null,
      reviewPercentage: input.reviewPercentage ?? 100,
      maxReviews: input.maxReviews,
      collectionId: input.collectionId, // Optional - can be null
      maxEntriesPerUser: input.maxEntriesPerUser ?? 20,
      prizes: input.prizes as unknown as Prisma.InputJsonValue,
      entryPrize: input.entryPrize as unknown as Prisma.InputJsonValue,
      entryPrizeRequirement: input.entryPrizeRequirement ?? 10,
      prizePool: input.prizePool ?? 0,
      prizeMode: input.prizeMode ?? PrizeMode.Fixed,
      basePrizePool: input.basePrizePool ?? 0,
      buzzPerAction: input.buzzPerAction ?? 0,
      poolTrigger: input.poolTrigger ?? null,
      maxPrizePool: input.maxPrizePool ?? null,
      prizeDistribution: input.prizeDistribution
        ? (input.prizeDistribution as unknown as Prisma.InputJsonValue)
        : Prisma.JsonNull,
      operationBudget: input.operationBudget ?? 0,
      reviewCostType: input.reviewCostType ?? ChallengeReviewCostType.None,
      reviewCost: input.reviewCost ?? 0,
      createdById: input.createdById,
      source: input.source ?? ChallengeSource.System,
      status: input.status ?? ChallengeStatus.Scheduled,
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

export async function createChallengeWinner(input: CreateWinnerInput): Promise<number | null> {
  try {
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
  } catch (error) {
    // P2002 = unique constraint violation — record already exists (idempotent on recovery retry)
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      logToAxiom({
        type: 'info',
        name: 'challenge-winner-duplicate',
        message: `Duplicate winner skipped (recovery retry): challenge=${input.challengeId} user=${input.userId} place=${input.place}`,
        challengeId: input.challengeId,
      });
      return null;
    }
    throw error;
  }
}

export async function getChallengeWinners(challengeId: number): Promise<
  Array<{
    id: number;
    userId: number;
    username: string;
    imageId: number | null;
    imageUrl: string | null;
    imageNsfwLevel: number | null;
    imageHash: string | null;
    place: number;
    buzzAwarded: number;
    pointsAwarded: number;
    reason: string | null;
    judgeScore: JudgeScore | Record<string, number> | null;
  }>
> {
  const rows = await dbRead.$queryRaw<
    Array<{
      id: number;
      userId: number;
      username: string;
      imageId: number | null;
      imageUrl: string | null;
      imageNsfwLevel: number | null;
      imageHash: string | null;
      place: number;
      buzzAwarded: number;
      pointsAwarded: number;
      reason: string | null;
      collectionItemNote: string | null;
    }>
  >`
    SELECT
      cw.id,
      cw."userId",
      u.username,
      cw."imageId",
      i.url as "imageUrl",
      i."nsfwLevel" as "imageNsfwLevel",
      i.hash as "imageHash",
      cw.place,
      cw."buzzAwarded",
      cw."pointsAwarded",
      cw.reason,
      ci.note as "collectionItemNote"
    FROM "ChallengeWinner" cw
    JOIN "User" u ON u.id = cw."userId"
    LEFT JOIN "Image" i ON i.id = cw."imageId"
    JOIN "Challenge" c ON c.id = cw."challengeId"
    LEFT JOIN "CollectionItem" ci ON ci."collectionId" = c."collectionId"
      AND ci."imageId" = cw."imageId"
    WHERE cw."challengeId" = ${challengeId}
    ORDER BY cw.place ASC
  `;

  return rows.map(({ collectionItemNote, ...row }) => ({
    ...row,
    judgeScore: parseJudgeScore(collectionItemNote),
  }));
}

/**
 * Check if ChallengeWinner records already exist for a challenge.
 * Used to short-circuit LLM winner generation on retry — if winners were already
 * picked in a previous (failed) run, reuse them instead of re-running the LLM.
 */
export async function getExistingWinnersForRetry(challengeId: number): Promise<
  Array<{
    userId: number;
    imageId: number | null;
    place: number;
    buzzAwarded: number;
    pointsAwarded: number;
    reason: string | null;
  }>
> {
  return dbRead.$queryRaw`
    SELECT
      cw."userId",
      cw."imageId",
      cw.place,
      cw."buzzAwarded",
      cw."pointsAwarded",
      cw.reason
    FROM "ChallengeWinner" cw
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

// =============================================================================
// Atomic Claim Helpers (Race Condition Prevention)
// =============================================================================

/**
 * Atomically claim a challenge for completion processing.
 * Uses UPDATE ... WHERE status='Active' to prevent duplicate processing.
 * Returns true if this process owns the challenge, false if already claimed.
 */
export async function claimChallengeForCompletion(challengeId: number): Promise<boolean> {
  const result = await dbWrite.$executeRaw`
    UPDATE "Challenge"
    SET status = ${ChallengeStatus.Completing}::"ChallengeStatus",
        metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('completingClaimedAt', ${new Date().toISOString()})
    WHERE id = ${challengeId}
    AND status = ${ChallengeStatus.Active}::"ChallengeStatus"
  `;
  return result > 0;
}

/**
 * Reset challenges stuck in 'Completing' status back to 'Active' for retry.
 * A challenge is considered stuck if it has been in Completing for longer than timeoutMinutes.
 */
export async function resetStuckCompletingChallenges(timeoutMinutes = 10): Promise<number> {
  const result = await dbWrite.$executeRaw`
    UPDATE "Challenge"
    SET status = ${ChallengeStatus.Active}::"ChallengeStatus"
    WHERE status = ${ChallengeStatus.Completing}::"ChallengeStatus"
    AND (metadata->>'completingClaimedAt')::timestamptz < now() - ${`${timeoutMinutes} minutes`}::interval
  `;
  if (result > 0) {
    logToAxiom({
      type: 'warning',
      name: 'challenge-completion-recovery',
      message: `Reset ${result} stuck Completing challenge(s) back to Active`,
      count: result,
    });
  }
  return result;
}

// =============================================================================
// Shared Query Result Types
// =============================================================================

/** Row shape for collection entry queries (used by processing and testing). */
export type RecentEntry = {
  imageId: number;
  userId: number;
  username: string;
  url: string;
};

/** Row shape for resource selection queries (used by processing and testing). */
export type SelectedResource = {
  modelId: number;
  creator: string;
  title: string;
};

/** Event context for scoping winner cooldowns. */
export type EventContext = {
  eventId: number | null;
  /** null = use global default, 0 = no cooldown, >0 = custom cooldown days */
  winnerCooldownDays: number | null;
};

/** Resolve event context for a challenge's eventId. */
export async function resolveEventContext(eventId: number | null): Promise<EventContext> {
  let winnerCooldownDays: number | null = null;
  if (eventId != null) {
    const eventRow = await dbRead.challengeEvent.findUnique({
      where: { id: eventId },
      select: { winnerCooldownDays: true },
    });
    winnerCooldownDays = eventRow?.winnerCooldownDays ?? null;
  }
  return { eventId, winnerCooldownDays };
}

/**
 * Resolve the `categories` + `nsfw` inputs generateReview() needs for judging a challenge entry.
 * User-source challenges always carry creator-defined judging categories (JSONB); other sources
 * leave this null unless DYNAMIC_JUDGING_CATEGORIES is enabled. Parse defensively — a
 * malformed/corrupt value falls back to the fixed theme/wittiness/humor/aesthetic scoring
 * schema instead of failing the review. Mirrors the gate in reviewEntriesForChallenge
 * (~/server/jobs/daily-challenge-processing.ts).
 */
export async function resolveChallengeReviewInputs(challenge: {
  source: ChallengeSource;
  judgingCategories: unknown;
  allowedNsfwLevel: number;
}): Promise<{
  categories: { key: string; name: string; criteria: string }[] | undefined;
  nsfw: boolean;
}> {
  const useCategories =
    challenge.source === ChallengeSource.User ||
    (await isFlipt(FLIPT_FEATURE_FLAGS.DYNAMIC_JUDGING_CATEGORIES));
  const userJudgingCategories = useCategories
    ? challengeJudgingCategoriesSchema.safeParse(challenge.judgingCategories)
    : undefined;
  const userCategories: ChallengeJudgingCategory[] | undefined = userJudgingCategories?.success
    ? userJudgingCategories.data
    : undefined;

  return {
    categories: userCategories?.map((c) => ({ key: c.key, name: c.label, criteria: c.criteria })),
    nsfw: !getIsSafeBrowsingLevel(challenge.allowedNsfwLevel),
  };
}
