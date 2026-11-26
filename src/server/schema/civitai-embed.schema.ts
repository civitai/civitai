import * as z from 'zod';
import { CIVITAI_EMBED_MAX_PER_TYPE } from '~/shared/tiptap/civitai-embed.utils';

const embedIds = z
  .array(z.number().int().positive())
  .max(CIVITAI_EMBED_MAX_PER_TYPE)
  .default([])
  .transform((ids) => [...new Set(ids)]);

export const getEmbedAvailabilitySchema = z.object({
  modelIds: embedIds,
  imageIds: embedIds,
  browsingLevel: z.number().int().nonnegative().optional(),
});
export type GetEmbedAvailabilityInput = z.output<typeof getEmbedAvailabilitySchema>;
