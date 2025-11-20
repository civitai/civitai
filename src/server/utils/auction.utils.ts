import type { ResourceSelectOptions } from '~/components/ImageGeneration/GenerationForm/resource-select.types';
import type { AuctionBaseInfo } from '~/shared/types/auction.types';
import type { BaseModel, BaseModelGroup } from '~/shared/constants/base-model.constants';
import {
  activeBaseModels,
  getBaseModelConfig,
  getGenerationBaseModelResourceOptions,
} from '~/shared/constants/base-model.constants';
import { miscAuctionName } from '~/shared/constants/auction.constants';
import { miscModelTypes } from '~/shared/constants/generation.constants';
import { ModelType } from '~/shared/utils/prisma/enums';

type ResourceOptions = Exclude<ResourceSelectOptions['resources'], undefined>;

export const getModelTypesForAuction = (ab: AuctionBaseInfo | undefined) => {
  if (!ab) return [] as ResourceOptions;

  if (ab.ecosystem === null) {
    // For featured-checkpoints, allow all active base models except Qwen
    const allowedBaseModels = activeBaseModels.filter((baseModel) => {
      const config = getBaseModelConfig(baseModel);
      return config.group !== 'Qwen';
    }) as BaseModel[];

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
