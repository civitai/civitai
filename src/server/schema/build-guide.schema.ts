import { z } from 'zod';

export type BuildBudget = keyof typeof BuildBudget;
export const BuildBudget = {
  Low: 'Low',
  Mid: 'Mid',
  High: 'High',
  Extreme: 'Extreme',
} as const;

export type GetBuildGuideByBudgetSchema = z.infer<typeof getBuildGuideByBudgetInputSchema>;
export const getBuildGuideByBudgetInputSchema = z.object({
  budget: z.nativeEnum(BuildBudget),
  processor: z.string().optional(),
});

export type BuildComponent = z.infer<typeof BuildComponentSchema>;
export const BuildComponentSchema = z.object({
  productId: z.string().trim().min(1),
  name: z.string().trim().min(1),
  price: z.number(),
  imageUrl: z.string().url(),
  type: z.string(),
  brand: z.string(),
  link: z.string().url(),
  isAddon: z.boolean().optional(),
});

export type BuildCapability = z.infer<typeof BuildCapabilitySchema>;
export const BuildCapabilitySchema = z.object({
  speed: z.number().min(0).max(10),
  features: z
    .array(
      z.object({
        id: z.number(),
        name: z.string().trim(),
      })
    )
    .min(1),
});
