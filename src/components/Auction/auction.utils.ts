import type { ResourceSelectOptions } from '~/components/ImageGeneration/GenerationForm/resource-select.types';
import type { GetAuctionBySlugReturn } from '~/server/services/auction.service';
import type { BaseModel, BaseModelGroup } from '~/shared/constants/base-model.constants';
import {
  activeBaseModels,
  getBaseModelConfig,
  getCanAuctionForGeneration,
  getGenerationBaseModelResourceOptions,
} from '~/shared/constants/base-model.constants';
import { miscModelTypes } from '~/shared/constants/generation.constants';
import { ModelType } from '~/shared/utils/prisma/enums';
import nsfwWords from '~/utils/metadata/lists/words-nsfw-soft.json';

// export const modelsToAddToCollection = 3;
export const miscAuctionName = 'Misc';

export const getCleanedNSFWWords = () => {
  return nsfwWords.filter((word) => /^[a-zA-Z ]+$/.test(word));
};
const cleanedWords = getCleanedNSFWWords();
export const hasNSFWWords = (str: string | undefined) => {
  if (!str || !str.length) return false;
  return cleanedWords.some((word) => str.toLowerCase().includes(word.toLowerCase()));
};

type ResourceOptions = Exclude<ResourceSelectOptions['resources'], undefined>;
export const getModelTypesForAuction = (ab: GetAuctionBySlugReturn['auctionBase'] | undefined) => {
  if (!ab) return [] as ResourceOptions;

  if (ab.ecosystem === null) {
    // For featured-checkpoints, allow all active base models except Qwen
    const allowedBaseModels = activeBaseModels.filter((baseModel) =>
      getCanAuctionForGeneration(baseModel)
    ) as BaseModel[];

    return [{ type: ModelType.Checkpoint, baseModels: allowedBaseModels }] as ResourceOptions;
  }

  if (ab.ecosystem === miscAuctionName) {
    return miscModelTypes.map((m) => ({
      type: m,
    })) as ResourceOptions;
  }

  return (getGenerationBaseModelResourceOptions(ab.ecosystem as BaseModelGroup) ?? []).filter(
    (t) => t.type !== 'Checkpoint'
  ) as ResourceOptions;
};
