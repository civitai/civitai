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
