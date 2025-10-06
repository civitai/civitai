import * as z from 'zod';

export type BuildBudget = keyof typeof BuildBudget;
export const BuildBudget = {
  Low: 'Low',
  Mid: 'Mid',
  High: 'High',
  Extreme: 'Extreme',
} as const;

export type BuildComponent = z.infer<typeof BuildComponentSchema>;
export const BuildComponentSchema = z.object({
  productId: z.string().trim().min(1),
  name: z.string().trim().min(1),
  price: z.number(),
  imageUrl: z.url(),
  type: z.string(),
  brand: z.string(),
  link: z.url(),
  isAddon: z.boolean().optional(),
});

export const BuildFeatures = {
  ImageGen: 'Image Gen',
  LoraTraining: 'Lora Training',
  Dreambooth: 'Dreambooth',
} as const;
export type BuildFeatures = keyof typeof BuildFeatures;
export type BuildCapability = z.infer<typeof BuildCapabilitySchema>;
export const BuildCapabilitySchema = z.object({
  speed: z.number().min(0).max(10),
  features: z.array(z.enum(BuildFeatures)).min(1),
});
