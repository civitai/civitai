import { z } from 'zod';

export type GetUserReferralCodesSchema = z.infer<typeof getUserReferralCodesSchema>;
export const getUserReferralCodesSchema = z.object({
  includeCount: z.boolean().optional(),
});

export type UpsertUserReferralCodesSchema = z.infer<typeof upsertUserReferralCodesSchema>;
export const upsertUserReferralCodesSchema = z
  .object({
    id: z.number().optional(),
    code: z.string().optional(),
    note: z.string().optional(),
  })
  .optional();
