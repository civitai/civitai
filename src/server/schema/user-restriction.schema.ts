import * as z from 'zod';

export const submitRestrictionContextSchema = z.object({
  userRestrictionId: z.number(),
  message: z.string().min(1).max(1000),
});
export type SubmitRestrictionContextInput = z.infer<typeof submitRestrictionContextSchema>;

export const addToAllowlistSchema = z.object({
  trigger: z.string().min(1),
  category: z.string().min(1),
  reason: z.string().max(500).optional(),
  userRestrictionId: z.number().optional(),
});
export type AddToAllowlistInput = z.infer<typeof addToAllowlistSchema>;

export const debugAuditPromptSchema = z.object({
  prompt: z.string().min(1).max(10000),
  negativePrompt: z.string().max(10000).optional(),
});
export type DebugAuditPromptInput = z.infer<typeof debugAuditPromptSchema>;

export const backfillRestrictionTriggersSchema = z.object({
  userRestrictionId: z.number().optional(),
  limit: z.number().min(1).max(100).default(10),
  force: z.boolean().default(false),
});
export type BackfillRestrictionTriggersInput = z.infer<typeof backfillRestrictionTriggersSchema>;
