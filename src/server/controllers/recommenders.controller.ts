import { MetricTimeframe, ModelModifier } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { Context } from '~/server/createContext';
import { isModerator } from '~/server/routers/base.router';
import { GetByIdInput, UserPreferencesInput } from '~/server/schema/base.schema';
import { getAllModelsSchema } from '~/server/schema/model.schema';
import { RecommendationRequest } from '~/server/schema/recommenders.schema';
import { getUnavailableResources } from '~/server/services/generation/generation.service';
import { getImagesForModelVersion } from '~/server/services/image.service';
import { getModelsRaw } from '~/server/services/model.service';
import {
  getRecommendations,
  toggleResourceRecommendation,
} from '~/server/services/recommenders.service';
import { throwDbError } from '~/server/utils/errorHandling';
import { isDefined } from '~/utils/type-guards';

export const getAssociatedRecommendedResourcesCardDataHandler = async ({
  input,
  ctx,
}: {
  input: RecommendationRequest & UserPreferencesInput;
  ctx: Context;
}) => {
  try {
    const { modelVersionId, browsingLevel, ...userPreferences } = input;
    const { user } = ctx;

    const resourcesIds: number[] | undefined = await getRecommendations({
      modelVersionId,
      excludeIds: userPreferences.excludedModelIds,
      browsingLevel,
    });

    if (!resourcesIds?.length) return [];

    const { cursor, ...modelInput } = getAllModelsSchema.parse({
      ...userPreferences,
      browsingLevel,
      modelVersionIds: resourcesIds,
      period: MetricTimeframe.AllTime,
    });

    const { items: models } = await getModelsRaw({ user, input: modelInput });

    const modelVersionIds = models.flatMap((m) => m.modelVersions).map((m) => m.id);
    const images = !!modelVersionIds.length
      ? await getImagesForModelVersion({
          modelVersionIds,
          excludedTagIds: modelInput.excludedTagIds,
          excludedIds: input.excludedImageIds,
          excludedUserIds: modelInput.excludedUserIds,
          user,
          pending: modelInput.pending,
          browsingLevel: modelInput.browsingLevel,
        })
      : [];

    const unavailableGenResources = await getUnavailableResources();
    const completeModels = models
      .map(({ hashes, modelVersions, rank, tagsOnModels, ...model }) => {
        const [version] = modelVersions;
        if (!version) return null;

        const versionImages = images.filter((i) => i.modelVersionId === version.id);
        const showImageless =
          (user?.isModerator || model.user.id === user?.id) &&
          (modelInput.user || modelInput.username);
        if (!versionImages.length && !showImageless) return null;

        const canGenerate = !!version.covered && !unavailableGenResources.includes(version.id);

        return {
          ...model,
          tags: tagsOnModels.map(({ tagId }) => tagId),
          hashes: hashes.map((h) => h.toLowerCase()),
          rank: {
            downloadCount: rank?.downloadCountAllTime ?? 0,
            thumbsUpCount: rank?.thumbsUpCountAllTime ?? 0,
            thumbsDownCount: rank?.thumbsDownCountAllTime ?? 0,
            commentCount: rank?.commentCountAllTime ?? 0,
            ratingCount: rank?.ratingCountAllTime ?? 0,
            collectedCount: rank?.collectedCountAllTime ?? 0,
            tippedAmountCount: rank?.tippedAmountCountAllTime ?? 0,
            rating: rank.ratingAllTime ?? 0,
          },
          images: model.mode !== ModelModifier.TakenDown ? (versionImages as typeof images) : [],
          canGenerate,
          version,
        };
      })
      .filter(isDefined);

    return completeModels;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export function toggleResourceRecommendationHandler({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: DeepNonNullable<Context>;
}) {
  try {
    return toggleResourceRecommendation({
      resourceId: input.id,
      userId: ctx.user.id,
      isModerator: ctx.user.isModerator,
    });
  } catch (e) {
    if (e instanceof TRPCError) throw e;
    throw throwDbError(e);
  }
}
