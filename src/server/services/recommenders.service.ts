import { getDbWithoutLag, preventReplicationLag } from '~/server/db/db-helpers';
import recommendersCaller from '~/server/http/recommenders/recommenders.caller';
import { ModelVersionMeta } from '~/server/schema/model-version.schema';
import { RecommendationRequest } from '~/server/schema/recommenders.schema';
import { throwAuthorizationError, throwNotFoundError } from '~/server/utils/errorHandling';

export async function getRecommendations(params: RecommendationRequest) {
  const recommendations = await recommendersCaller.getResourceRecommendationForResource(params);
  return recommendations;
}

export async function toggleResourceRecommendation({
  resourceId,
  userId,
  isModerator,
}: {
  resourceId: number;
  userId: number;
  isModerator?: boolean;
}) {
  const db = await getDbWithoutLag('modelVersion', resourceId);
  const modelVersion = await db.modelVersion.findUnique({
    where: { id: resourceId },
    select: { id: true, meta: true, model: { select: { userId: true } } },
  });
  if (!modelVersion) throw throwNotFoundError(`No model version found with id ${resourceId}`);
  if (modelVersion.model.userId !== userId || !isModerator)
    throw throwAuthorizationError("You don't have permission to toggle this setting");

  const versionMeta = modelVersion.meta as ModelVersionMeta;
  const updatedVersion = await db.modelVersion.update({
    where: { id: resourceId },
    data: {
      meta: { ...versionMeta, allowAIRecommendations: !versionMeta.allowAIRecommendations },
    },
    select: { id: true, meta: true },
  });

  await preventReplicationLag('modelVersion', updatedVersion.id);

  return { ...updatedVersion, meta: updatedVersion.meta as ModelVersionMeta };
}
