import type { BaseModel } from '~/server/common/constants';
import { baseModelSets } from '~/server/common/constants';

export function getBaseModelEcosystemName(baseModel: BaseModel | undefined) {
  if (!baseModel) return 'Stable Diffusion';

  return (
    Object.values(baseModelSets).find((baseModelSet) =>
      (baseModelSet.baseModels as string[]).includes(baseModel)
    )?.name ?? 'Stable Diffusion'
  );
}
