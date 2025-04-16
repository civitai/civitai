import type { ResourceSelectOptions } from '~/components/ImageGeneration/GenerationForm/resource-select.types';
import type { GetAuctionBySlugReturn } from '~/server/services/auction.service';
import { getBaseModelResourceTypes, miscModelTypes } from '~/shared/constants/generation.constants';
import { ModelType } from '~/shared/utils/prisma/enums';

// export const modelsToAddToCollection = 3;
export const miscAuctionName = 'Misc';

type ResourceOptions = Exclude<ResourceSelectOptions['resources'], undefined>;
export const getModelTypesForAuction = (ab: GetAuctionBySlugReturn['auctionBase'] | undefined) => {
  if (!ab) return [] as ResourceOptions;

  if (ab.ecosystem === null) {
    return [{ type: ModelType.Checkpoint }] as ResourceOptions;
  }

  if (ab.ecosystem === miscAuctionName) {
    return miscModelTypes.map((m) => ({
      type: m,
    })) as ResourceOptions;
  }

  //  as BaseModelResourceTypes[keyof BaseModelResourceTypes]
  return (getBaseModelResourceTypes(ab.ecosystem) ?? []).filter(
    (t) => t.type !== 'Checkpoint'
  ) as ResourceOptions;
};
