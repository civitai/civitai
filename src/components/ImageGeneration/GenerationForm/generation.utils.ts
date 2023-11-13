import { BaseModel, BaseModelSetType, baseModelSets, generation } from '~/server/common/constants';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { isDefined } from '~/utils/type-guards';
import { calculateGenerationBill } from '~/server/common/generation';
import { RunType } from '~/store/generation.store';
import { uniqBy } from 'lodash';
import { GenerateFormModel } from '~/server/schema/generation.schema';
import { useMemo } from 'react';

export const useGenerationFormStore = create<Partial<GenerateFormModel>>()(
  persist(() => ({}), { name: 'generation-form-2', version: 0 })
);

export const useTempGenerateStore = create<{
  baseModel?: BaseModelSetType;
  hasResources?: boolean;
}>(() => ({}));

export const useDerivedGenerationState = () => {
  const totalCost = useGenerationFormStore(({ baseModel, aspectRatio, steps, quantity }) =>
    calculateGenerationBill({ baseModel, aspectRatio, steps, quantity })
  );

  const baseModel = useGenerationFormStore(({ model }) =>
    model?.baseModel ? getBaseModelSetKey(model.baseModel) : undefined
  );

  const hasResources = useGenerationFormStore(
    ({ resources = [], vae }) => [...resources, vae].filter(isDefined).length > 0
  );

  const additionalResourcesCount = useGenerationFormStore(({ resources = [] }) => resources.length);

  const resources = useGenerationFormStore((state) => state.resources);
  const trainedWords = useMemo(
    () => resources?.flatMap((x) => x.trainedWords).filter(isDefined) ?? [],
    [resources]
  );

  return {
    totalCost,
    baseModel,
    hasResources,
    trainedWords,
    additionalResourcesCount,
    isSDXL: baseModel === 'SDXL',
  };
};

export const getFormData = (type: RunType, data: Partial<GenerateFormModel>) => {
  const formData = useGenerationFormStore.getState();
  switch (type) {
    case 'remix':
    case 'params':
    case 'random':
      return { ...formData, ...data };
    case 'run': {
      const baseModel = data.baseModel as BaseModelSetType | undefined;
      const resources = (formData.resources ?? []).concat(data.resources ?? []);
      const uniqueResources = !!resources.length ? uniqBy(resources, 'id') : undefined;
      const filteredResources = baseModel
        ? uniqueResources?.filter((x) =>
            baseModelSets[baseModel].includes(x.baseModel as BaseModel)
          )
        : uniqueResources;
      const parsedModel = data.model ?? formData.model;
      const [model] = parsedModel
        ? baseModel
          ? [parsedModel].filter((x) => baseModelSets[baseModel].includes(x.baseModel as BaseModel))
          : [parsedModel]
        : [];

      const parsedVae = data.vae ?? formData.vae;
      const [vae] = parsedVae
        ? baseModel
          ? [parsedVae].filter((x) => baseModelSets[baseModel].includes(x.baseModel as BaseModel))
          : [parsedVae]
        : [];

      return {
        ...formData,
        ...data,
        model,
        resources: filteredResources,
        vae,
      };
    }
    default:
      throw new Error(`unhandled RunType: ${type}`);
  }
};

// TODO - move these somewhere that makes more sense
export const getBaseModelSetKey = (baseModel: string) =>
  Object.entries(baseModelSets).find(([, baseModels]) =>
    baseModels.includes(baseModel as any)
  )?.[0] as BaseModelSetType | undefined;

export const getBaseModelset = (baseModel: string) =>
  Object.entries(baseModelSets).find(
    ([key, set]) => key === baseModel || set.includes(baseModel as any)
  )?.[1];
