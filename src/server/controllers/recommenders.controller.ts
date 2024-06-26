import {
  MetricTimeframe,
  ModelModifier,
} from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { GetAssociatedResourcesInput, getAllModelsSchema } from "../schema/model.schema";
import { Recommenders } from "../http/recommenders/recommenders.schema"
import { UserPreferencesInput } from "../schema/base.schema";
import { Context } from '~/server/createContext';
import { getRecommendations } from '../services/recommenders.service';
import { getModelsRaw } from '../services/model.service';
import { getImagesForModelVersion } from '../services/image.service';
import { getUnavailableResources } from '../services/generation/generation.service';
import { isDefined } from '~/utils/type-guards';
import { throwDbError } from '../utils/errorHandling';

export const getAssociatedRecommendedResourcesCardDataHandler = async ({
  input,
  ctx,
}: {
  input: Recommenders.RecommendationRequest & UserPreferencesInput;
  ctx: Context;
}) => {
  try {
    const { modelVersionId, ...userPreferences } = input;
    const { user } = ctx;

    const resourcesIds:number[]|undefined = await getRecommendations({modelVersionId, excludeIds:userPreferences.excludedModelIds})

    if (!resourcesIds?.length) return [];

    const period = MetricTimeframe.AllTime;
    const { cursor, ...modelInput } = getAllModelsSchema.parse({
      ...userPreferences,
      ids: resourcesIds,
      period,
    });

    const { items: models } =
    resourcesIds?.length > 0
        ? await getModelsRaw({
            user,
            input: modelInput,
          })
        : { items: [] };

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
      .map(({ hashes, modelVersions, rank, ...model }) => {
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

    return resourcesIds
      .map((id) => {
        const model = completeModels.find((model) => model.id === id);
        if (!model) return null;
        return { resourceType: 'model' as const, ...model };
      })
      .filter(isDefined);
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};