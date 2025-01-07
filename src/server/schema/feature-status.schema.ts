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
export const createFeatureStatusSchema = z.object({
  feature: z.enum(featureStatusArray),
  disabled: z.boolean().optional(),
  message: z.string().optional(),
});

export type ResolveFeatureStatusSchema = z.infer<typeof resolveFeatureStatusSchema>;
export const resolveFeatureStatusSchema = z.object({
  id: z.number(),
  resolved: z.boolean(),
});

export type GetFeatureStatusPagedSchema = z.infer<typeof getFeatureStatusPagedSchema>;
export const getFeatureStatusPagedSchema = infiniteQuerySchema.extend({ feature: z.string() });
