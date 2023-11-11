import { BaseModelSetType, baseModelSets, generation } from '~/server/common/constants';
import { z } from 'zod';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import useIsClient from '~/hooks/useIsClient';
import { useMemo } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { isDefined } from '~/utils/type-guards';
import { calculateGenerationBill } from '~/server/common/generation';

const resource = z
  .object({
    id: z.number(),
    type: z.string(),
    strength: z.number(),
    trainedWords: z.string().array(),
    baseModel: z.string(),
  })
  .partial();

export const generationFormSchema = z
  .object({
    nsfw: z.boolean(),
    quantity: z.number(),
    prompt: z.string(),
    negativePrompt: z.string(),
    cfgScale: z.number(),
    sampler: z.string(),
    seed: z.number(),
    steps: z.number(),
    clipSkip: z.number(),
    aspectRatio: z.string(),
    baseModel: z.string(),
    model: resource,
    resources: resource.array(),
    vae: resource,
  })
  .partial();

const parseData = (data: unknown) => {
  const result = generationFormSchema.safeParse(data);
  if (result.success) return result.data;
  return {};
};

export type GenerationFormSchema = z.infer<typeof generationFormSchema>;
export const useGenerationFormStore = create<GenerationFormSchema>()(
  persist(() => ({}), { name: 'generation-form-2' })
);

export const useGetInitialFormData = () => {
  const currentUser = useCurrentUser();
  const isClient = useIsClient();
  return useMemo((): GenerationFormSchema => {
    const data = isClient ? parseData(useGenerationFormStore.getState()) : {};
    return {
      nsfw: currentUser?.showNsfw ?? false,
      ...generation.defaultValues,
      ...data,
    };
  }, [isClient, currentUser]);
};

export const useTempGenerateStore = create<{
  baseModel?: BaseModelSetType;
  hasResources?: boolean;
}>(() => ({}));

export const useDerivedGenerationState = () => {
  const totalCost = useGenerationFormStore(({ baseModel, aspectRatio, steps, quantity }) =>
    calculateGenerationBill({ baseModel, aspectRatio, steps, quantity })
  );

  const { baseModel, hasResources } = useGenerationFormStore(({ model, resources, vae }) => {
    const allResources = [...(resources ?? []), ...[vae].filter(isDefined)];
    const baseModel = model?.baseModel ? getBaseModelSetKey(model.baseModel) : undefined;

    return {
      baseModel,
      hasResources: !!allResources.length,
    };
  });

  const additionalResourcesCount = useGenerationFormStore((state) =>
    state.resources ? state.resources.length : 0
  );
  const trainedWords = useGenerationFormStore(({ resources }) =>
    resources?.flatMap((x) => x.trainedWords)
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

export const getBaseModelSetKey = (baseModel: string) =>
  Object.entries(baseModelSets).find(([, baseModels]) =>
    baseModels.includes(baseModel as any)
  )?.[0] as BaseModelSetType | undefined;

export const getBaseModelset = (baseModel: string) =>
  Object.entries(baseModelSets).find(
    ([key, set]) => key === baseModel || set.includes(baseModel as any)
  )?.[1];
