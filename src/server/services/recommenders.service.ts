import { dbRead } from '~/server/db/client';
import { Recommenders } from '~/server/http/recommenders/recommenders.schema';
import recommendersCaller from '../http/recommenders/recommenders.caller';
import { isProd } from '~/env/other';

export async function getUserRecentDownloads(userId: number): Promise<number[]> {
  let result = await dbRead.downloadHistory.findMany({
    where: { userId },
    orderBy: { downloadAt: 'desc' },
    take: 10,
    select: { userId: false, modelVersionId: true, downloadAt: false, hidden: false },
  })
  return result.map((r) => r.modelVersionId);
}

export async function getRecommendations(params: Recommenders.RecommendationRequest){
  const recommendations = await recommendersCaller.getResourceRecommendationForResource(params);
  return recommendations;
}