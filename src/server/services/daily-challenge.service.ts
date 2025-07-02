import { ArticleSort } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import {
  dailyChallengeConfig,
  getCurrentChallenge,
} from '~/server/games/daily-challenge/daily-challenge.utils';
import { articleWhereSchema } from '~/server/schema/article.schema';
import { getArticles } from '~/server/services/article.service';
import { throwNotFoundError } from '~/server/utils/errorHandling';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import * as z from 'zod/v4';
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
  articleId: number;
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

export async function getCurrentDailyChallenge() {
  const [currentChallenge, customChallenge] = await Promise.all([
    getCurrentChallenge(),
    getCustomChallenge(),
  ]);

  const challengeDetails: ChallengeDetails[] = [];
  if (currentChallenge)
    challengeDetails.push({
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
  invitation: z.string(),
  coverUrl: z.string(),
});

export async function getCustomChallenge() {
  const data = await sysRedis.get(REDIS_SYS_KEYS.GENERATION.CUSTOM_CHALLENGE);
  if (!data) return null;
  const challenge = customChallengeSchema.parse(JSON.parse(data));
  return { ...challenge, endsAtDate: new Date(`${challenge.endsAtDate}T23:59:59.999Z`) };
}

export async function setCustomChallenge(data: Record<string, unknown>) {
  const parsed = customChallengeSchema.parse(data);
  await sysRedis.set(REDIS_SYS_KEYS.GENERATION.CUSTOM_CHALLENGE, JSON.stringify(parsed));
}

export async function deleteCustomChallenge() {
  await sysRedis.del(REDIS_SYS_KEYS.GENERATION.CUSTOM_CHALLENGE);
}
