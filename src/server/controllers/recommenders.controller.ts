import { MetricTimeframe, ModelModifier } from '~/shared/utils/prisma/enums';
import { TRPCError } from '@trpc/server';
import { ModelSort } from '~/server/common/enums';
import type { Context } from '~/server/createContext';
import type { GetByIdInput, UserPreferencesInput } from '~/server/schema/base.schema';
import type { ModelVersionMeta } from '~/server/schema/model-version.schema';
import { getAllModelsSchema } from '~/server/schema/model.schema';
import type { RecommendationRequest } from '~/server/schema/recommenders.schema';
import { getUnavailableResources } from '~/server/services/generation/generation.service';
import { getImagesForModelVersion } from '~/server/services/image.service';
import { getVersionById } from '~/server/services/model-version.service';
import { getGallerySettingsByModelId, getModelsRaw } from '~/server/services/model.service';
import {
  getRecommendations,
  toggleResourceRecommendation,
} from '~/server/services/recommenders.service';
import {
  BlockedByUsers,
  BlockedUsers,
  HiddenUsers,
} from '~/server/services/user-preferences.service';
import { throwDbError } from '~/server/utils/errorHandling';
import { Flags } from '~/shared/utils/flags';
import { isDefined } from '~/utils/type-guards';

export const getRecommendedResourcesCardDataHandler = async ({
  input,
  ctx,
}: {
  input: RecommendationRequest & UserPreferencesInput;
  ctx: Context;
}) => {
  try {
    const { modelVersionId, limit, ...userPreferences } = input;
    const { user } = ctx;

    const modelVersion = await getVersionById({
      id: modelVersionId,
      select: { meta: true, nsfwLevel: true, modelId: true },
    });
    if (!modelVersion || !(modelVersion?.meta as ModelVersionMeta).allowAIRecommendations)
      return [];

    const gallerySettings = await getGallerySettingsByModelId({ id: modelVersion.modelId });
    const nsfwLevelIntersection = Flags.intersection(
      user?.browsingLevel ?? 1,
      gallerySettings?.level ?? 1
    );

    const resourcesIds = await getRecommendations({
      modelVersionId,
      excludeIds: userPreferences.excludedModelIds,
      browsingLevel: nsfwLevelIntersection,
      limit,
    });
    if (!resourcesIds?.length) return [];

    const result = getAllModelsSchema.safeParse({
      ...userPreferences,
      browsingLevel: nsfwLevelIntersection,
      modelVersionIds: resourcesIds,
      period: MetricTimeframe.AllTime,
      sort: ModelSort.HighestRated,
    });
    if (!result.success) throw throwDbError(new Error('Failed to parse input'));

    const { cursor, ...modelInput } = result.data;

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
          browsingLevel: nsfwLevelIntersection,
        })
      : [];

    const unavailableGenResources = await getUnavailableResources();
    const hiddenUsers = await Promise.all([
      HiddenUsers.getCached({ userId: ctx.user?.id }),
      BlockedByUsers.getCached({ userId: ctx.user?.id }),
      BlockedUsers.getCached({ userId: ctx.user?.id }),
    ]);
    const excludedUserIds = [...new Set(hiddenUsers.flat().map((u) => u.id))];

    const completeModels = models
      .map(({ hashes, modelVersions, rank, tagsOnModels, ...model }) => {
        const [version] = modelVersions;
        if (!version) return null;
        if (excludedUserIds.includes(model.user.id)) return null;

        const versionImages = images.filter((i) => i.modelVersionId === version.id);
        const showImageless =
          (user?.isModerator || model.user.id === user?.id) &&
          (modelInput.user || modelInput.username);
        if (!versionImages.length && !showImageless) return null;

        const canGenerate = !!version.covered && !unavailableGenResources.includes(version.id);

        return {
          ...model,
          resourceType: 'recommended' as const,
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
