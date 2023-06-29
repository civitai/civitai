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
    // TODO.generation - allow setting of individual props
    const parsed = parseGenerationData(data);
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
  const { height = 0, width = 0, seed = -1, ...rest } = params;
  // TODO.generation - grab the closest image dimensions based on aspect ratio
  const aspectRatio = supportedAspectRatios.some((x) => x.width === width && x.height === height)
    ? `${width}x${height}`
    : '512x512';

  return {
    ...removeEmpty({
      ...rest,
      aspectRatio,
    }),
    seed: seed > -1 ? seed : null,
  };
};

export const supportedAspectRatios = [
  { label: 'Square', width: 512, height: 512 },
  { label: 'Landscape', width: 768, height: 512 },
  { label: 'Portrait', width: 512, height: 768 },
];
