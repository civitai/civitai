import { ArticleSort } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import {
  dailyChallengeConfig,
  getCurrentChallenge,
} from '~/server/games/daily-challenge/daily-challenge.utils';
import { articleWhereSchema } from '~/server/schema/article.schema';
import { getArticles } from '~/server/services/article.service';
import { throwNotFoundError } from '~/server/utils/errorHandling';

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

export function getCurrentDailyChallenge() {
  return getCurrentChallenge();
}
