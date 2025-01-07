import z from 'zod';
import { infiniteQuerySchema } from '~/server/schema/base.schema';

export type CreateFeatureStatusSchema = z.infer<typeof createFeatureStatusSchema>;
export const createFeatureStatusSchema = z.object({
  feature: z.string(),
  disabled: z.boolean().optional(),
  message: z.string().optional(),
});

export type ResolveFeatureStatusSchema = z.infer<typeof resolveFeatureStatusSchema>;
export const resolveFeatureStatusSchema = z.object({
  id: z.number(),
  resolved: z.boolean(),
});

export type GetFeatureStatusSchema = z.infer<typeof getFeatureStatusSchema>;
export const getFeatureStatusSchema = z
  .object({ feature: z.union([z.string(), z.string().array()]) })
  .transform(({ feature, ...rest }) => ({
    feature: Array.isArray(feature) ? feature : [feature],
    ...rest,
  }));

export type GetFeatureStatusPagedSchema = z.infer<typeof getFeatureStatusPagedSchema>;
export const getFeatureStatusPagedSchema = infiniteQuerySchema.extend({ feature: z.string() });
