import { z } from 'zod';
import {
  generationParamsSchema,
  generationResourceSchema,
} from '~/server/schema/generation.schema';
import { GetGenerationDataProps } from '~/server/services/generation/generation.service';
import { Generation } from '~/server/services/generation/generation.types';
import { removeEmpty } from '~/utils/object-helpers';
const GENERATION_FORM_KEY = 'generation-form';
export const imageGenerationFormStorage = {
  set: (data: GetGenerationDataProps) => {
    console.log({ data });
    const parsed = parseGenerationData(data);
    console.log({ parsed });
    if (!parsed) return;
    localStorage.setItem(GENERATION_FORM_KEY, JSON.stringify(data));
  },
  get: () => {
    try {
      const localValue = localStorage.getItem(GENERATION_FORM_KEY);
      return localValue ? parseGenerationData(JSON.parse(localValue)) : undefined;
    } catch (e) {}
  },
};

const formatGenerationDataSchema = z.object({
  resources: generationResourceSchema.array().default([]),
  params: generationParamsSchema
    .extend({
      height: z.number(),
      width: z.number(),
      seed: z.number().optional(),
      prompt: z.string().optional(),
    })
    .partial()
    .optional(),
});

export const parseGenerationData = (data: unknown) => {
  try {
    const result = formatGenerationDataSchema.parse(data);
    return result;
  } catch (error: any) {
    console.warn('invalid generation data format');
    console.warn({ error });
  }
};

export const formatGenerationFormData = (params: Partial<Generation.Params> | undefined = {}) => {
  const aspectRatio =
    params.width && params.height ? `${params.width}x${params.height}` : `512x512`;
  const seed = params?.seed ?? -1;

  const { height, width, ...rest } = params;

  return removeEmpty({
    ...rest,
    aspectRatio,
    seed: seed > -1 ? seed : undefined,
  });
};
