import { Prisma } from '@prisma/client';
import { ArticleSort } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import {
  getChallengeById,
  type ChallengeDetails as NewChallengeDetails,
} from '~/server/games/daily-challenge/challenge-helpers';
import {
  dailyChallengeConfig,
  getCurrentChallenge,
} from '~/server/games/daily-challenge/daily-challenge.utils';
import { articleWhereSchema } from '~/server/schema/article.schema';
import { getArticles } from '~/server/services/article.service';
import { throwNotFoundError } from '~/server/utils/errorHandling';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { ChallengeStatus } from '~/shared/utils/prisma/enums';
import * as z from 'zod';
import { isFutureDate, startOfDay } from '~/utils/date-helpers';

export async function getAllDailyChallenges() {
  const dailyChallengeCollectionId = dailyChallengeConfig.challengeCollectionId;

  const collection = await dbRead.collection.findUnique({
    where: { id: dailyChallengeCollectionId },
    select: { id: true },
  });
  if (!collection) throw throwNotFoundError('Challenge collection not found');

  const input = articleWhereSchema.parse({
    collectionId: dailyChallengeCollectionId,
    sort: ArticleSort.Newest,
  });

  const challenges = await getArticles({ ...input, limit: 100 });
  return challenges;
}

export type ChallengeDetails = {
  /** @deprecated Article IDs are no longer used for new challenges. Use challengeId instead. */
  articleId?: number;
  /** Challenge ID from the new Challenge table */
  challengeId?: number;
  date: Date;
  resources?: { id: number; modelId: number }[];
  engine?: string;
  collectionId: number;
  title: string;
  invitation: string;
  coverUrl: string;
  judge?: 'ai' | 'team';
  endsToday?: boolean;
};

/**
 * @deprecated Use trpc.challenge.getInfinite with status: [ChallengeStatus.Active] instead.
 * This function uses the legacy Article-based system which is being phased out.
 */
export async function getCurrentDailyChallenge() {
  const [currentChallenge, customChallenge] = await Promise.all([
    getCurrentChallenge(),
    getCustomChallenge(),
  ]);

  const challengeDetails: ChallengeDetails[] = [];
  if (currentChallenge)
    challengeDetails.push({
      challengeId: currentChallenge.challengeId,
      articleId: currentChallenge.articleId,
      date: currentChallenge.date,
      resources: currentChallenge.modelVersionIds.map((id) => ({
        id,
        modelId: currentChallenge.modelId,
      })),
      collectionId: currentChallenge.collectionId,
      title: currentChallenge.title,
      invitation: currentChallenge.invitation,
      coverUrl: currentChallenge.coverUrl,
      judge: 'ai',
    });

  const now = new Date().getTime();
  if (customChallenge && customChallenge.endsAtDate.getTime() > now) {
    challengeDetails.push({
      articleId: customChallenge.articleId,
      date: customChallenge.endsAtDate,
      resources: customChallenge.resources?.map(({ modelVersionId, modelId }) => ({
        id: modelVersionId,
        modelId,
      })),
      engine: customChallenge.engine,
      collectionId: customChallenge.collectionId,
      title: customChallenge.title,
      invitation: customChallenge.invitation,
      coverUrl: customChallenge.coverUrl,
      judge: 'team',
    });
  }

  return challengeDetails.map((challenge) => ({
    ...challenge,
    endsToday: !isFutureDate(startOfDay(challenge.date)),
  }));
}

const customChallengeSchema = z.object({
  articleId: z.number(),
  endsAtDate: z.string(),
  resources: z.object({ modelVersionId: z.number(), modelId: z.number() }).array().optional(),
  engine: z.string().optional(),
  collectionId: z.number(),
  title: z.string(),
  /** should have been called description */
  invitation: z.string(),
  /** the guid of the image url */
  coverUrl: z.string(),
});

export async function getCustomChallenge() {
  const data = await sysRedis.get(REDIS_SYS_KEYS.GENERATION.CUSTOM_CHALLENGE);
  if (!data) return null;
  const challenge = customChallengeSchema.parse(JSON.parse(data));
  const date = new Date(challenge.endsAtDate).toISOString().split('T')[0];
  return { ...challenge, endsAtDate: new Date(`${date}T23:59:59.999Z`) };
}

export async function setCustomChallenge(data: Record<string, unknown>) {
  const parsed = customChallengeSchema.parse(data);
  await sysRedis.set(REDIS_SYS_KEYS.GENERATION.CUSTOM_CHALLENGE, JSON.stringify(parsed));
}

export async function deleteCustomChallenge() {
  await sysRedis.del(REDIS_SYS_KEYS.GENERATION.CUSTOM_CHALLENGE);
}

// =============================================================================
// New Challenge Table Functions
// =============================================================================

/**
 * Get all challenges from the new Challenge table
 * Includes active, scheduled, and completed challenges
 */
export async function getAllChallengesFromDb(options?: {
  status?: ChallengeStatus[];
  limit?: number;
}) {
  const { status, limit = 100 } = options ?? {};

  // Build WHERE conditions using parameterized queries (SQL injection safe)
  const conditions: Prisma.Sql[] = [];

  if (status && status.length > 0) {
    const statusValues = status.map((s) => Prisma.sql`${s}::"ChallengeStatus"`);
    conditions.push(Prisma.sql`status IN (${Prisma.join(statusValues)})`);
  }

  const whereClause =
    conditions.length > 0 ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;

  const rows = await dbRead.$queryRaw<{ id: number }[]>`
    SELECT id
    FROM "Challenge"
    ${whereClause}
    ORDER BY "startsAt" DESC
    LIMIT ${limit}
  `;

  const challenges = await Promise.all(rows.map((row) => getChallengeById(row.id)));
  return challenges.filter((c): c is NewChallengeDetails => c !== null);
}

/**
 * Get visible challenges (visible and not completed/cancelled)
 * Used for the public challenges feed
 */
export async function getVisibleChallenges(limit = 30) {
  const rows = await dbRead.$queryRaw<{ id: number }[]>`
    SELECT id
    FROM "Challenge"
    WHERE "visibleAt" <= now()
    AND status NOT IN (${ChallengeStatus.Completed}::"ChallengeStatus", ${ChallengeStatus.Cancelled}::"ChallengeStatus")
    ORDER BY
      CASE
        WHEN status = ${ChallengeStatus.Active}::"ChallengeStatus" THEN 1
        WHEN status = ${ChallengeStatus.Scheduled}::"ChallengeStatus" THEN 2
        ELSE 3
      END,
      "startsAt" DESC
    LIMIT ${limit}
  `;

  const challenges = await Promise.all(rows.map((row) => getChallengeById(row.id)));
  return challenges.filter((c): c is NewChallengeDetails => c !== null);
}

/**
 * Get a single challenge by ID with full details
 */
export { getChallengeById } from '~/server/games/daily-challenge/challenge-helpers';
