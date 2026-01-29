import * as z from 'zod';
import { paginationSchema } from '~/server/schema/base.schema';
import { UserRestrictionStatus } from '~/shared/utils/prisma/enums';

export const submitRestrictionContextSchema = z.object({
  userRestrictionId: z.number(),
  message: z.string().min(1).max(1000),
});
export type SubmitRestrictionContextInput = z.infer<typeof submitRestrictionContextSchema>;

export const getGenerationRestrictionsSchema = paginationSchema.extend({
  status: z
    .enum([
      UserRestrictionStatus.Pending,
      UserRestrictionStatus.Upheld,
      UserRestrictionStatus.Overturned,
    ])
    .optional(),
  username: z.string().optional(),
  userId: z.number().optional(),
});
export type GetGenerationRestrictionsInput = z.infer<typeof getGenerationRestrictionsSchema>;

export const resolveRestrictionSchema = z.object({
  userRestrictionId: z.number(),
  status: z.enum([UserRestrictionStatus.Upheld, UserRestrictionStatus.Overturned]),
  resolvedMessage: z.string().max(1000).optional(),
});
export type ResolveRestrictionInput = z.infer<typeof resolveRestrictionSchema>;

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

export const saveSuspiciousMatchSchema = z.object({
  matches: z.array(
    z.object({
      odometer: z.number(),
      userId: z.number(),
      prompt: z.string(),
      negativePrompt: z.string().optional(),
      check: z.string(),
      matchedText: z.string(),
      regex: z.string().optional(),
      context: z.string().optional(),
    })
  ),
});
export type SaveSuspiciousMatchInput = z.infer<typeof saveSuspiciousMatchSchema>;

export const backfillRestrictionTriggersSchema = z.object({
  userRestrictionId: z.number().optional(),
  limit: z.number().min(1).max(100).default(10),
  force: z.boolean().default(false),
});
export type BackfillRestrictionTriggersInput = z.infer<typeof backfillRestrictionTriggersSchema>;
