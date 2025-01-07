import z from 'zod';
import { infiniteQuerySchema } from '~/server/schema/base.schema';

export const featureStatusArray = [
  'generation',
  'image-generation',
  'image-training',
  'video-generation',
] as const;
export type FeatureStatusLiteral = (typeof featureStatusArray)[number];

export type CreateFeatureStatusSchema = z.infer<typeof createFeatureStatusSchema>;
export const createFeatureStatusSchema = z
  .object({
    id: z.number().optional(),
    feature: z.string(),
    disabled: z.boolean().optional(),
    message: z.string().nullish(),
  })
  .transform((data) => ({ ...data, message: data.message ? data.message.trim() : null }));

export type GetFeatureStatusPagedSchema = z.infer<typeof getFeatureStatusPagedSchema>;
export const getFeatureStatusPagedSchema = infiniteQuerySchema.extend({ feature: z.string() });
