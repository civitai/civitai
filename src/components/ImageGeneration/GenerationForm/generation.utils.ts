import { generation } from '~/server/common/constants';
import { z } from 'zod';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import useIsClient from '~/hooks/useIsClient';
import { useMemo } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

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
  return useMemo(() => {
    const data = isClient ? parseData(useGenerationFormStore.getState()) : {};
    return {
      nsfw: currentUser?.showNsfw ?? false,
      ...generation.defaultValues,
      ...data,
    };
  }, [isClient, currentUser]);
};

export const useTempGenerateStore = create<{
  baseModel?: string;
  hasResources?: boolean;
}>(() => ({}));
