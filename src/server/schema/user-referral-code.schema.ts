import { z } from 'zod';

export type GetUserReferralCodesSchema = z.infer<typeof getUserReferralCodesSchema>;
export const getUserReferralCodesSchema = z.object({
  userId: z.number().optional(),
  includeCount: z.boolean().optional(),
});

export type UpsertUserReferralCodesSchema = z.infer<typeof upsertUserReferralCodesSchema>;
export const upsertUserReferralCodesSchema = z.object({
  id: z.number().optional(),
  userId: z.number().optional(),
  code: z.string().optional(),
  note: z.string().optional(),
});
